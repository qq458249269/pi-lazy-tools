/**
 * Lazy Tools Extension — omnify 单入口
 *
 * 把配置的低频工具保留注册但移出 LLM 可见的 active 集；唯常驻入口 `omnify`
 * 一步完成：搜索候选 → 返回参数要求（schema-first, 无 args 时）→ 校验调用
 * （有 args 时）。未匹配则返回全部工具名录 + 技能命中（SKILL.md 路径），
 * 并建议退回 bash/read/编辑 等常规手段。
 *
 * 配置为 resident 例外（不 lazy、留在初始 active 集）：
 *   User:    ~/.pi/lazy-tools.json
 *   Project: <cwd>/.pi/lazy-tools.json
 *   Format:  { "resident": string[] }
 * 无配置则除 omnify 外全量 lazy。
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { createJiti } from "jiti";
import { homedir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import {
	mergeLazyConfigs,
	selectEffectiveConfigPath,
	validateParams,
	buildStartupNotice,
	rankToolMatches,
	type LazyConfig,
} from "./lazy-tools/core.ts";

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const jiti = createJiti(import.meta.url);

const CONFIG_NAME = "lazy-tools.json";
const OMNIFY_NAME = "omnify";

interface SkillMeta {
	name: string;
	description: string;
	filePath: string;
}

/** 技与懒工具皆不内联，由 omnify 检索；skill 命中的动作是 read 其 SKILL.md。 */
const SKILLS_NOTE = "技能清单不列于此。需用时以 omnify 检索，按其命中结果 read 对应 SKILL.md。";

/**
 * Read a single lazy-tools config file. Returns null if the file is missing or
 * malformed; warnings are logged for unexpected errors.
 */
function readConfigFile(path: string): LazyConfig | null {
	try {
		const text = fs.readFileSync(path, "utf-8");
		const parsed = JSON.parse(text) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as LazyConfig;
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[lazy-tools] failed to read config ${path}: ${message}`);
		}
	}
	return null;
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
	let skills: SkillMeta[] = [];

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
		description:
			"按 goal 搜索并调用 lazy 工具/技能：无 args 返候选参数摘要；有 args 校验即执行；未匹配返名录与技能路径。tool 显式指名，避开搜索。",
		promptSnippet: "想完成某事而不知用何工具/技能时，先试 omnify。",
		promptGuidelines: [
			"无 args：返候选参数要求，补 args 重试。",
			"失败：按明细补参/指名重试，或退常规手段。",
		],
		parameters: OmnifyParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const explicit = typeof params.tool === "string" && params.tool.length > 0;
			const hasArgs = params.args !== undefined;
			const allTools = pi
				.getAllTools()
				.filter((t) => typeof t.name === "string" && typeof t.description === "string");
			const toolMap = new Map(allTools.map((t) => [t.name, t]));

			const candidates = explicit
				? [params.tool as string]
				: rankToolMatches(params.goal, allTools).slice(0, 5);
			// omnify 自身不入候选（防自调）。
			const matched = candidates.filter((name) => toolMap.has(name) && name !== OMNIFY_NAME);

			// a. 零匹配：全部工具名录 + 技能命中，引导指名或退常规。
			if (matched.length === 0) {
				const roster = [...toolMap.entries()].map(([n, t]) => `- ${n}: ${t.description}`).join("\n");
				const text =
					`未找到与目标相关之工具/技能。可用工具：\n${roster}${renderSkillHits(params.goal)}\n` +
					(explicit
						? `工具 "${params.tool}" 不存在。`
						: "请以 tool 参数指名其一补 args 重试，或以 bash/read/编辑 等常规手段完成。");
				return {
					content: [{ type: "text", text }],
					details: { ok: false, matched: [], reasons: [] },
				};
			}

			// b. 无 args：schema-first。返候选参数要求，供模型补参重试（零执行副作用）。
			if (!hasArgs) {
				const need = matched
					.map((name) => {
						const t = toolMap.get(name)!;
						return renderToolSpec(name, t.description, t.parameters as object);
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
			for (const name of matched) {
				const info = toolMap.get(name)!;
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
					return {
						content: result.content,
						details: { ok: true, tool: name, ...(result?.details ?? {}) },
					};
				} catch (err) {
					reasons.push(`- ${name}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			const text = [
				`omnify 尝试 ${matched.length} 个候选工具均未成功：`,
				...reasons,
				explicit
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
		if (skills.length === 0) return;
		const { sections } = event.systemPromptOptions;
		if (sections) {
			// 0.86+：只改 section，pi 仅在内容变化时记 transcript delta，轮间字节稳定（前缀缓存不散）
			sections.skills = SKILLS_NOTE;
			return;
		}
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
			const userConfigPath = join(homedir(), ".pi", CONFIG_NAME);
			const projectConfigPath = join(cwd, ".pi", CONFIG_NAME);
			const userConfig = readConfigFile(userConfigPath);
			const projectConfig = readConfigFile(projectConfigPath);
			const effectiveConfigPath = selectEffectiveConfigPath(
				userConfig,
				projectConfig,
				userConfigPath,
				projectConfigPath,
			);
			// 无有效配置 → 例外仅 omnify：全量 lazy；名单为 session_start 时点快照
			const resident = new Set([OMNIFY_NAME]);
			if (effectiveConfigPath !== null) {
				for (const name of mergeLazyConfigs(userConfig, projectConfig).resident) {
					resident.add(name);
				}
			}
			lazyNames = pi
				.getAllTools()
				.map((tool) => tool.name)
				.filter((name) => !resident.has(name));
			lazySet = new Set(lazyNames);
			definitionCache.clear();
			const notice = buildStartupNotice({
				toolNames: lazyNames,
				userConfigPath,
				projectConfigPath,
				effectiveConfigPath,
			});

			const active = pi.getActiveTools();
			const filtered = active.filter((toolName) => !lazySet.has(toolName));
			const initial = [...new Set([...filtered, OMNIFY_NAME])];
			pi.setActiveTools(initial);

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