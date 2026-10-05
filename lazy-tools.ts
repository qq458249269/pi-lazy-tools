/**
 * Lazy Tools Extension — omnify 单入口
 *
 * 把配置的低频工具保留注册但移出 LLM 可见的 active 集；唯常驻入口 `omnify`
 * 一步完成：搜索候选 → 返回参数要求（schema-first, 无 args 时）→ 校验调用
 * （有 args 时）。未匹配则返回全部工具名录 + 技能命中（SKILL.md 路径），
 * 并建议退回 bash/read/编辑 等常规手段。
 *
 * 常驻名单（不 lazy）来自 pi 自己的 `settings.json` 的 `defaultTools` 字段：
 *   User:    ~/.pi/agent/settings.json
 *   Project: <cwd>/.pi/settings.json（需项目受信任才生效，与 pi 自身规则一致）
 * 两处都没有该字段时，取 pi 内置默认（read, bash, edit, write）；
 * 显式写 `"defaultTools": []` 即全部 lazy。
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { createJiti } from "jiti";
import { homedir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import {
	resolveDefaultTools,
	validateParams,
	buildStartupNotice,
	rankToolMatches,
	nonLoadableSourceReason,
	PI_BUILTIN_DEFAULT_TOOLS,
	type DefaultToolsCandidate,
} from "./lazy-tools/core.ts";

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const jiti = createJiti(import.meta.url);

const OMNIFY_NAME = "omnify";

/** 内建工具执行不了时的统一提示（挂在失败文案尾部）。 */
const BUILTIN_ONLY_HINT =
	"\n提示：omnify 只能执行扩展注册的工具；内建工具（read/bash/edit/write/ls/powershell/grep）"
	+ "请直接用常驻工具调用。";


/** pi 的 agent 目录（settings.json 所在处）；pi 以 PI_CODING_AGENT_DIR 覆盖。 */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const CONFIG_DIR = ".pi";
const SETTINGS_FILE = "settings.json";
/** 旧版本扩展自有的配置文件：已被 settings.json 的 defaultTools 取代，仅用于迁移告警。 */
const LEGACY_CONFIG_FILE = "lazy-tools.json";

interface SkillMeta {
	name: string;
	description: string;
	filePath: string;
}

/** 技与懒工具皆不内联，由 omnify 检索；skill 命中的动作是 read 其 SKILL.md。 */
const SKILLS_NOTE = "技能清单不列于此。需用时以 omnify 检索，按其命中结果 read 对应 SKILL.md。";

/**
 * rules/docs 压缩版（削减首请求 token）。原文由 pi 生成，冗余长句多；
 * 此处保留全部语义要点，仅去解释性赘述。若需完整原文，删此二常量即可。
 * 注意：pi 会自行给 section 内容包 `<rules>`/`</rules>` 标签，故此处放裸文本，勿自带标签（否则双嵌套）。
 */
const RULES_NOTE =
	"- 文件操作用 bash (ls, rg, fd)；读文件用 read。\n" +
	"- 查文件/目录一律优先 fd（omnify 检索或直接调 fd 工具）；禁用 find（会假死，已被 no-find 拦）。\n" +
	"- 精改用 edit：edits[].oldText 与原文精确匹配且唯一；同文件多处修改合并为一次调用；text 重复处加 anchor 定位；改名用 replaceAll:true。\n" +
	"- 新文件/整体重写用 write。\n" +
	"- 可查 PI_* 环境变量取模型与会话信息。\n" +
	"- 响应精简；路径/命令/报错原文保留。安全警告、不可逆操作、多步有序流程用完整清晰语气。按用户语言作答。";

// [fix-lazy-tools-notes] 路径由 pi 安装目录实测填入（where pi.exe / node_modules）：D:\agent\pi
const DOCS_NOTE =
	"PI 文档（仅当用户问及 pi 自身/SDK/扩展/主题/技能/TUI 时读取）：D:\\agent\\pi\\README.md；副档 D:\\agent\\pi\\docs 与 D:\\agent\\pi\\examples（按 README 索引解析相对路径）。读 pi 相关 md 须全文读完并循内部链接。";

/** pi 的 agent 目录：`PI_CODING_AGENT_DIR` 优先，否则 `~/.pi/agent`。 */
function getAgentDir(): string {
	const fromEnv = process.env[AGENT_DIR_ENV];
	if (fromEnv && fromEnv.length > 0) {
		return join(fromEnv.startsWith("~") ? homedir() + fromEnv.slice(1) : fromEnv);
	}
	return join(homedir(), CONFIG_DIR, "agent");
}

/** 读一个 JSON 对象文件；缺失/解析失败/非对象一律返回 null（仅告警）。 */
function readJsonObject(path: string): Record<string, unknown> | null {
	try {
		const text = fs.readFileSync(path, "utf-8");
		const parsed = JSON.parse(text) as unknown;
		if (isObject(parsed)) return parsed;
		console.warn(`[lazy-tools] ignoring non-object JSON at ${path}`);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[lazy-tools] failed to read ${path}: ${message}`);
		}
	}
	return null;
}

/**
 * 旧 `lazy-tools.json` 若还在，提醒用户把 resident 迁到 settings.json 的
 * defaultTools（只告警不改文件，也不影响名单计算）。每进程只提醒一次，
 * 免得 resume/fork/reload 反复刷屏。
 */
let legacyWarned = false;
function warnLegacyConfigs(paths: readonly string[]): void {
	if (legacyWarned) return;
	for (const path of paths) {
		if (fs.existsSync(path)) {
			console.warn(
				`[lazy-tools] ${path} 已不再读取：常驻名单改由 pi settings.json 的 defaultTools 决定，` +
					`请把其中的 resident 数组原样搬进该字段。`,
			);
			legacyWarned = true;
		}
	}
}

const definitionCache = new Map<string, ToolDefinition>();

/**
 * Build a fake ExtensionAPI used to re-run a target extension's factory so we
 * can capture its ToolDefinition(s) without actually registering them in pi.
 * Registration methods are stubbed; setActiveTools is no-op'd; everything else
 * is delegated to the real pi so that the captured tool's execute() can use
 * pi.appendEntry, pi.exec, pi.events, etc.
 */
function createFakePi(realPi: ExtensionAPI, captured: ToolDefinition[]): ExtensionAPI {
	const fake = { ...realPi } as Record<string, unknown>;

	fake.registerTool = (tool: ToolDefinition) => {
		captured.push(tool);
	};
	fake.registerCommand = () => {};
	fake.registerShortcut = () => {};
	fake.registerFlag = () => {};
	fake.on = () => {};
	fake.registerMessageRenderer = () => {};
	fake.registerMarkdownTransformer = () => {};
	fake.registerEntryRenderer = () => {};
	fake.registerProvider = () => {};
	fake.unregisterProvider = () => {};
	fake.setActiveTools = () => {};

	const realEvents = isObject(realPi.events) ? realPi.events : {};
	fake.events = {
		...realEvents,
		on: () => {},
	};

	return fake as unknown as ExtensionAPI;
}

/**
 * Re-run the source extension module to capture the ToolDefinition for a given
 * tool name. Successful lookups are memoized by (sourcePath, name); failures
 * are not cached and may be retried.
 */
async function findToolDefinition(sourcePath: string, name: string, realPi: ExtensionAPI): Promise<ToolDefinition | undefined> {
	const cacheKey = `${sourcePath}#${name}`;
	const cached = definitionCache.get(cacheKey);
	if (cached) return cached;

	try {
		const mod = await jiti.import<{ default?: unknown }>(sourcePath.replaceAll("\\", "/"), { default: true });
		const factory = mod?.default ?? mod;
		if (typeof factory !== "function") {
			return undefined;
		}

		const captured: ToolDefinition[] = [];
		const fakePi = createFakePi(realPi, captured);
		const maybePromise = factory(fakePi) as unknown;
		if (maybePromise && typeof (maybePromise as PromiseLike<unknown>).then === "function") {
			await (maybePromise as PromiseLike<unknown>);
		}

		const definition = captured.find((tool) => tool.name === name);
		if (definition) {
			definitionCache.set(cacheKey, definition);
		}
		return definition;
	} catch (err) {
		console.error(`[lazy-tools] failed to load tool definition for "${name}" from ${sourcePath}:`, err);
		return undefined;
	}
}

const OmnifyParams = Type.Object({
	goal: Type.String({ description: "目标自然语言描述。" }),
	args: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "目标工具参数；缺省即 schema-first。",
		}),
	),
	tool: Type.Optional(
		Type.String({
			description: "显式工具名，跳过搜索。",
		}),
	),
});

type OmnifyParams = Static<typeof OmnifyParams>;

/**
 * Schema 摘要（schema-first 用）：字段 + 类型/枚举 + 必填性，省略其余细节。
 * 完整 schema 只出现在失败明细里（两级披露：摘要够补参，精确值失败统底）。
 */
function summarizeSchema(schema: unknown): string {
	const s = isObject(schema) ? schema : {};
	const props = isObject(s.properties) ? (s.properties as Record<string, unknown>) : {};
	const required = Array.isArray(s.required) ? (s.required as string[]) : [];
	const parts = Object.entries(props).map(([key, sub]) => {
		const subObj = isObject(sub) ? sub : {};
		let type = typeof subObj.type === "string" ? (subObj.type as string) : "?";
		if (Array.isArray(subObj.enum)) type += `[${(subObj.enum as unknown[]).join("|")}]`;
		return `${key}:${type}${required.includes(key) ? "!" : "?"}`;
	});
	if (parts.length === 0) {
		if (s.type === "array" && isObject(s.items)) {
			const itemsType =
				isObject(s.items) && typeof (s.items as Record<string, unknown>).type === "string"
					? ((s.items as Record<string, unknown>).type as string)
					: "any";
			return `array<${itemsType}>`;
		}
		return (typeof s.type === "string" ? s.type : "any") as string;
	}
	return `{ ${parts.join(", ")} }`;
}

/** 目标与技能清单的粗略匹配（skill 不是工具：仅返路径，不动手执行）。 */
function matchSkills(goal: string, skills: SkillMeta[]): SkillMeta[] {
	const q = goal.toLowerCase().trim();
	if (!q) return [];
	const words = q.split(/\W+/).filter((w) => w.length >= 2);
	return skills.filter((s) => {
		const hay = `${s.name} ${s.description}`.toLowerCase();
		if (hay.includes(q)) return true;
		return words.some((w) => hay.includes(w));
	});
}

export default function (pi: ExtensionAPI) {
	let lazyNames: string[] = [];
	let lazySet = new Set<string>();
	// session_start 后真正生效的 active 集（pi.getActiveTools() 在部分运行时/测试桩里
	// 不反映 setActiveTools 的结果，故以本扩展算出的落地集为准）。
	let activeAfterSetup = new Set<string>();
	// 本扩展主动塞回 active 集的工具（defaultTools: [] 时的内建基线）。启用它们会让
	// pi 把其 promptSnippet/promptGuidelines 并进系统提示词；before_agent_start 里须
	// 把这批工具的 prompt 元数据剔除，否则「启用工具」本身就在动缓存前缀。
	let forcedResidentNames: string[] = [];
	let skills: SkillMeta[] = [];
	// session 级：schema-first 摘要按工具缓存；成功执行过的工具不再重复展示摘要
	const summaryCache = new Map<string, string>();
	const usedTools = new Set<string>();

	const renderToolSpec = (name: string, description: string, schema: object): string =>
		`- ${name}
  用途：${description}
  参数：${summarizeSchema(schema)}`;

	const renderSkillHits = (goal: string): string => {
		if (goal.trim().length === 0) return "";
		const hits = matchSkills(goal, skills);
		if (hits.length === 0) return "";
		return (
			"\n\n匹配到的技能（skill 非工具：请 read 其 SKILL.md 取用法）：\n" +
			hits.map((s) => `- ${s.name}: ${s.description}（${s.filePath}）`).join("\n")
		);
	};

	// 全能入口：四合一。搜索→(schema-first 返参数摘要 | 校验执行)，未及则名录+技能。
	pi.registerTool({
		name: OMNIFY_NAME,
		label: "Omnify",
		description: "按 goal 搜并调 lazy 工具/技能：无 args 返候选参数要求；有 args 校验执行；未匹配返名录与技能路径。tool 指名跳过搜索。",
		promptSnippet: "想完成某事而不知用何工具/技能时，先试 omnify。",
		promptGuidelines: [
			"无 args：返候选参数要求，补 args 重试。",
			"失败：按明细补参/指名重试，或退常规手段。",
"内建工具（read/bash/edit/write/ls/powershell/grep）不经 omnify，直接调用。",
		],
		parameters: OmnifyParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const explicit = typeof params.tool === "string" && params.tool.length > 0;
			const hasArgs = params.args !== undefined;
			const allTools = pi
				.getAllTools()
				.filter((t) => typeof t.name === "string" && typeof t.description === "string");
			const toolMap = new Map(allTools.map((t) => [t.name, t]));
			// omnify 只能代理执行扩展工具（findToolDefinition 重放源码）。pi 内建/sdk 工具的
			// sourceInfo 是 <builtin:name>/<sdk:name> 合成标记，没有可 import 的源码：它们
			// 若进入候选，模型就会拿到一个永远失败的调用（旧实现反而回「按参数要求补参重试」，
			// 把模型往错方向带）。这里把它们从搜索池与名录里彻底剔除——它们不经 omnify，
			// 模型直接调用即可（session_start 也不会把它们放进 lazy 名单）。
			const omnifiable = allTools.filter((t) => nonLoadableSourceReason(t) === null);

			// 显式指名内建工具：不返参数摘要，也不试跑，直接说清并引导原生调用。
			if (explicit) {
				const named = toolMap.get(params.tool as string);
				if (named && named.name !== OMNIFY_NAME && nonLoadableSourceReason(named) !== null) {
					const name = params.tool as string;
					// 内建工具本不在搜索池（模型本就能直接调），走到这里多半是它没启用。
					const isActive = activeAfterSetup.has(name);
					const text = isActive
						? `"${name}" 是内建工具，omnify 不能代理执行（无可重放源码）；请直接调用 ${name}。`
						: `"${name}" 是内建工具且当前未启用，omnify 也无法代理执行。若确实需要，请把 "${name}" 加入 settings.json 的 defaultTools 并重开会话。`;
					return {
						content: [{ type: "text", text }],
						details: { ok: false, phase: "builtin", matched: [] },
					};
				}
			}

			const candidates = explicit
				? [params.tool as string]
				: rankToolMatches(params.goal, omnifiable).slice(0, 5);
			// omnify 自身不入候选（防自调）。
			const matched = candidates.filter((name) => toolMap.has(name) && name !== OMNIFY_NAME);

			// a. 零匹配：扩展工具名录 + 技能命中，引导指名或退常规。
			if (matched.length === 0) {
				const roster = omnifiable
					.filter((t) => t.name !== OMNIFY_NAME)
					.map((t) => `- ${t.name}: ${t.description}`)
					.join("\n");
				// 内建工具不在名录里（模型本就看得见、直接可用），故可能一个扩展工具都没有。
				const rosterSection =
					roster.length > 0
						? `可经 omnify 调用的扩展工具：\n${roster}`
						: "当前没有可经 omnify 调用的扩展工具（内建工具不经 omnify，请直接调用）。";
				const text =
					`未找到与目标相关之工具/技能。${rosterSection}${renderSkillHits(params.goal)}\n` +
					(explicit
						? `工具 "${params.tool}" 不存在。`
						: "请直接使用常驻工具（bash/read/编辑等）完成，或以 tool 参数指名扩展工具补 args 重试。");
				return {
					content: [{ type: "text", text }],
					details: { ok: false, matched: [], reasons: [] },
				};
			}

			// b. 无 args：schema-first。返候选参数要求，供模型补参重试（零执行副作用）。
			// 已成功执行过的工具只给占位（参数要求前已给出），不重复输出 description+摘要。
			if (!hasArgs) {
				const need = matched
					.map((name) => {
						const t = toolMap.get(name)!;
						if (usedTools.has(name)) {
							return `- ${name}：本会话已成功调用过，参数要求同前；直接补 args 重试。`;
						}
						let text = summaryCache.get(name);
						if (text === undefined) {
							text = renderToolSpec(name, t.description, t.parameters as object);
							summaryCache.set(name, text);
						}
						return text;
					})
					.join("\n");
				return {
					content: [
						{
							type: "text",
							text: `匹配到候选工具，请按其参数要求补 args 后重试：\n${need}${renderSkillHits(params.goal)}`,
						},
					],
					details: { ok: false, phase: "need-args", matched },
				};
			}

			// c. 有 args：逐候选校验并试调，成功即返。
			const reasons: string[] = [];
			let sawNonLoadable = false;
			for (const name of matched) {
				const info = toolMap.get(name)!;
				// 过了参数校验 = 该候选就是最佳匹配，它一失败就最终失败（见 catch 里的 break）。
				let validated = false;
				try {
					const validation = validateParams(info.parameters, params.args);
					if (!validation.ok) {
						reasons.push(
							`- ${name}: 参数不符（${validation.errors.join("; ")}）\n  参数要求：${JSON.stringify(info.parameters)}`,
						);
						// 指名场景：即返该工具要求，勿代为猜试其他工具。
						if (explicit) break;
						continue;
					}
					validated = true;

					// 内建工具没有可 import 的源码（合成 sourceInfo）：说清原因并停下。
					const notLoadable = nonLoadableSourceReason(info);
					if (notLoadable) {
						sawNonLoadable = true;
						reasons.push(`- ${name}: ${notLoadable}`);
						break;
					}

					const sourcePath = info.sourceInfo?.path;
					if (!sourcePath) throw new Error("缺少来源路径");
					const definition = await findToolDefinition(sourcePath, name, pi);
					if (!definition) throw new Error("执行定义加载失败");

					const result = await definition.execute(
						toolCallId,
						params.args as never,
						signal,
						onUpdate,
						ctx,
					);
					usedTools.add(name);
					return {
						content: result.content,
						details: { ok: true, tool: name, ...(result?.details ?? {}) },
					};
				} catch (err) {
					reasons.push(`- ${name}: ${err instanceof Error ? err.message : String(err)}`);
					// 关键修复：候选一旦过了参数校验并开始执行，它就是最佳匹配，失败即最终失败。
					// 旧实现无条件 continue 到下一个候选 → 会「静默执行错工具并冒充成功」：
					// schema 宽松的工具（如 mcp 的 Record<string,unknown>）照单全收，然后返回
					// 「MCP: 0/0 servers, 0 tools」这种看着正常的空结果。
					if (explicit || validated) break;
				}
			}

			const text = [
				`omnify 尝试 ${matched.length} 个候选工具均未成功：`,
				...reasons,
				sawNonLoadable
					? BUILTIN_ONLY_HINT.trim()
					: explicit
						? "请按上方参数要求补参重试，或以常规手段完成。"
						: "请以常规手段（bash/read/编辑）完成，或以 tool 参数显式指名工具重试。",
			].join("\n");
			return {
				content: [{ type: "text", text: text + renderSkillHits(params.goal) }],
				details: { ok: false, matched, reasons },
			};
		},
	});

	// pi 0.84.x 无 sections 字段：须回传整串 systemPrompt 方能生效（每轮均触发）。
	pi.on("before_agent_start", (event) => {
		skills = event.systemPromptOptions.skills ?? [];
		const { sections, toolSnippets, toolGuidelines } = event.systemPromptOptions;
		// 先剥掉 forcedResident 工具自身的 prompt 元数据（pi 0.86+ 会据 options 重建 sections，
		// 改动由此生效）。工具仍在 tools 字段里可调用，但其自述（snippet/guidelines）绝不进入
		// 系统提示词——前缀与「本扩展是否补启了它」无关，杜绝启用动作经工具自身改写缓存前缀。
		for (const name of forcedResidentNames) {
			delete toolSnippets[name];
			delete toolGuidelines[name];
		}
		if (sections) {
			// 0.86+：只改 section，pi 仅在内容变化时记 transcript delta，轮间字节稳定（前缀缓存不散）
			if (skills.length > 0) sections.skills = SKILLS_NOTE;
			// 压缩 rules/docs 以削减首请求 token；skills 空时仍压缩（与 skills 无关）
			sections.rules = RULES_NOTE;
			sections.docs = DOCS_NOTE;
			return;
		}
		if (skills.length === 0) return;
		// 0.86 前无 sections：正则剥离后整串回传（强制路径）
		const stripped = event.systemPrompt.replace(
			/\n\nThe following skills provide specialized instructions[\s\S]*?<\/available_skills>/,
			"",
		);
		return { systemPrompt: `${stripped}\n\n${SKILLS_NOTE}` };
	});

	pi.on("session_start", async (event, ctx) => {
		try {
			const cwd = ctx.cwd ?? process.cwd();
			// 与 pi 自身一致：项目未受信任时忽略项目级 settings.json。
			const projectTrusted = ctx.isProjectTrusted?.() ?? true;
			const userSettingsPath = join(getAgentDir(), SETTINGS_FILE);
			const projectSettingsPath = join(cwd, CONFIG_DIR, SETTINGS_FILE);
			warnLegacyConfigs([
				join(homedir(), CONFIG_DIR, LEGACY_CONFIG_FILE),
				join(cwd, CONFIG_DIR, LEGACY_CONFIG_FILE),
			]);
			const userSettings = readJsonObject(userSettingsPath);
			const projectSettings = projectTrusted ? readJsonObject(projectSettingsPath) : null;
			// 项目级覆盖用户级（与 pi 的 settings 合并规则相同：数组整体替换）；
			// 两处都无 defaultTools 时取 pi 内置默认。
			const candidates: DefaultToolsCandidate[] = [
				{ path: projectSettingsPath, defaultTools: projectSettings?.defaultTools },
				{ path: userSettingsPath, defaultTools: userSettings?.defaultTools },
			];
			const resolved = resolveDefaultTools(candidates);

			// omnify 是常驻入口，不经 settings.json：这里无条件把它写进 active 集。
			// 但它必须先在注册表里（-t/--tools 会把未列名工具移出注册表），
			// 否则本会话若照常隐藏其余工具就没有取用入口——此时不懒加载，只告警。
			const allTools = pi.getAllTools();
			const allToolNames = allTools.map((tool) => tool.name);
			if (!allToolNames.includes(OMNIFY_NAME)) {
				lazyNames = [];
				lazySet = new Set();
				forcedResidentNames = [];
				const message =
					`[lazy-tools] ${OMNIFY_NAME} 不在工具注册表（启动参数裁剪了搜索池），` +
					`本会话不做懒加载。裸 pi.exe 启动即可恢复。`;
				console.warn(message);
				if (event?.reason === "startup") {
					try {
						ctx?.ui?.notify?.(message, "warning");
					} catch {
						// 提示失败不影响会话
					}
				}
				return;
			}

			// omnify 只能代理扩展工具（重放源码）；内建/sdk 工具没有可 import 的源码，调不动。
			// 记下这批工具：它们绝不进 lazy 名单（active 的原样保留，inactive 的不强拉）。
			const nonOmnifiable = new Set(
				allTools
					.filter((tool) => tool.name !== OMNIFY_NAME && nonLoadableSourceReason(tool) !== null)
					.map((tool) => tool.name),
			);
			// defaultTools: [] 会让 pi 首轮一个工具都不激活；若照单全收，read/bash/edit/write
			// 既不在场上、omnify 又代理不了，会话直接不可用。故空名单按「扩展工具全 lazy，
			// pi 内建基线仍常驻」解释。非空名单完全尊重用户配置，不擅自增补。
			const baselineFallback =
				resolved.resident.length === 0
					? PI_BUILTIN_DEFAULT_TOOLS.filter(
							(name) => allToolNames.includes(name) && nonOmnifiable.has(name),
						)
					: [];
			const forcedResident = baselineFallback;
			forcedResidentNames = forcedResident;
			const resident = new Set([
				OMNIFY_NAME,
				...resolved.resident,
				...baselineFallback,
				...nonOmnifiable,
			]);
			lazyNames = allToolNames.filter((name) => !resident.has(name));
			lazySet = new Set(lazyNames);
			definitionCache.clear();
			summaryCache.clear();
			usedTools.clear();
			const notice = buildStartupNotice({
				toolNames: lazyNames,
				resident: resolved.resident,
				forcedResident,
				sourcePath: resolved.path,
				userSettingsPath,
				projectSettingsPath,
			});

			const active = pi.getActiveTools();
			const filtered = active.filter((toolName) => !lazySet.has(toolName));
			// forcedResident 要显式补回 active 集：defaultTools: [] 时 pi 首轮一个内建
			// 工具都没激活，光「不隐藏」不够，还得把基线内建加回来。
			const initial = [...new Set([...filtered, OMNIFY_NAME, ...forcedResident])];
			pi.setActiveTools(initial);
			activeAfterSetup = new Set(initial);

			if (event?.reason === "startup") {
				try {
					ctx?.ui?.notify?.(notice, "info");
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					console.warn(`[lazy-tools] failed to show startup notice: ${message}`);
				}
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[lazy-tools] session_start handler failed: ${message}`);
		}
	});
}