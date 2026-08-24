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
 *   Format:  { "lazy": string[] }
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { createRequire } from "node:module";
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
	type LazyConfig,
} from "./lazy-tools/core.ts";

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const requireFn = typeof require !== "undefined" ? require : createRequire(import.meta.url);

const CONFIG_NAME = "lazy-tools.json";
const LOADER_NAME = "load_tools";
const CALLER_NAME = "call_tool";

interface ConfigReadResult {
	requested: string[];
	accepted: string[];
	rejected: string[];
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
		const mod = requireFn(sourcePath);
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
		description: "Names of lazy tools to load usage instructions for.",
	}),
});

type LoadToolsParams = Static<typeof LoadToolsParams>;

const CallToolParams = Type.Object({
	tool: Type.String({ description: "Name of the lazy tool to invoke." }),
	params: Type.Record(Type.String(), Type.Unknown(), {
		description: "Parameters to forward to the target tool.",
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

	pi.registerTool({
		name: LOADER_NAME,
		label: "Load Tools",
		description:
			"当任务需要恢复/继续之前的 subagent 会话（revive_subagent），或需要向远程 OpenAaaS Agent 服务提交任务（OpenAaaS）时，先用 load_tools 获取其用法，再用 call_tool 调用。",
		promptSnippet: "Activate hidden tools such as revive_subagent or OpenAaaS by loading their usage instructions.",
		promptGuidelines: [
			"Use load_tools when the task requires restoring or continuing a previous subagent session.",
			"Use call_tool when you need to invoke a lazy tool that has already been loaded via load_tools.",
		],
		parameters: LoadToolsParams,

		async execute(_toolCallId, params) {
			const requested = [...new Set(params.tools)];
			const { allowed: accepted, rejected } = filterAllowedTools(requested, lazyNames);

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
		description:
			"调用已经由 load_tools 激活的隐藏工具。参数 tool 指定目标工具名，params 透传给目标工具。",
		promptSnippet: "Invoke a lazy tool that has already been loaded via load_tools.",
		promptGuidelines: [
			"Use call_tool only after the target tool has been loaded via load_tools.",
		],
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

	pi.on("session_start", async (event, ctx) => {
		try {
			const cwd = ctx.cwd ?? process.cwd();
			const userConfigPath = join(homedir(), ".pi", CONFIG_NAME);
			const projectConfigPath = join(cwd, ".pi", CONFIG_NAME);
			const userConfig = readConfigFile(userConfigPath);
			const projectConfig = readConfigFile(projectConfigPath);
			lazyNames = mergeLazyConfigs(userConfig, projectConfig).lazy;
			lazySet = new Set(lazyNames);
			activated.clear();
			definitionCache.clear();

			const effectiveConfigPath = selectEffectiveConfigPath(
				userConfig,
				projectConfig,
				userConfigPath,
				projectConfigPath,
			);
			const notice = buildStartupNotice({
				toolNames: lazyNames,
				userConfigPath,
				projectConfigPath,
				effectiveConfigPath,
			});

			const active = pi.getActiveTools();
			const filtered = active.filter((toolName) => !lazySet.has(toolName));
			const initial = [...new Set([...filtered, LOADER_NAME, CALLER_NAME])];
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
