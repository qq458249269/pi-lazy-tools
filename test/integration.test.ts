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
 *
 * The harness also records ctx.ui.notify calls made during session_start so the
 * startup notice can be asserted (tool list + effective config path), and
 * supports booting without ui/notify to verify the silent-skip branches, plus a
 * throwing notify implementation to verify a notify failure cannot break the
 * lazy-filter setup (setActiveTools must still run). The session_start event is
 * configurable (reason defaults to "startup", the only reason that should
 * notify, per the new contract).
 *
 * User-level config path control: the handler resolves the user config via
 * os.homedir(), which reads process.env.HOME on POSIX, so boot() can point HOME
 * at a throwaway temp directory to simulate "no user-level config"
 * deterministically (freshUserHome option).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
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

/** load_tools execute 的返回形态（两步确认断言用）。 */
interface LoadToolsResult {
	content: Array<{ type: string; text: string }>;
	details: {
		requested?: string[];
		accepted?: string[];
		rejected?: string[];
		confirmRequired?: boolean;
	};
}

type SessionReason = "startup" | "new" | "resume" | "fork" | "reload";

/** session_start 事件的最小形态（handler 只消费 reason 字段）。 */
interface SessionEvent {
	type: string;
	reason?: SessionReason;
}

type SessionHandler = (
	event: SessionEvent,
	ctx: { cwd?: string; ui?: { notify?: (text: string, options?: unknown) => void } },
) => void | Promise<void>;

/** before_agent_start handler 的最小形态（扩展只消费 systemPrompt / systemPromptOptions.skills）。 */
type BeforeAgentStartHandler = (
	event: { systemPrompt: string; systemPromptOptions: { skills?: unknown[] } },
) => { systemPrompt?: string } | void;

/** boot() 构造 session ctx/event 的选项（覆盖通知缺失/抛错、reason、配置文件缺失分支）。 */
interface BootOptions {
	/** 是否提供 ctx.ui（默认 true；false 模拟 ctx 完全没有 ui）。 */
	withUi?: boolean;
	/** 是否提供 ctx.ui.notify（默认 true；false 模拟 ui 存在但无 notify）。 */
	withNotify?: boolean;
	/**
	 * 替换 notify 实现（提供时优先生效，默认是记录器）。
	 * 用于注入「notify 存在但调用即抛错」的实现，如 () => { throw new Error("notify boom") }。
	 */
	notifyImpl?: (text: string, options?: unknown) => void;
	/** session_start 事件的 reason（默认 "startup"，保证既有 C1 语义；非 startup 不应弹通知）。 */
	reason?: SessionReason;
	/** 是否在临时工作区写 .pi/lazy-tools.json（默认 true；false 模拟项目级配置缺失）。 */
	writeProjectConfig?: boolean;
	/**
	 * 是否用临时目录架空 process.env.HOME（默认 false；true 时用户级配置指向一个不存在的
	 * 临时 HOME，使「两处都无配置文件」分支在集成层可测且确定。os.homedir() 在 POSIX 上读 $HOME）。
	 */
	freshUserHome?: boolean;
}

interface Harness {
	boot(lazyNames?: string[], options?: BootOptions): Promise<void>;
	cleanup(): void;
	loadTools(names: string[], options?: { confirm?: boolean }): Promise<unknown>;
	callTool(tool: string, params: unknown): Promise<unknown>;
	fakeEventsOnCalls(): number;
	/** session_start 期间 ctx.ui.notify 收到的调用记录。 */
	getNotifyCalls(): Array<{ text: string; options?: unknown }>;
	/** pi.setActiveTools 被调用的次数（判定 session_start handler 是否完整走完）。 */
	getSetActiveToolsCalls(): number;
	/** 当前临时工作区路径（即 session ctx 的 cwd）。 */
	getWorkspacePath(): string | undefined;
	/** freshUserHome 架空出的临时 HOME（即 session 期间 os.homedir() 的值）；未架设时为 undefined。 */
	getUserHomePath(): string | undefined;
	/** 返回已注册工具中指定名的工具定义（未注册则返回 undefined）。 */
	getRegisteredTool(name: string): Record<string, unknown> | undefined;
	/** 触发已注册的 before_agent_start handler，返回回传的 systemPrompt（若无则 undefined）。 */
	fireBeforeAgentStart(systemPromptOptions: unknown, systemPrompt?: string): { systemPrompt?: string } | undefined;
	/** 最近一次 pi.setActiveTools 收到的工具集。 */
	getLastActiveTools(): string[] | undefined;
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
	const beforeAgentStartHandlers: BeforeAgentStartHandler[] = [];
	const notifyCalls: Array<{ text: string; options?: unknown }> = [];
	let setActiveToolsCalls = 0;
	let lastActiveTools: string[] | undefined;
	let workspace: string | undefined;
	let userHome: string | undefined;

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
		setActiveTools: (names: string[]) => {
			setActiveToolsCalls += 1;
			lastActiveTools = names;
		},
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
		on: (event: string, handler: SessionHandler | BeforeAgentStartHandler) => {
			if (event === "session_start") sessionHandlers.push(handler as SessionHandler);
			else if (event === "before_agent_start") beforeAgentStartHandlers.push(handler as BeforeAgentStartHandler);
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
		async boot(lazyNames: string[] = [FAKE_TOOL_NAME], options: BootOptions = {}): Promise<void> {
			resetGlobalCounters();
			notifyCalls.length = 0;
			setActiveToolsCalls = 0;
			lastActiveTools = undefined;
			userHome = undefined;
			workspace = mkdtempSync(join(tmpdir(), "lazy-tools-it-"));
			mkdirSync(join(workspace, ".pi"));
			if (options.writeProjectConfig !== false) {
				writeFileSync(
					join(workspace, ".pi", "lazy-tools.json"),
					JSON.stringify({ lazy: lazyNames }),
				);
			}

			// session_start 事件：reason 可配置（默认 startup，保证既有 C1 语义）。
			const event: SessionEvent = {
				type: "session_start",
				reason: options.reason ?? "startup",
			};

			// session ctx：默认带 ui.notify 记录器；withUi/withNotify 覆写用于缺失分支，
			// notifyImpl 覆写用于「存在但调用即抛错」分支（优先级高于 withNotify）。
			const ctx: { cwd: string; ui?: { notify?: (text: string, options?: unknown) => void } } = {
				cwd: workspace,
			};
			if (options.withUi !== false) {
				ctx.ui = {};
				if (options.notifyImpl !== undefined) {
					ctx.ui.notify = options.notifyImpl;
				} else if (options.withNotify !== false) {
					ctx.ui.notify = (text, rawOptions) => {
						notifyCalls.push({ text, options: rawOptions });
					};
				}
			}

			// 用户级路径控制：os.homedir() 读 $HOME（POSIX），架空 HOME 使两处都无配置可测。
			// 无论 handler 是否抛错都在 finally 里还原并清理临时 HOME，不留跨用例残留。
			const originalHome = process.env.HOME;
			let tempUserHome: string | undefined;
			if (options.freshUserHome) {
				tempUserHome = mkdtempSync(join(tmpdir(), "lazy-tools-home-"));
				process.env.HOME = tempUserHome;
				userHome = tempUserHome;
			}

			try {
				for (const handler of sessionHandlers) {
					await handler(event, ctx);
				}
			} finally {
				if (tempUserHome !== undefined) {
					if (originalHome === undefined) delete process.env.HOME;
					else process.env.HOME = originalHome;
					rmSync(tempUserHome, { recursive: true, force: true });
				}
			}
		},
		cleanup(): void {
			if (workspace) rmSync(workspace, { recursive: true, force: true });
			workspace = undefined;
		},
		loadTools(names: string[], options?: { confirm?: boolean }): Promise<unknown> {
			const execute = loadToolsTool!.execute as (
				id: unknown,
				params: { tools: string[]; confirm?: boolean },
			) => Promise<unknown>;
			return execute(undefined, { tools: names, ...(options ?? {}) });
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
		getNotifyCalls(): Array<{ text: string; options?: unknown }> {
			return [...notifyCalls];
		},
		getSetActiveToolsCalls(): number {
			return setActiveToolsCalls;
		},
		getWorkspacePath(): string | undefined {
			return workspace;
		},
		getUserHomePath(): string | undefined {
			return userHome;
		},
		getRegisteredTool(name: string): Record<string, unknown> | undefined {
			return registered.find((t) => t.name === name);
		},
		fireBeforeAgentStart(systemPromptOptions: unknown, systemPrompt = ""): { systemPrompt?: string } | undefined {
			let current = systemPrompt;
			let returned: { systemPrompt?: string } | undefined;
			for (const handler of beforeAgentStartHandlers) {
				const result = handler({
					systemPrompt: current,
					systemPromptOptions: systemPromptOptions as { skills?: unknown[] },
				});
				if (result && typeof result === "object" && result.systemPrompt !== undefined) {
					current = result.systemPrompt;
					returned = { systemPrompt: current };
				}
			}
			return returned;
		},
		getLastActiveTools(): string[] | undefined {
			return lastActiveTools;
		},
	};
}

/** 建立临时工作区 → 触发 session_start → 运行用例 → 清理。 */
async function withHarness<T>(
	lazyNames: string[] | undefined,
	fn: (h: Harness) => Promise<T>,
	bootOptions: BootOptions = {},
): Promise<T> {
	const h = createHarness();
	try {
		await h.boot(lazyNames, bootOptions);
		return await fn(h);
	} finally {
		h.cleanup();
	}
}

/** 捕获执行期间所有 console.warn 调用（断言 session_start 未静默失败）。 */
async function captureWarnings(fn: () => Promise<void>): Promise<unknown[][]> {
	const originalWarn = console.warn;
	const collected: unknown[][] = [];
	console.warn = (...args: unknown[]) => {
		collected.push(args);
	};
	try {
		await fn();
	} finally {
		console.warn = originalWarn;
	}
	return collected;
}

describe("lazy-tools extension wiring (call_tool path)", () => {
	// B6: 未激活拒绝
	it("should refuse to call a whitelisted tool that has not been activated via load_tools", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			await assert.rejects(h.callTool(FAKE_TOOL_NAME, { action: "discover" }), /激活/);
			await assert.rejects(h.callTool(FAKE_TOOL_NAME, { action: "discover" }), /confirm: true/);
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 0, "target execute must not run");

			// 新契约补充：首调只返回 challenge（confirm !== true 不激活），callTool 仍被拒
			await h.loadTools([FAKE_TOOL_NAME]); // challenge only, 不激活
			await assert.rejects(h.callTool(FAKE_TOOL_NAME, { action: "discover" }), /激活/);
			await assert.rejects(h.callTool(FAKE_TOOL_NAME, { action: "discover" }), /confirm: true/);
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 0, "challenge-only load 不得激活，目标 execute 仍不可运行");
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
			await h.loadTools([FAKE_TOOL_NAME], { confirm: true });
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
			await h.loadTools([FAKE_TOOL_NAME], { confirm: true });
			const result = (await h.callTool(FAKE_TOOL_NAME, { action: "discover" })) as RenderedResult;
			assert.match(result.content[0].text, /fake ran: discover/);
			assert.equal(result.details.executed, true);
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 1);
		});
	});

	// B10: findToolDefinition 应按 (sourcePath, name) memoize —— factory 只跑一次
	it("should load the target tool definition only once across repeated call_tool invocations", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			await h.loadTools([FAKE_TOOL_NAME], { confirm: true });
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
			await h.loadTools([FAKE_TOOL_NAME], { confirm: true });
			await h.callTool(FAKE_TOOL_NAME, { action: "discover" });
			assert.equal(
				h.fakeEventsOnCalls(),
				0,
				"createFakePi must stub pi.events.on so real pi is never subscribed",
			);
		});
	});

	// B12: 首调无 confirm → 返回挑战（content 含工具名/"confirm: true"），details.confirmRequired === true，零副作用
	it("should return a challenge without activating anything when confirm is omitted", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const result = (await h.loadTools([FAKE_TOOL_NAME])) as LoadToolsResult;
			const text = result.content[0].text;

			// 挑战文本：含工具名 + 第二次调用形状
			assert.ok(text.includes(FAKE_TOOL_NAME), `challenge 应列出工具名; got: ${text}`);
			assert.ok(text.includes("confirm: true"), `challenge 应包含第二次调用形状 confirm: true; got: ${text}`);

			// details.confirmRequired === true
			assert.equal(result.details.confirmRequired, true, "details.confirmRequired 应为 true");

			// 零副作用：未激活 → callTool 仍被拒，目标 execute 未运行
			await assert.rejects(h.callTool(FAKE_TOOL_NAME, { action: "discover" }), /激活/);
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 0, "challenge 不得触发目标 execute");
		});
	});

	// B13: 首调显式 confirm:false → 同样返回挑战、不激活
	it("should return a challenge and not activate when confirm is explicitly false", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const result = (await h.loadTools([FAKE_TOOL_NAME], { confirm: false })) as LoadToolsResult;
			const text = result.content[0].text;

			assert.ok(text.includes(FAKE_TOOL_NAME), `challenge 应列出工具名; got: ${text}`);
			assert.ok(text.includes("confirm: true"), `challenge 应包含第二次调用形状; got: ${text}`);
			assert.equal(result.details.confirmRequired, true, "details.confirmRequired 应为 true");

			// 零副作用
			await assert.rejects(h.callTool(FAKE_TOOL_NAME, { action: "discover" }), /激活/);
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 0, "challenge 不得触发目标 execute");
		});
	});

	// B14: confirm:true → 激活成功，callTool 正常执行
	it("should activate and load tools when confirm is true", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const result = (await h.loadTools([FAKE_TOOL_NAME], { confirm: true })) as LoadToolsResult;
			const text = result.content[0].text;

			// 激活后返回使用说明（buildLoadResult 形态）
			assert.ok(text.includes("已加载"), `confirm:true 应返回使用说明; got: ${text}`);
			assert.ok(text.includes(FAKE_TOOL_NAME), `使用说明应含工具名; got: ${text}`);

			// 激活后 callTool 正常执行
			const callResult = (await h.callTool(FAKE_TOOL_NAME, { action: "discover" })) as RenderedResult;
			assert.match(callResult.content[0].text, /fake ran: discover/);
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 1, "confirm:true 后目标 execute 应运行一次");
		});
	});

	// B15: 全部不在名单（rejected 非空、accepted 空）→ 直接返回拒绝结果，不进确认门
	it("should reject immediately without a challenge when nothing is on the lazy whitelist", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const result = (await h.loadTools(["not_on_whitelist"], { confirm: false })) as LoadToolsResult;
			const text = result.content[0].text;

			// 拒绝结果：不在 lazy 名单
			assert.ok(text.includes("拒绝"), `应返回拒绝结果; got: ${text}`);
			assert.ok(text.includes("not_on_whitelist"), `拒绝结果应含请求的工具名; got: ${text}`);

			// 不进确认门：无 confirmRequired，文本无 challenge 形态
			assert.equal(result.details.confirmRequired, undefined, "全部 rejected 时 confirmRequired 应为 undefined");
			assert.ok(!text.includes("confirm: true"), `拒绝结果不应包含 challenge 第二次调用形状; got: ${text}`);
		});
	});

	// B16: 空数组请求 → 现有行为（"没有请求任何工具。"），不进确认门
	it("should return the no-request notice without a challenge for an empty tools array", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const result = (await h.loadTools([], { confirm: false })) as LoadToolsResult;
			const text = result.content[0].text;

			assert.ok(text.includes("没有请求任何工具。"), `空数组应返回"没有请求任何工具。"; got: ${text}`);
			assert.equal(result.details.confirmRequired, undefined, "空请求时 confirmRequired 应为 undefined");
		});
	});

	// B17: 首调无 confirm → challenge 文本含「用户主动要求」提示（约束层：仅在用户主动要求时才加载工具）
	it("should include a user-explicitly-asks constraint in the challenge text (integration)", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const result = (await h.loadTools([FAKE_TOOL_NAME])) as LoadToolsResult;
			const text = result.content[0].text;

			// 锁定的措辞：文本须同时含"用户"与"主动要求"（或"用户主动"）
			assert.ok(
				(text.includes("用户") && text.includes("主动要求")) || text.includes("用户主动"),
				`challenge 应含「仅在用户主动要求时才加载工具」类提示; got: ${text}`,
			);
		});
	});

	// B17b: 混合请求边界（白名单内 + 白名单外，confirm 缺省）→ 返回挑战，rejected 不进挑战文本
	it("should return a challenge for whitelisted tools while rejecting off-whitelist tools, without leaking rejected names into the challenge text", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const result = (await h.loadTools([FAKE_TOOL_NAME, "not_on_whitelist"])) as LoadToolsResult;
			const text = result.content[0].text;

			// 返回 challenge 形态
			assert.ok(text.includes(FAKE_TOOL_NAME), `challenge 应列出白名单内工具名; got: ${text}`);
			assert.ok(text.includes("confirm: true"), `challenge 应包含第二次调用形状; got: ${text}`);
			assert.equal(result.details.confirmRequired, true, "含白名单内工具时 confirmRequired 应为 true");

			// rejected 含 not_on_whitelist
			assert.ok(
				(result.details.rejected ?? []).includes("not_on_whitelist"),
				`details.rejected 应含 not_on_whitelist; got: ${JSON.stringify(result.details.rejected)}`,
			);

			// accepted 含 FAKE_TOOL_NAME
			assert.ok(
				(result.details.accepted ?? []).includes(FAKE_TOOL_NAME),
				`details.accepted 应含 ${FAKE_TOOL_NAME}; got: ${JSON.stringify(result.details.accepted)}`,
			);

			// 锁定：rejected 不进挑战文本
			assert.ok(
				!text.includes("not_on_whitelist"),
				`challenge 文本不得含被拒绝工具名（锁定 rejected 不进挑战文本）; got: ${text}`,
			);
		});
	});

	// B18: 注册的 load_tools 工具的 promptGuidelines 包含用户主动要求约束
	it("should register load_tools with a user-explicitly-asks prompt guideline", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const tool = h.getRegisteredTool("load_tools");
			assert.ok(tool !== undefined, "load_tools should be registered");

			const guidelines = (tool as Record<string, unknown>).promptGuidelines as string[] | undefined;
			assert.ok(Array.isArray(guidelines), "load_tools should have promptGuidelines");
			assert.ok(
				guidelines!.some(
					(g) =>
						(g.includes("user") && (g.includes("explicitly") || g.includes("ask"))) ||
						(g.includes("用户") && (g.includes("主动") || g.includes("要求"))),
				),
				`load_tools promptGuidelines 应含「仅在用户主动要求时才加载工具」类约束; got: ${JSON.stringify(guidelines)}`,
			);
		});
	});
});

describe("lazy-tools startup notice (session_start)", () => {
	// C1: boot 后恰好通知一次；情况一文案：名单 + 「当前生效的配置文件为：」+ 项目级路径
	// （harness 临时工作区 .pi/lazy-tools.json 是项目级且优先 → 情况一；不逐一标注用户级/项目级）
	it("should notify the tool list and the effective project config path once on session_start", async () => {
		await withHarness([FAKE_TOOL_NAME, "openaas"], async (h) => {
			const calls = h.getNotifyCalls();
			assert.equal(calls.length, 1, "session_start should call ctx.ui.notify exactly once");

			const text = calls[0].text;

			// 名单：表头 + 逐行列出每个工具名
			assert.ok(text.includes("当前 lazy 工具名单："), `notice should have the list header; got: ${text}`);
			assert.ok(text.includes(FAKE_TOOL_NAME), `notice should list ${FAKE_TOOL_NAME}; got: ${text}`);
			assert.ok(text.includes("openaas"), `notice should list openaas; got: ${text}`);

			// 情况一：项目级配置存在且优先 → 「当前生效的配置文件为：」+ 项目级路径
			const workspacePath = h.getWorkspacePath();
			assert.ok(workspacePath, "harness should own a temp workspace");
			const projectPath = join(workspacePath, ".pi", "lazy-tools.json");
			assert.ok(
				text.includes("当前生效的配置文件为："),
				`notice should mark the effective config; got: ${text}`,
			);
			assert.ok(
				text.includes(projectPath),
				`notice should mention the effective project path ${projectPath}; got: ${text}`,
			);

			// 情况一只陈述生效路径，不逐一标注用户级/项目级位置
			assert.ok(!text.includes("用户级"), `case 1 must not list the user-level location; got: ${text}`);
			assert.ok(!text.includes("项目级"), `case 1 must not label the project-level location; got: ${text}`);

			// 措辞禁令：不得出现「当前激活」「如需修改」「路径都没有找到」
			assert.ok(!text.includes("当前激活"), `notice must avoid the banned phrase; got: ${text}`);
			assert.ok(!text.includes("如需修改"), `notice must avoid the banned phrase; got: ${text}`);
			assert.ok(!text.includes("路径都没有找到"), `notice must avoid the banned phrase; got: ${text}`);

			// C4 语义：核心初始化（setActiveTools）不受通知链路影响
			assert.ok(h.getSetActiveToolsCalls() > 0, "session_start should always run setActiveTools");
		});
	});

	// 新契约：仅 reason === "startup" 弹通知；new/resume/fork/reload 不弹，但 setActiveTools 仍执行
	it("should skip notify for non-startup reasons but still run setActiveTools", async () => {
		const reasons: SessionReason[] = ["new", "resume", "fork", "reload"];
		for (const reason of reasons) {
			await withHarness([FAKE_TOOL_NAME], async (h) => {
				assert.equal(
					h.getNotifyCalls().length,
					0,
					`ctx.ui.notify must not be called when reason is ${reason}`,
				);
				assert.ok(
					h.getSetActiveToolsCalls() > 0,
					`setActiveTools must still run when reason is ${reason}`,
				);
			}, { reason });
		}
	});

	// 新契约：两处都无配置文件（项目级不写 + 用户级指向不存在的临时 HOME）→ 情况二文案
	it("should notify the no-config notice when neither user nor project config exists", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const calls = h.getNotifyCalls();
			assert.equal(calls.length, 1, "session_start should notify once even without any config");

			const text = calls[0].text;
			const workspacePath = h.getWorkspacePath();
			const userHomePath = h.getUserHomePath();
			assert.ok(workspacePath, "harness should own a temp workspace");
			assert.ok(userHomePath, "harness should own a temp user home");

			// 情况二：名单必为（空）
			assert.ok(text.includes("（空）"), `notice should mark the empty list; got: ${text}`);

			// 双路径分别列出 + 空行 + 「以上两个文件均不存在」
			assert.ok(
				text.includes("当前暂无配置文件："),
				`notice should mark no-config; got: ${text}`,
			);
			assert.ok(
				text.includes(`用户级：${join(userHomePath, ".pi", "lazy-tools.json")}`),
				`notice should list the user-level path; got: ${text}`,
			);
			assert.ok(
				text.includes(`项目级：${join(workspacePath, ".pi", "lazy-tools.json")}`),
				`notice should list the project-level path; got: ${text}`,
			);
			assert.ok(
				text.includes("\n\n以上两个文件均不存在"),
				`notice should end with the both-missing line; got: ${JSON.stringify(text)}`,
			);

			// 无生效路径 + 措辞禁令
			assert.ok(
				!text.includes("当前生效的配置文件为："),
				`notice must not claim an effective config; got: ${text}`,
			);
			assert.ok(!text.includes("当前激活"), `notice must avoid the banned phrase; got: ${text}`);
			assert.ok(!text.includes("如需修改"), `notice must avoid the banned phrase; got: ${text}`);
			assert.ok(!text.includes("路径都没有找到"), `notice must avoid the banned phrase; got: ${text}`);
		}, { writeProjectConfig: false, freshUserHome: true });
	});

	// C2: ctx 完全没有 ui → 静默跳过，handler 其余逻辑照常完成、不产生失败告警
	it("should skip notify silently when the session ctx has no ui", async () => {
		const warnings = await captureWarnings(async () => {
			await withHarness([FAKE_TOOL_NAME], async (h) => {
				assert.equal(h.getNotifyCalls().length, 0, "notify must not be called without ctx.ui");
				assert.ok(
					h.getSetActiveToolsCalls() > 0,
					"session_start should still finish its setup when ui is unavailable",
				);
			}, { withUi: false });
		});

		assert.equal(
			warnings.filter((args) => String(args[0]).includes("session_start handler failed")).length,
			0,
			"missing ui must not surface as a handler failure warning",
		);
	});

	// C3: ui 存在但 notify 不存在 → 同样静默跳过
	it("should skip notify silently when ctx.ui has no notify", async () => {
		const warnings = await captureWarnings(async () => {
			await withHarness([FAKE_TOOL_NAME], async (h) => {
				assert.equal(h.getNotifyCalls().length, 0, "notify must not be called without ui.notify");
				assert.ok(
					h.getSetActiveToolsCalls() > 0,
					"session_start should still finish its setup when notify is unavailable",
				);
			}, { withNotify: false });
		});

		assert.equal(
			warnings.filter((args) => String(args[0]).includes("session_start handler failed")).length,
			0,
			"missing notify must not surface as a handler failure warning",
		);
	});

	// C4: notify 存在但调用即抛错 → 核心初始化（setActiveTools）必须照常完成，不产生 handler 失败告警
	// （reviewer Important 边界：notify 的异常不得被外层 catch 吞掉并跳过其后的 setActiveTools，
	//   否则本会话 lazy 工具的过滤会静默失效。）
	it("should still run setActiveTools when ctx.ui.notify throws", async () => {
		let notifyAttempts = 0;
		const warnings = await captureWarnings(async () => {
			await withHarness([FAKE_TOOL_NAME], async (h) => {
				assert.equal(
					notifyAttempts,
					1,
					"the throwing notify should actually be invoked during session_start",
				);
				assert.ok(
					h.getSetActiveToolsCalls() > 0,
					"session_start must still finish its setup (setActiveTools) even when notify throws",
				);
			}, { notifyImpl: () => { notifyAttempts += 1; throw new Error("notify boom"); } });
		});

		assert.equal(
			warnings.filter((args) => String(args[0]).includes("session_start handler failed")).length,
			0,
			"a throwing notify must not surface as a handler failure warning",
		);
	});
});
// ===== 通用化注册文案（与任何本机具体工具名彻底解耦；TDD RED） =====
//
// 背景：load_tools 的注册期文案（description / promptSnippet / promptGuidelines[0]）
// 曾写死本机工具名（revive_subagent、OpenAaaS）与专属能力语义（恢复 subagent 会话）。
// 以下判据要求注册面与源码彻底通用化：
//   T-A  从真实注册结果取三个文案字段，断言不含任何具体工具名字面量（可扩展黑名单 +
//        动态“任何已注册工具名都不许出现”双保险），guideline 不得保留专指某工具的语义短语。
//   T-B  源码兜底扫描：lazy-tools.ts / lazy-tools/core.ts 源文件本身不得残留这些字面量。
//   T-C  性质断言（非逐字相等）：通用化后文案仍非空、有长度下限，且仍表达
//        “先 load_tools 激活、再 call_tool 调用”的用法（两动作名必须同时出现）。

describe("generic registration copy (decoupled from local tool names)", () => {
	/**
	 * 文案黑名单：注册期文案里禁止出现的具体工具名/本地耦合词（一律转小写后子串比对）。
	 * 可扩展：未来发现任何新的写死名字，只需在此登记一条，T-A/T-B 的全部字段与源文件
	 * 都会自动被检查到——不允许出现“只测当初那两个词”的一次性断言。
	 */
	const BANNED_COPY_LITERALS: string[] = ["revive_subagent", "openaas"];

	/**
	 * 语义黑名单：promptGuidelines 等面向模型的文案不得再专指某一类工具的特定能力。
	 * （本次目标语义：restoring/continuing a previous subagent session = revive_subagent 专属。）
	 */
	const BANNED_SPECIFIC_PHRASES: string[] = ["subagent", "restore", "restoring", "continuing"];

	/**
	 * 参与扫描的运行时源文件（T-B 兜底：防止“运行时拼掉了、源码里还留着”的假解耦）。
	 * lazy-tools/core.ts 当前 0 命中，一并纳入以覆盖未来把文案挪进 core 的情况。
	 */
	const RUNTIME_SOURCES: string[] = ["lazy-tools.ts", join("lazy-tools", "core.ts")];

	const LOADER_NAME = "load_tools";
	const CALLER_NAME = "call_tool";

	interface LoadToolsCopy {
		description: string;
		promptSnippet: string;
		promptGuidelines: string[];
	}

	/** 从真实注册结果取 load_tools 的三个文案字段（缺失或类型不符即失败）。 */
	function getLoadToolsCopy(h: Harness): LoadToolsCopy {
		const tool = h.getRegisteredTool(LOADER_NAME);
		assert.ok(tool !== undefined, "load_tools should be registered");

		const description = tool.description;
		const promptSnippet = tool.promptSnippet;
		const promptGuidelines = tool.promptGuidelines;
		assert.equal(typeof description, "string", "load_tools.description should be a string");
		assert.equal(typeof promptSnippet, "string", "load_tools.promptSnippet should be a string");
		assert.ok(Array.isArray(promptGuidelines), "load_tools.promptGuidelines should be an array");
		for (const g of promptGuidelines as unknown[]) {
			assert.equal(typeof g, "string", "every promptGuideline should be a string");
		}
		return {
			description: description as string,
			promptSnippet: promptSnippet as string,
			promptGuidelines: promptGuidelines as string[],
		};
	}

	// T-A：注册面（description / promptSnippet / promptGuidelines）不得含黑名单字面量
	it("should keep every banned tool-name literal out of description, promptSnippet, and promptGuidelines", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const copy = getLoadToolsCopy(h);
			const fields: Record<string, string> = {
				description: copy.description,
				promptSnippet: copy.promptSnippet,
				promptGuidelines: copy.promptGuidelines.join("\n"),
			};

			for (const [field, text] of Object.entries(fields)) {
				const lowered = text.toLowerCase();
				for (const banned of BANNED_COPY_LITERALS) {
					assert.ok(
						!lowered.includes(banned),
						`load_tools.${field} must not contain the local tool name "${banned}" (upstream copy must be decoupled from any machine's toolset); got: ${text}`,
					);
				}
			}
		});
	});

	// T-A 动态版：任何在本 harness 中注册的工具名都不许出现在注册文案里
	//（load_tools/call_tool 自身除外——文案本来就要教模型用这两个动作）。
	it("should not mention the name of any registered tool other than load_tools and call_tool", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const copy = getLoadToolsCopy(h);
			const all = [copy.description, copy.promptSnippet, ...copy.promptGuidelines]
				.join("\n")
				.toLowerCase();

			const registeredNames = [LOADER_NAME, CALLER_NAME, FAKE_TOOL_NAME];
			for (const name of registeredNames) {
				if (name === LOADER_NAME || name === CALLER_NAME) continue;
				assert.ok(
					!all.includes(name.toLowerCase()),
					`load_tools registration copy must not hardcode the local tool name "${name}"; got: ${all}`,
				);
			}
		});
	});

	// T-A 语义版：guidelines 不得保留专指某一工具的特定能力短语（恢复/继续 subagent 会话）
	it("should not keep capability-specific phrasing in promptGuidelines", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const copy = getLoadToolsCopy(h);
			const text = copy.promptGuidelines.join("\n").toLowerCase();

			for (const banned of BANNED_SPECIFIC_PHRASES) {
				assert.ok(
					!text.includes(banned),
					`load_tools.promptGuidelines must not keep capability-specific phrasing "${banned}" (was specialized for revive_subagent's session-restore semantics); got: ${text}`,
				);
			}
		});
	});

	// T-B：源码兜底扫描（防止运行时拼掉、源码残留）
	it("should not contain any banned tool-name literal in the runtime source files", () => {
		for (const rel of RUNTIME_SOURCES) {
			const src = readFileSync(join(import.meta.dirname, "..", rel), "utf8").toLowerCase();
			for (const banned of BANNED_COPY_LITERALS) {
				assert.ok(
					!src.includes(banned),
					`${rel} source must not contain the local tool name "${banned}" (copy must be generic at the source level, not assembled away at runtime);`,
				);
			}
		}
	});

	// T-C：description 仍表达“先 load_tools、再 call_tool”的用法（非逐字相等，只锁性质）
	it("should keep description non-trivial and mention both the load and call actions in order", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const { description } = getLoadToolsCopy(h);

			assert.ok(description.trim().length >= 20, `description must stay substantive (>= 20 chars), not an empty or stub string; got: ${JSON.stringify(description)}`);
			assert.ok(description.includes(LOADER_NAME), `description must still teach the load action ("${LOADER_NAME}"); got: ${description}`);
			assert.ok(description.includes(CALLER_NAME), `description must still teach the call action ("${CALLER_NAME}"); got: ${description}`);
			assert.ok(
				description.indexOf(LOADER_NAME) < description.indexOf(CALLER_NAME),
				`description must present the load action before the call action (load-then-call usage); got: ${description}`,
			);
		});
	});

	// T-C：promptSnippet 仍同时表达 load 与 call 两个动作名（不得退化成空串/单字/只提一边）
	it("should keep promptSnippet non-trivial and mention both the load and call actions", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const { promptSnippet } = getLoadToolsCopy(h);

			assert.ok(promptSnippet.trim().length >= 30, `promptSnippet must stay substantive (>= 30 chars); got: ${JSON.stringify(promptSnippet)}`);
			assert.match(promptSnippet, /load/i, `promptSnippet must mention the load action; got: ${promptSnippet}`);
			assert.match(promptSnippet, /call/i, `promptSnippet must mention the call action; got: ${promptSnippet}`);
		});
	});

	// T-C：promptGuidelines 仍覆盖 load 与 call 两个动作名，且每条都不退化
	it("should keep promptGuidelines non-trivial and cover both the load and call actions", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const { promptGuidelines } = getLoadToolsCopy(h);

			assert.ok(promptGuidelines.length > 0, "promptGuidelines must not become an empty array");
			const joined = promptGuidelines.join("\n");
			for (const g of promptGuidelines) {
				assert.ok(g.trim().length >= 10, `every guideline must stay substantive (>= 10 chars), not an empty or stub string; got: ${JSON.stringify(g)}`);
			}
			assert.ok(joined.includes(LOADER_NAME), `promptGuidelines must still cover the load action ("${LOADER_NAME}"); got: ${joined}`);
			assert.ok(joined.includes(CALLER_NAME), `promptGuidelines must still cover the call action ("${CALLER_NAME}"); got: ${joined}`);
		});
	});
});

// lazy-skills：技能清单从系统提示剥离，改以 skill_search 检索
//（pi 0.84.x 无 sections → 扩展回传重写后的整串 systemPrompt）
describe("lazy-skills", () => {
	it("should strip the skills prompt section and search skills via skill_search", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const search = h.getRegisteredTool("skill_search");
			assert.ok(search !== undefined, "skill_search should be registered");

			const basePrompt = [
				"You are a test.",
				"",
				"The following skills provide specialized instructions for specific tasks.",
				"Use the read tool to load a skill's file when the task matches its description.",
				"",
				"<available_skills>",
				"  <skill>",
				"    <name>foo-skill</name>",
				"  </skill>",
				"</available_skills>",
				"",
				"Current working directory: /w",
			].join("\n");

			// 无技能 → 不重写提示词
			assert.equal(
				h.fireBeforeAgentStart({ skills: [] }, basePrompt),
				undefined,
				"empty skills should not trigger a prompt rewrite",
			);

			const skills = [
				{ name: "foo-skill", description: "Foo helpers", filePath: "/skills/foo/SKILL.md" },
			];
			const result = h.fireBeforeAgentStart({ skills }, basePrompt);
			assert.ok(result?.systemPrompt, "handler should return a replacement system prompt");
			const replaced = result.systemPrompt!;
			assert.ok(!replaced.includes("<available_skills>"), `skills section should be stripped; got: ${replaced}`);
			assert.ok(replaced.includes("skill_search"), `note should point at skill_search; got: ${replaced}`);
			assert.ok(replaced.includes("You are a test."), "base prompt must be preserved");

			const active = h.getLastActiveTools();
			assert.ok(active?.includes("skill_search"), `skill_search should be in the initial active set; got: ${JSON.stringify(active)}`);

			const execute = search!.execute as (
				id: string,
				params: { query: string },
			) => Promise<{ content: Array<{ type: string; text: string }> }>;
			const hit = await execute("", { query: "foo" });
			const hitText = hit.content.map((c) => c.text).join("\n");
			assert.ok(hitText.includes("foo-skill"), `search should find foo-skill; got: ${hitText}`);
			assert.ok(hitText.includes("SKILL.md"), `search should return the SKILL.md path; got: ${hitText}`);

			const miss = await execute("", { query: "zzz-not-there" });
			assert.ok(miss.content[0]!.text.length > 0, "empty search should still return text");
		});
	});
});
