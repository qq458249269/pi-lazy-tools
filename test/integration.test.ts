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
	loadTools(names: string[]): Promise<unknown>;
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
	const notifyCalls: Array<{ text: string; options?: unknown }> = [];
	let setActiveToolsCalls = 0;
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
		setActiveTools: () => {
			setActiveToolsCalls += 1;
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
		async boot(lazyNames: string[] = [FAKE_TOOL_NAME], options: BootOptions = {}): Promise<void> {
			resetGlobalCounters();
			notifyCalls.length = 0;
			setActiveToolsCalls = 0;
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