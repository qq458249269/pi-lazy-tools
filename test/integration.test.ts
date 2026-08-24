/**
 * Integration tests for the lazy-tools extension wiring (call_tool path).
 *
 * Boots the real extension with a hand-rolled fake ExtensionAPI (no pi
 * runtime), captures the registered load_tools/call_tool tools via a fake
 * pi.on(...) shim, drives the session_start handler against a temp workspace
 * config, then exercises load_tools → call_tool against a fixture target
 * extension (fixtures/fake-target.ts).
 *
 * The fixture's sourceInfo.path points at the real fixture file on disk so
 * findToolDefinition's module replay mechanism is exercised for real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as extModule from "../lazy-tools.ts";
import {
	FAKE_TOOL_NAME,
	FAKE_TOOL_SCHEMA,
	FACTORY_CALLS_KEY,
	EXECUTE_CALLS_KEY,
} from "./fixtures/fake-target.ts";

const FIXTURE_SOURCE = join(import.meta.dirname, "fixtures", "fake-target.ts");

/** 目标工具 execute 的返回形态（透传断言用）。 */
interface RenderedResult {
	content: Array<{ type: string; text: string }>;
	details: { executed: boolean };
}

type SessionHandler = (event: unknown, ctx: { cwd?: string }) => void | Promise<void>;

interface Harness {
	boot(lazyNames?: string[]): Promise<void>;
	cleanup(): void;
	loadTools(names: string[]): Promise<unknown>;
	callTool(tool: string, params: unknown): Promise<unknown>;
	fakeEventsOnCalls(): number;
}

function globalCounter(key: string): number {
	return ((globalThis as Record<string, unknown>)[key] as number | undefined) ?? 0;
}

function resetGlobalCounters(): void {
	const g = globalThis as Record<string, unknown>;
	g[FACTORY_CALLS_KEY] = 0;
	g[EXECUTE_CALLS_KEY] = 0;
}

/**
 * 兼容 ESM/CJS 互操作：tsx 将无 package.json 的扩展文件按 CJS 加载，
 * ESM 视图下命名空间 shape 为 { default: { default: fn } }（CJS exports 包一层）。
 * 钻两层取到 factory；若目录将来变为真 ESM 则 extModule.default 直接是函数。
 */
const defaultExport = (extModule as { default?: unknown }).default;
const innerExport =
	defaultExport && typeof defaultExport === "object" && "default" in defaultExport
		? (defaultExport as { default?: unknown }).default
		: defaultExport;
const createLazyToolsExtension: (pi: never) => void = typeof innerExport === "function"
	? (innerExport as (pi: never) => void)
	: (extModule as never);

	/**
	 * Boot the real lazy-tools extension against a fake pi, capturing registered
	 * tools and the session_start handler.
	 */
	function createHarness(): Harness {
	const registered: Array<Record<string, unknown>> = [];
	const fakeEventCalls: string[] = [];
	const sessionHandlers: SessionHandler[] = [];
	let workspace: string | undefined;

	// 手写伪造 ExtensionAPI：registration 打桩、events.on 计数、getAllTools
	// 提供含 sourceInfo.path 的目标工具元数据（模拟 pi 运行时）。
	const fakePi = {
		registerTool: (tool: Record<string, unknown>) => {
			registered.push(tool);
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		registerMessageRenderer: () => {},
		registerMarkdownTransformer: () => {},
		registerEntryRenderer: () => {},
		registerProvider: () => {},
		unregisterProvider: () => {},
		setActiveTools: () => {},
		getActiveTools: (): string[] => [],
		getAllTools: () => [
			...registered.map((t) => ({
				name: t.name,
				label: t.label,
				description: t.description,
				parameters: t.parameters,
				promptGuidelines: t.promptGuidelines,
			})),
			{
				name: FAKE_TOOL_NAME,
				label: "Fake Discover",
				description: "Fake OpenAaaS-like tool used by lazy-tools integration tests.",
				parameters: FAKE_TOOL_SCHEMA,
				promptGuidelines: [],
				sourceInfo: { path: FIXTURE_SOURCE },
			},
		],
		on: (event: string, handler: SessionHandler) => {
			if (event === "session_start") sessionHandlers.push(handler);
		},
		events: {
			on: (event: string) => {
				fakeEventCalls.push(event);
			},
		},
	};

	createLazyToolsExtension(fakePi as never);

	const loadToolsTool = registered.find((t) => t.name === "load_tools");
	const callToolTool = registered.find((t) => t.name === "call_tool");
	assert.ok(
		loadToolsTool !== undefined && callToolTool !== undefined,
		"extension should register load_tools and call_tool",
	);

	return {
		async boot(lazyNames: string[] = [FAKE_TOOL_NAME]): Promise<void> {
			resetGlobalCounters();
			workspace = mkdtempSync(join(tmpdir(), "lazy-tools-it-"));
			mkdirSync(join(workspace, ".pi"));
			writeFileSync(join(workspace, ".pi", "lazy-tools.json"), JSON.stringify({ lazy: lazyNames }));
			for (const handler of sessionHandlers) {
				await handler(undefined, { cwd: workspace });
			}
		},
		cleanup(): void {
			if (workspace) rmSync(workspace, { recursive: true, force: true });
			workspace = undefined;
		},
		loadTools(names: string[]): Promise<unknown> {
			const execute = loadToolsTool!.execute as (
				id: unknown,
				params: { tools: string[] },
			) => Promise<unknown>;
			return execute(undefined, { tools: names });
		},
		callTool(tool: string, params: unknown): Promise<unknown> {
			const execute = callToolTool!.execute as (
				id: unknown,
				params: { tool: string; params: unknown },
				...rest: unknown[]
			) => Promise<unknown>;
			return execute(undefined, { tool, params });
		},
		fakeEventsOnCalls(): number {
			return fakeEventCalls.length;
		},
	};
}

/** 建立临时工作区 → 触发 session_start → 运行用例 → 清理。 */
async function withHarness<T>(
	lazyNames: string[] | undefined,
	fn: (h: Harness) => Promise<T>,
): Promise<T> {
	const h = createHarness();
	try {
		await h.boot(lazyNames);
		return await fn(h);
	} finally {
		h.cleanup();
	}
}

describe("lazy-tools extension wiring (call_tool path)", () => {
	// B6: 未激活拒绝
	it("should refuse to call a whitelisted tool that has not been activated via load_tools", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			await assert.rejects(h.callTool(FAKE_TOOL_NAME, { action: "discover" }), /激活/);
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 0, "target execute must not run");
		});
	});

	// B7: 白名单外拒绝
	it("should refuse a tool that is not on the lazy whitelist", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			await assert.rejects(h.callTool("evil_tool", { action: "discover" }), /lazy 名单/);
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 0, "target execute must not run");
		});
	});

	// B8: 参数不合法 → 结构化错误（字段路径），目标不执行
	it("should reject invalid target params with a field-path error and never execute the target", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			await h.loadTools([FAKE_TOOL_NAME]);
			await assert.rejects(
				h.callTool(FAKE_TOOL_NAME, { action: "nope" }),
				/action: expected one of \[discover, submit\], got "nope"/,
			);
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 0, "target execute must not run");
		});
	});

	// B9: 合法参数 → 目标执行且结果透传
	it("should invoke the target execute and pass through its result for valid params", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			await h.loadTools([FAKE_TOOL_NAME]);
			const result = (await h.callTool(FAKE_TOOL_NAME, { action: "discover" })) as RenderedResult;
			assert.match(result.content[0].text, /fake ran: discover/);
			assert.equal(result.details.executed, true);
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 1);
		});
	});

	// B10: findToolDefinition 应按 (sourcePath, name) memoize —— factory 只跑一次
	it("should load the target tool definition only once across repeated call_tool invocations", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			await h.loadTools([FAKE_TOOL_NAME]);
			await h.callTool(FAKE_TOOL_NAME, { action: "discover" });
			await h.callTool(FAKE_TOOL_NAME, { action: "submit" });
			assert.equal(
				globalCounter(FACTORY_CALLS_KEY),
				1,
				"target factory should run exactly once for repeated call_tool of the same tool",
			);
		});
	});

	// B11: 目标 factory 里的 pi.events.on 不得订阅到真实 pi
	it("should stub events.on on the fake pi so the target factory never subscribes to the real pi", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			await h.loadTools([FAKE_TOOL_NAME]);
			await h.callTool(FAKE_TOOL_NAME, { action: "discover" });
			assert.equal(
				h.fakeEventsOnCalls(),
				0,
				"createFakePi must stub pi.events.on so real pi is never subscribed",
			);
		});
	});
});