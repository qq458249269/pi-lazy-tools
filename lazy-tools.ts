/**
 * Lazy Tools Extension
 *
 * Keeps configured tools out of the LLM-visible active set while keeping them
 * registered in the pi runtime. They can be loaded on demand as plain-text
 * instructions via `load_tools` and then invoked through `call_tool`.
 *
 * Configuration is read from two levels, with project config overriding user config.
 *
 *   User:    ~/.pi/lazy-tools.json
 *   Project: <cwd>/.pi/lazy-tools.json
 *   Format:  { "resident": string[] }   # 不 lazy（常驻）的例外；无配置则全量 lazy
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
	filterAllowedTools,
	validateParams,
	canCall,
	buildStartupNotice,
	buildLoadChallenge,
	type LazyConfig,
} from "./lazy-tools/core.ts";

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const jiti = createJiti(import.meta.url);

const CONFIG_NAME = "lazy-tools.json";
const LOADER_NAME = "load_tools";
const CALLER_NAME = "call_tool";
const SKILL_SEARCH_NAME = "skill_search";

interface SkillMeta {
	name: string;
	description: string;
	filePath: string;
}

/** 技不内联于系统提示，改由 skill_search 检索。 */
const SKILLS_NOTE = "技能清单不列于此。唯用户明请用技时，调 skill_search 检索，再读所返 SKILL.md。";

interface ConfigReadResult {
	requested: string[];
	accepted: string[];
	rejected: string[];
	confirmRequired?: boolean;
}

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
 * tool name. Successful lookups are memoized by (sourcePath, name) so the
 * target extension factory is only replayed once per tool; failures are not
 * cached and may be retried.
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

const LoadToolsParams = Type.Object({
	tools: Type.Array(Type.String(), {
		description: "待载入之 lazy 工具名。",
	}),
	confirm: Type.Optional(Type.Boolean({
		description: "true 方载入；缺省只返挑战，不载入。",
	})),
});

type LoadToolsParams = Static<typeof LoadToolsParams>;

const CallToolParams = Type.Object({
	tool: Type.String({ description: "目标 lazy 工具名。" }),
	params: Type.Record(Type.String(), Type.Unknown(), {
		description: "透传目标工具之参数。",
	}),
});

type CallToolParams = Static<typeof CallToolParams>;

function buildLoadResult(requested: string[], accepted: string[], rejected: string[], pi: ExtensionAPI): string {
	const allTools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	const lines: string[] = [];

	if (accepted.length > 0) {
		lines.push(`已加载 ${accepted.length} 个工具的使用说明：${accepted.join(", ")}`);
	}
	if (rejected.length > 0) {
		lines.push(`拒绝（不在 lazy 名单中）：${rejected.join(", ")}`);
	}

	for (const name of accepted) {
		const tool = allTools.get(name);
		lines.push("");
		lines.push(`## ${name}`);
		if (!tool) {
			lines.push("未找到工具元数据（可能尚未注册）。");
			continue;
		}
		lines.push(`Description: ${tool.description}`);
		lines.push("Parameters JSON Schema:");
		lines.push(JSON.stringify(tool.parameters, null, 2));
		if (tool.promptGuidelines && tool.promptGuidelines.length > 0) {
			lines.push("Guidelines:");
			for (const guideline of tool.promptGuidelines) {
				lines.push(`- ${guideline}`);
			}
		}
	}

	return lines.join("\n") || "没有请求任何工具。";
}

export default function (pi: ExtensionAPI) {
	let lazyNames: string[] = [];
	let lazySet = new Set<string>();
	const activated = new Set<string>();
	let skills: SkillMeta[] = [];

	pi.registerTool({
		name: LOADER_NAME,
		label: "Load Tools",
		description: "lazy 工具先经 load_tools 取用法，再由 call_tool 调用。",
		promptSnippet: "先 load_tools 取用法，后 call_tool 调用之。",
		promptGuidelines: [
			"未激活者先 load_tools 取用法。",
			"已激活者以 call_tool 调用。",
			"唯用户主动要求方可 load_tools，勿自发。",
		],
		parameters: LoadToolsParams,

		async execute(_toolCallId, params) {
			const requested = [...new Set(params.tools)];
			const { allowed: accepted, rejected } = filterAllowedTools(requested, lazyNames);

			// a. 没有请求任何工具：保持原有行为，不进确认门。
			if (requested.length === 0) {
				const text = buildLoadResult(requested, accepted, rejected, pi);
				return {
					content: [{ type: "text", text }],
					details: { requested, accepted, rejected } as ConfigReadResult,
				};
			}

			// b. 请求的工具全部不在 lazy 名单：直接返回拒绝结果，不进确认门。
			if (accepted.length === 0) {
				const text = buildLoadResult(requested, accepted, rejected, pi);
				return {
					content: [{ type: "text", text }],
					details: { requested, accepted, rejected } as ConfigReadResult,
				};
			}

			// c. 有合法工具待加载但 confirm 不为 true：返回挑战文本，零副作用。
			if (params.confirm !== true) {
				const toolDescriptions: Record<string, string> = {};
				for (const tool of pi.getAllTools()) {
					if (typeof tool.name === "string" && typeof tool.description === "string") {
						toolDescriptions[tool.name] = tool.description;
					}
				}
				const text = buildLoadChallenge({ toolNames: accepted, toolDescriptions });
				return {
					content: [{ type: "text", text }],
					details: { requested, accepted, rejected, confirmRequired: true } as ConfigReadResult,
				};
			}

			// d. confirm === true：执行实际加载，将工具加入 activated 集合并返回使用说明。
			for (const name of accepted) {
				activated.add(name);
			}

			const text = buildLoadResult(requested, accepted, rejected, pi);
			return {
				content: [{ type: "text", text }],
				details: { requested, accepted, rejected } as ConfigReadResult,
			};
		},
	});

	pi.registerTool({
		name: CALLER_NAME,
		label: "Call Tool",
		description: "以 call_tool 调用已激活之 lazy 工具，params 透传其参。",
		promptSnippet: "仅可调已由 load_tools 激活之 lazy 工具。",
		promptGuidelines: ["先经 load_tools 激活，后以 call_tool 调用。"],
		parameters: CallToolParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const name = params.tool;

			const permission = canCall(name, lazyNames, activated);
			if (!permission.ok) {
				throw new Error(permission.reason);
			}

			const toolInfo = pi.getAllTools().find((tool) => tool.name === name);
			if (!toolInfo) {
				throw new Error(`找不到工具 "${name}" 的注册信息。`);
			}

			const schema = toolInfo.parameters as object;
			const validation = validateParams(schema, params.params);
			if (!validation.ok) {
				throw new Error(
					`参数校验失败，未执行 "${name}":\n` + validation.errors.map((e) => `- ${e}`).join("\n"),
				);
			}

			const sourcePath = toolInfo.sourceInfo?.path;
			if (!sourcePath) {
				throw new Error(`工具 "${name}" 缺少来源路径，无法调用。`);
			}

			const definition = await findToolDefinition(sourcePath, name, pi);
			if (!definition) {
				throw new Error(`无法从 ${sourcePath} 加载工具 "${name}" 的执行定义。`);
			}

			return await definition.execute(toolCallId, params.params as never, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: SKILL_SEARCH_NAME,
		label: "Search Skills",
		description: "以关键词或技名寻技，返名、述、SKILL.md 路径。",
		promptSnippet: "寻技能，返 SKILL.md 路径。",
		parameters: Type.Object({
			query: Type.String({ description: "检索之词或技名。" }),
		}),

		async execute(_toolCallId, params) {
			const query = params.query.toLowerCase();
			const hits = skills.filter(
				(s) => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query),
			);
			const text =
				hits.length === 0
					? "未找到匹配之技能。"
					: hits.map((s) => `- ${s.name}: ${s.description}（SKILL.md: ${s.filePath}）`).join("\n");
			return { content: [{ type: "text", text }], details: {} };
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
			// 无有效配置 → 例外为空：全量 lazy（唯三常驻）；名单为 session_start 时点快照，此后注册的工具默认常驻
			const resident = new Set([LOADER_NAME, CALLER_NAME, SKILL_SEARCH_NAME]);
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
			activated.clear();
			definitionCache.clear();
			const notice = buildStartupNotice({
				toolNames: lazyNames,
				userConfigPath,
				projectConfigPath,
				effectiveConfigPath,
			});

			const active = pi.getActiveTools();
			const filtered = active.filter((toolName) => !lazySet.has(toolName));
			const initial = [...new Set([...filtered, LOADER_NAME, CALLER_NAME, SKILL_SEARCH_NAME])];
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
