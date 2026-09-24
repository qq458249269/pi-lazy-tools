/**
 * Integration tests for the lazy-tools extension wiring (omnify path).
 *
 * Boots the real extension with a hand-rolled fake ExtensionAPI (no pi
 * runtime), captures the registered omnify tool via a fake pi.on(...) shim,
 * drives the session_start handler against a temp workspace config, then
 * exercises omnify against a fixture target extension
 * (fixtures/fake-target.ts).
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

/** before_agent_start handler 的最小形态（扩展消费 systemPrompt、systemPromptOptions.skills 与 sections）。 */
type BeforeAgentStartHandler = (
	event: {
		systemPrompt: string;
		systemPromptOptions: { skills?: unknown[]; sections?: Record<string, string> };
	},
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
	/** 是否用临时目录架空 process.env.HOME（默认 false）。 */
	freshUserHome?: boolean;
}

interface Harness {
	boot(residentNames?: string[], options?: BootOptions): Promise<void>;
	/** 同一扩展实例内再次触发 session_start（新会话，工作区重建），验证 per-session 缓存清理。 */
	reboot(residentNames?: string[], options?: BootOptions): Promise<void>;
	cleanup(): void;
	omnify(params: {
		goal: string;
		args?: unknown;
		tool?: string;
	}): Promise<unknown>;
	getNotifyCalls(): Array<{ text: string; options?: unknown }>;
	getSetActiveToolsCalls(): number;
	getWorkspacePath(): string | undefined;
	getUserHomePath(): string | undefined;
	getRegisteredTool(name: string): Record<string, unknown> | undefined;
	fireBeforeAgentStart(
		systemPromptOptions: unknown,
		systemPrompt?: string,
	): { systemPrompt?: string } | undefined;
	getLastActiveTools(): string[] | undefined;
	/** 目标工具 execute 是否被覆盖（findToolDefinition 重放路径未跑到）。 */
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

/** 兼容 ESM/CJS 互操作：钻两层取到 factory。 */
const defaultExport = (extModule as { default?: unknown }).default;
const innerExport =
	defaultExport && typeof defaultExport === "object" && "default" in defaultExport
		? (defaultExport as { default?: unknown }).default
		: defaultExport;
const createLazyToolsExtension: (pi: never) => void =
	typeof innerExport === "function"
		? (innerExport as (pi: never) => void)
		: (extModule as never);

/** 重建临时工作区并写入配置，返回工作区路径。 */
function reInitWorkspace(residentNames: string[], options: BootOptions): string {
	const ws = mkdtempSync(join(tmpdir(), "lazy-tools-it-"));
	mkdirSync(join(ws, ".pi"));
	if (options.writeProjectConfig !== false) {
		writeFileSync(join(ws, ".pi", "lazy-tools.json"), JSON.stringify({ resident: residentNames }));
	}
	return ws;
}

/** 对已捕获的 session_start handlers 触发一次会话启动（共享同一扩展实例）。 */
async function fireSessionStartHandlers(
	sessionHandlers: SessionHandler[],
	notifyCalls: Array<{ text: string; options?: unknown }>,
	workspace: string,
	options: BootOptions,
): Promise<void> {
	const event: SessionEvent = {
		type: "session_start",
		reason: options.reason ?? "startup",
	};
	const ctx: {
		cwd: string;
		ui?: { notify?: (text: string, options?: unknown) => void };
	} = { cwd: workspace };
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
	for (const handler of sessionHandlers) {
		await handler(event, ctx);
	}
}

/**
 * Boot the real lazy-tools extension against a fake pi, capturing registered
 * tools and the session_start handler.
 */
function createHarness(): Harness {
	const registered: Array<Record<string, unknown>> = [];
	const sessionHandlers: SessionHandler[] = [];
	const beforeAgentStartHandlers: BeforeAgentStartHandler[] = [];
	const notifyCalls: Array<{ text: string; options?: unknown }> = [];
	let setActiveToolsCalls = 0;
	let lastActiveTools: string[] | undefined;
	let workspace: string | undefined;
	let userHome: string | undefined;

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
			else if (event === "before_agent_start")
				beforeAgentStartHandlers.push(handler as BeforeAgentStartHandler);
		},
		events: {
			on: (event: string) => {
				// 占位：无真实 pievents 使用
				void event;
			},
		},
	};

	createLazyToolsExtension(fakePi as never);

	const omnifyTool = registered.find((t) => t.name === "omnify");
	assert.ok(omnifyTool !== undefined, "extension should register omnify");
	// 四合一：load_tools / call_tool / skill_search 不再注册
	assert.ok(
		!registered.some((t) => ["load_tools", "call_tool", "skill_search"].includes(t.name as string)),
		"standalone load_tools / call_tool / skill_search must not be registered anymore",
	);

	return {
		async boot(residentNames: string[] = [], options: BootOptions = {}): Promise<void> {
			resetGlobalCounters();
			notifyCalls.length = 0;
			setActiveToolsCalls = 0;
			lastActiveTools = undefined;
			userHome = undefined;
			workspace = reInitWorkspace(residentNames, options);

			const originalHome = process.env.HOME;
			const originalProfile = process.env.USERPROFILE;
			let tempUserHome: string | undefined;
			if (options.freshUserHome) {
				tempUserHome = mkdtempSync(join(tmpdir(), "lazy-tools-home-"));
				process.env.HOME = tempUserHome;
				process.env.USERPROFILE = tempUserHome;
				userHome = tempUserHome;
			}

			try {
				await fireSessionStartHandlers(sessionHandlers, notifyCalls, workspace, options);
			} finally {
				if (tempUserHome !== undefined) {
					if (originalHome === undefined) delete process.env.HOME;
					else process.env.HOME = originalHome;
					if (originalProfile === undefined) delete process.env.USERPROFILE;
					else process.env.USERPROFILE = originalProfile;
					rmSync(tempUserHome, { recursive: true, force: true });
				}
			}
		},
		reboot(residentNames: string[] = [], options: BootOptions = {}): Promise<void> {
			// 与 boot 共享同一扩展实例（闭包缓存不重建），仅重新触发 session_start
			notifyCalls.length = 0;
			setActiveToolsCalls = 0;
			lastActiveTools = undefined;
			workspace = reInitWorkspace(residentNames, options);
			return fireSessionStartHandlers(sessionHandlers, notifyCalls, workspace, options);
		},
		cleanup(): void {
			if (workspace) rmSync(workspace, { recursive: true, force: true });
			workspace = undefined;
		},
		omnify(params: { goal: string; args?: unknown; tool?: string }): Promise<unknown> {
			const execute = omnifyTool!.execute as (
				id: unknown,
				params: { goal: string; args?: unknown; tool?: string },
				...rest: unknown[]
			) => Promise<unknown>;
			return execute(undefined, params, undefined, undefined, undefined);
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
		fireBeforeAgentStart(
			systemPromptOptions: unknown,
			systemPrompt = "",
		): { systemPrompt?: string } | undefined {
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
		fakeEventsOnCalls(): number {
			return 0;
		},
	};
}

/** 建立临时工作区 → 触发 session_start → 运行用例 → 清理。 */
async function withHarness<T>(
	residentNames: string[] | undefined,
	fn: (h: Harness) => Promise<T>,
	bootOptions: BootOptions = {},
): Promise<T> {
	const h = createHarness();
	try {
		await h.boot(residentNames, bootOptions);
		return await fn(h);
	} finally {
		h.cleanup();
	}
}

/** 捕获执行期间所有 console.warn 调用。 */
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

describe("omnify (四合一搜索调用)", () => {
	// O1: 无 args → schema-first：返候选工具参数要求，零执行副作用
	it("should return matching tools' param schemas without executing anything when args are omitted", async () => {
		await withHarness([], async (h) => {
			const result = (await h.omnify({ goal: FAKE_TOOL_NAME })) as {
				content: Array<{ type: string; text: string }>;
				details: { phase?: string; matched?: string[] };
			};
			const text = result.content.map((c) => c.text).join("\n");
			assert.ok(text.includes(FAKE_TOOL_NAME), `schema-first 应列出匹配工具; got: ${text}`);
			assert.ok(text.includes("action"), `应返回参数要求（含 action 字段）; got: ${text}`);
			assert.equal(result.details.phase, "need-args");
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 0, "schema-first 不得执行目标");
		});
	});

	// O2: 成功执行后再次无 args schema-first → 只返占位，不重复完整参数说明
	it("should show a short placeholder instead of the full spec for tools already used this session", async () => {
		await withHarness([], async (h) => {
			await h.omnify({ goal: FAKE_TOOL_NAME, args: { action: "discover" } });
			const result = (await h.omnify({ goal: FAKE_TOOL_NAME })) as {
				content: Array<{ type: string; text: string }>;
				details: { phase?: string };
			};
			const text = result.content.map((c) => c.text).join("\n");
			assert.ok(
				text.includes("已成功调用过"),
				`used tool should get a placeholder; got: ${text}`,
			);
			assert.ok(
				!/(action:|用途：)/.test(text),
				`placeholder must not repeat the full spec; got: ${text}`,
			);
			assert.equal(result.details.phase, "need-args");
		});
	});

	// O2b: 未成功过的工具重复 schema-first → 摘要缓存命中，输出一致
	it("should reuse the cached schema summary across repeated need-args calls", async () => {
		await withHarness([], async (h) => {
			const first = (await h.omnify({ goal: FAKE_TOOL_NAME })) as { content: Array<{ type: string; text: string }> };
			const second = (await h.omnify({ goal: FAKE_TOOL_NAME })) as { content: Array<{ type: string; text: string }> };
			assert.equal(
				second.content.map((c) => c.text).join("\n"),
				first.content.map((c) => c.text).join("\n"),
				"repeated need-args should return the identical cached summary",
			);
		});
	});

	// O2c: per-session 缓存（usedTools/摘要）随新 session_start 清空，不跨会话泄漏
	it("should reset usedTools and summary caches on a fresh session_start within the same instance", async () => {
	 await withHarness([], async (h) => {
		await h.omnify({ goal: FAKE_TOOL_NAME, args: { action: "discover" } });

		const placeholder = (await h.omnify({ goal: FAKE_TOOL_NAME })) as { content: Array<{ type: string; text: string }> };
		assert.ok(
			placeholder.content.map((c) => c.text).join("\n").includes("已成功调用过"),
			"post-use need-args should be a placeholder before the reboot",
		);

		// 同一扩展实例内新会话：usedTools/摘要缓存必须清空，否则跨会话误返占位
		await h.reboot();
		const fresh = (await h.omnify({ goal: FAKE_TOOL_NAME })) as { content: Array<{ type: string; text: string }> };
		const text = fresh.content.map((c) => c.text).join("\n");
		assert.ok(!text.includes("已成功调用过"), `fresh session must not reuse used-tool placeholder; got: ${text}`);
		assert.ok(text.includes("用途："), `fresh session should restore the full spec; got: ${text}`);

		// 新会话里目标工厂应重新重放（definitionCache 同样被清）——execute 仍可用
		const again = (await h.omnify({ goal: FAKE_TOOL_NAME, args: { action: "submit" } })) as RenderedResult;
		assert.match(again.content[0].text, /fake ran: submit/);
	 });
	});

	// O3: 显式 tool 指名 + args → 校验通过直接执行透传（自动激活，无前置 load）
	it("should invoke the target and pass through its result when tool is explicit and args valid", async () => {
		await withHarness([], async (h) => {
			const result = (await h.omnify({
				goal: "anything",
				tool: FAKE_TOOL_NAME,
				args: { action: "discover" },
			})) as RenderedResult;
			assert.match(result.content[0].text, /fake ran: discover/);
			assert.equal(result.details.executed, true);
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 1);
		});
	});

	// O3: goal 自动定位（英文工具名）→ 执行
	it("should auto-locate the tool by an exact-name goal and execute it", async () => {
		await withHarness([], async (h) => {
			const result = (await h.omnify({
				goal: FAKE_TOOL_NAME,
				args: { action: "submit" },
			})) as RenderedResult;
			assert.match(result.content[0].text, /fake ran: submit/);
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 1);
		});
	});

	// O4: 参数不合法 → 明细含字段路径，目标不执行
	it("should report invalid args with field-path errors and never execute the target", async () => {
		await withHarness([], async (h) => {
			const result = (await h.omnify({
				goal: "discover",
				tool: FAKE_TOOL_NAME,
				args: { action: "nope" },
			})) as { content: Array<{ type: string; text: string }> };
			const text = result.content.map((c) => c.text).join("\n");
			assert.ok(
				text.includes('action: expected one of [discover, submit], got "nope"'),
				`字段路径错误应透出; got: ${text}`,
			);
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 0, "目标 execute 不得运行");
		});
	});

	// O5: 明文指名不存在的工具 → 名录 + 明确提示，零执行
	it("should list available tools when an explicit tool does not exist", async () => {
		await withHarness([], async (h) => {
			const result = (await h.omnify({
				goal: "x",
				tool: "no_such_tool",
				args: { action: "discover" },
			})) as { content: Array<{ type: string; text: string }> };
			const text = result.content.map((c) => c.text).join("\n");
			assert.ok(text.includes("no_such_tool") && text.includes("不存在"), `应明确提示; got: ${text}`);
			assert.ok(text.includes(FAKE_TOOL_NAME), `名录应含可用工具; got: ${text}`);
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 0);
		});
	});

	// O6: findToolDefinition 应按 (sourcePath, name) memoize —— factory 只跑一次
	it("should replay the target factory only once across repeated omnify invocations", async () => {
		await withHarness([], async (h) => {
			await h.omnify({ goal: FAKE_TOOL_NAME, args: { action: "discover" } });
			await h.omnify({ goal: FAKE_TOOL_NAME, args: { action: "submit" } });
			assert.equal(
				globalCounter(FACTORY_CALLS_KEY),
				1,
				"target factory should run exactly once for repeated omnify of the same tool",
			);
		});
	});

	// O7: 指名 + 参数错 → 即返该工具要求（break），不代猜其他工具
	it("should stop at the explicitly-named tool instead of trying other candidates when its args are invalid", async () => {
		await withHarness([], async (h) => {
			const result = (await h.omnify({
				goal: "garbage-not-matching-anything",
				tool: FAKE_TOOL_NAME,
				args: { action: "nope" },
			})) as { details: { matched?: string[] } };
			assert.deepEqual(result.details.matched, [FAKE_TOOL_NAME], "指名场景只评估该工具");
			assert.equal(globalCounter(EXECUTE_CALLS_KEY), 0);
		});
	});
});

describe("omnify (技能检索分支)", () => {
	it("should strip the skills prompt section and let omnify surface SKILL.md paths", async () => {
		await withHarness([], async (h) => {
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
			assert.ok(
				!replaced.includes("<available_skills>"),
				`skills section should be stripped; got: ${replaced}`,
			);
			assert.ok(
				replaced.includes("omnify"),
				`note should point at omnify; got: ${replaced}`,
			);

			const active = h.getLastActiveTools();
			assert.ok(
				active?.includes("omnify"),
				`omnify should be in the initial active set; got: ${JSON.stringify(active)}`,
			);

			// 0.86+ 路径：改 sections.skills
			const sections = { skills: "<skills>\nold skill block\n</skills>" };
			const forced = h.fireBeforeAgentStart({ skills, sections }, basePrompt);
			assert.equal(forced, undefined, "sections path must not return a forced system prompt");
			assert.ok(
				sections.skills.includes("omnify"),
				`sections.skills should be replaced by the note; got: ${sections.skills}`,
			);
		});
	});

	it("should surface a matching SKILL.md path when no tool matches the goal", async () => {
		await withHarness([], async (h) => {
			// 触发 before_agent_start 收集技能
			h.fireBeforeAgentStart(
				{
					skills: [
						{ name: "foo-skill", description: "Foo helpers", filePath: "/skills/foo/SKILL.md" },
					],
				},
				"prompt",
			);
			const result = (await h.omnify({ goal: "foo helpers 专业技能" })) as {
				content: Array<{ type: string; text: string }>;
			};
			const text = result.content.map((c) => c.text).join("\n");
			assert.ok(
				text.includes("/skills/foo/SKILL.md"),
				`omnify 应返回匹配技能的 SKILL.md 路径; got: ${text}`,
			);
		});
	});
});

describe("lazy-tools startup notice (session_start)", () => {
	// C1: boot 后恰好通知一次；名单 + 生效配置路径
	it("should notify the tool list and the effective project config path once on session_start", async () => {
		await withHarness([], async (h) => {
			const calls = h.getNotifyCalls();
			assert.equal(calls.length, 1, "session_start should call ctx.ui.notify exactly once");

			const text = calls[0].text;
			assert.ok(text.includes("当前 lazy 工具名单："), `notice should have the list header; got: ${text}`);
			assert.ok(text.includes(FAKE_TOOL_NAME), `notice should list ${FAKE_TOOL_NAME}; got: ${text}`);
			// omnify 常驻，不入 lazy 名单
			assert.ok(!text.includes("omnify"), `resident omnify must not appear in the lazy list; got: ${text}`);

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
			assert.ok(
				h.getSetActiveToolsCalls() > 0,
				"session_start should always run setActiveTools",
			);
		});
	});

	it("should keep configured resident tools out of the lazy list", async () => {
		await withHarness([FAKE_TOOL_NAME], async (h) => {
			const text = h.getNotifyCalls()[0].text;
			assert.ok(
				!text.includes(FAKE_TOOL_NAME),
				`resident tool must be excluded from the lazy list; got: ${text}`,
			);
			assert.ok(text.includes("（空）"), `resident-only roster renders empty; got: ${text}`);
		});
	});

	it("should skip notify for non-startup reasons but still run setActiveTools", async () => {
		const reasons: SessionReason[] = ["new", "resume", "fork", "reload"];
		for (const reason of reasons) {
			await withHarness([], async (h) => {
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

	it("should notify the no-config notice when neither user nor project config exists", async () => {
		await withHarness([], async (h) => {
			const calls = h.getNotifyCalls();
			assert.equal(calls.length, 1, "session_start should notify once even without any config");

			const text = calls[0].text;
			const workspacePath = h.getWorkspacePath();
			const userHomePath = h.getUserHomePath();
			assert.ok(workspacePath, "harness should own a temp workspace");
			assert.ok(userHomePath, "harness should own a temp user home");

			assert.ok(text.includes(FAKE_TOOL_NAME), `default roster should list ${FAKE_TOOL_NAME}; got: ${text}`);
			assert.ok(
				text.includes("当前暂无配置文件："),
				`notice should mark no-config; got: ${text}`,
			);
			assert.ok(
				text.includes("\n\n以上两个文件均不存在"),
				`notice should end with the both-missing line; got: ${JSON.stringify(text)}`,
			);
		}, { writeProjectConfig: false, freshUserHome: true });
	});

	it("should skip notify silently when the session ctx has no ui", async () => {
		const warnings = await captureWarnings(async () => {
			await withHarness([], async (h) => {
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

	it("should still run setActiveTools when ctx.ui.notify throws", async () => {
		let notifyAttempts = 0;
		const warnings = await captureWarnings(async () => {
			await withHarness([], async (h) => {
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

describe("omnify registration copy", () => {
	it("should register omnify with substantive copy mentioning search, args, and fallback", async () => {
		await withHarness([], async (h) => {
			const tool = h.getRegisteredTool("omnify");
			assert.ok(tool !== undefined, "omnify should be registered");
			const description = tool.description as string;
			const guidelines = (tool.promptGuidelines as string[] | undefined) ?? [];
			assert.ok(description.trim().length >= 40, `description must be substantive; got: ${JSON.stringify(description)}`);
			assert.ok(
				description.includes("goal") && description.includes("args"),
				`description must teach goal/args usage; got: ${description}`,
			);
			assert.ok(guidelines.length > 0, "omnify must have promptGuidelines");
		});
	});

	it("should not mention any lazily-registered tool by name in the registration copy", async () => {
		await withHarness([], async (h) => {
			const tool = h.getRegisteredTool("omnify");
			const copy = [
				tool!.description,
				tool!.promptSnippet,
				...(tool!.promptGuidelines as string[] | undefined) ?? [],
			].join("\n").toLowerCase();
			assert.ok(
				!copy.includes(FAKE_TOOL_NAME.toLowerCase()),
				`omnify registration copy must not hardcode local tool names; got: ${copy}`,
			);
		});
	});
});