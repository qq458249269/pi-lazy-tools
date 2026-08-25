/**
 * Unit tests for the lazy-tools pure logic layer.
 *
 * Target module:
 *   /Users/liuyu/pi-workspace/pi-lazy-tools/lazy-tools/core.ts
 *
 * Contract under test (no pi runtime, no typebox imports):
 *   mergeLazyConfigs(userCfg, projectCfg)                -> { lazy: string[] }
 *   filterAllowedTools(requested, whitelist)             -> { allowed, rejected }
 *   validateParams(schema, params)                       -> { ok, errors }
 *   canCall(tool, whitelist, activatedSet)               -> { ok, reason }
 *   buildStartupNotice(input)                            -> string
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	mergeLazyConfigs,
	filterAllowedTools,
	validateParams,
	canCall,
	selectEffectiveConfigPath,
	buildStartupNotice,
	buildLoadChallenge,
	StartupNoticeInput,
	LoadChallengeInput,
} from "../lazy-tools/core.ts";

// ===== Shared fixtures =====

const OPENAAAS_ACTIONS = [
	"discover",
	"set_server_url",
	"register",
	"update_profile",
	"list_services",
	"get_service_usage",
	"list_history",
	"submit_task",
	"get_task",
	"cancel_task",
	"list_files",
	"download_result",
	"list_servers",
	"set_default_server",
	"remove_server",
] as const;

/**
 * OpenAaaS 风格参数形态（增强版）：必填 enum action + 多个可选 string/boolean/string[] 字段。
 * 说明：显式 additionalProperties:false 属增强约束——真实 TypeBox 输出不带 additionalProperties
 * 字段，多余字段默认放行（见"无 additionalProperties 时多余字段放行"用例）。
 */
const openaaasSchema = {
	type: "object",
	properties: {
		action: { type: "string", enum: [...OPENAAAS_ACTIONS] },
		server: { type: "string" },
		server_url: { type: "string" },
		name: { type: "string" },
		task_id: { type: "string" },
		service_id: { type: "string" },
		task_prompt: { type: "string" },
		output_prompt: { type: "string" },
		session_id: { type: "string" },
		file_id: { type: "string" },
		download_all: { type: "boolean" },
		input_files: { type: "array", items: { type: "string" } },
	},
	required: ["action"],
	additionalProperties: false,
};

const UUID_V7 = "0192c9e8-8c5a-7c10-8f2a-3b4c5d6e7f80";
const UUID_V7_RE = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/**
 * revive_subagent 风格（增强版）：两个必填 string，sessionId 追加 pattern。
 * 说明：真实 revive_subagent 的 TypeBox schema 无 pattern 字段（见 reviveSchema），
 * 此处的 pattern 用于验证校验器的 pattern 能力。
 */
const reviveSchemaWithPattern = {
	type: "object",
	properties: {
		sessionId: { type: "string", pattern: UUID_V7_RE },
		agentName: { type: "string" },
	},
	required: ["sessionId", "agentName"],
};

/** 同形态但不带 pattern，验证 pattern 关键字可选。 */
const reviveSchema = {
	type: "object",
	properties: {
		sessionId: { type: "string" },
		agentName: { type: "string" },
	},
	required: ["sessionId", "agentName"],
};

/** 断言校验失败且错误文本包含所有给定片段（字段路径/期望值/实际值）。 */
function expectErrors(result: { ok: boolean; errors: string[] }, ...fragments: string[]): void {
	assert.equal(result.ok, false, `expected validation to fail; got ${JSON.stringify(result)}`);
	assert.ok(result.errors.length > 0, "expected at least one error message");
	const text = result.errors.join("\n");
	for (const fragment of fragments) {
		assert.ok(
			text.includes(fragment),
			`error text should include ${JSON.stringify(fragment)}; got: ${text}`,
		);
	}
}

// ===== mergeLazyConfigs =====

describe("mergeLazyConfigs", () => {
	it("should return { lazy: [] } when both configs are null (missing/corrupt files)", () => {
		assert.deepEqual(mergeLazyConfigs(null, null), { lazy: [] });
	});

	it("should fall back to user config when project config is null", () => {
		assert.deepEqual(mergeLazyConfigs({ lazy: ["a", "b"] }, null), { lazy: ["a", "b"] });
	});

	it("should fall back to user config when project config has no lazy array", () => {
		assert.deepEqual(mergeLazyConfigs({ lazy: ["a"] }, { other: 1 }), { lazy: ["a"] });
	});

	it("should replace user config entirely when project config has a lazy array", () => {
		assert.deepEqual(mergeLazyConfigs({ lazy: ["a"] }, { lazy: ["p1", "p2"] }), {
			lazy: ["p1", "p2"],
		});
	});

	it("should treat an empty lazy array in project config as an explicit replace", () => {
		assert.deepEqual(mergeLazyConfigs({ lazy: ["a"] }, { lazy: [] }), { lazy: [] });
	});

	it("should accept an empty lazy array in user config when project is null", () => {
		assert.deepEqual(mergeLazyConfigs({ lazy: [] }, null), { lazy: [] });
	});

	it("should treat a non-array lazy field as absent and fall back to user config", () => {
		assert.deepEqual(mergeLazyConfigs({ lazy: ["a"] }, { lazy: "oops" }), { lazy: ["a"] });
	});

	it("should filter non-string entries out of the lazy array", () => {
		const project = { lazy: ["a", 1, null, true, "b", { x: 1 }] };
		assert.deepEqual(mergeLazyConfigs(null, project), { lazy: ["a", "b"] });
	});

	it("should return { lazy: [] } when neither config has a valid lazy array", () => {
		assert.deepEqual(mergeLazyConfigs({ lazy: 42 }, { other: "x" }), { lazy: [] });
	});

	it("should return { lazy: [] } for empty config objects", () => {
		assert.deepEqual(mergeLazyConfigs({}, {}), { lazy: [] });
	});
});

// ===== filterAllowedTools =====

describe("filterAllowedTools", () => {
	it("should split requested tools into allowed and rejected by whitelist membership", () => {
		assert.deepEqual(
			filterAllowedTools(["load_tools", "revive_subagent", "call_tool"], ["load_tools", "call_tool"]),
			{ allowed: ["load_tools", "call_tool"], rejected: ["revive_subagent"] },
		);
	});

	it("should reject everything when the whitelist is empty", () => {
		assert.deepEqual(filterAllowedTools(["a", "b"], []), { allowed: [], rejected: ["a", "b"] });
	});

	it("should return empty lists for an empty request", () => {
		assert.deepEqual(filterAllowedTools([], ["a"]), { allowed: [], rejected: [] });
	});

	it("should dedupe requested tools preserving first-seen order", () => {
		assert.deepEqual(filterAllowedTools(["a", "b", "a", "c", "b"], ["a", "b"]), {
			allowed: ["a", "b"],
			rejected: ["c"],
		});
	});

	it("should ignore non-string entries in requested and whitelist", () => {
		assert.deepEqual(filterAllowedTools(["a", 1, null] as string[], ["a", 42] as string[]), {
			allowed: ["a"],
			rejected: [],
		});
	});
});

// ===== validateParams: OpenAaaS-style schema =====

describe("validateParams (OpenAaaS-style schema)", () => {
	it("should accept a minimal valid params with only action", () => {
		assert.deepEqual(validateParams(openaaasSchema, { action: "discover" }), {
			ok: true,
			errors: [],
		});
	});

	it("should accept representative enum values (first, middle, last)", () => {
		assert.equal(validateParams(openaaasSchema, { action: "discover" }).ok, true);
		assert.equal(validateParams(openaaasSchema, { action: "submit_task" }).ok, true);
		assert.equal(validateParams(openaaasSchema, { action: "remove_server" }).ok, true);
	});

	it("should accept all optional fields with their declared types", () => {
		const params = {
			action: "submit_task",
			server: "prod",
			server_url: "https://api.example.com",
			name: "tester",
			task_id: "t-1",
			service_id: "s-1",
			task_prompt: "请总结一下",
			output_prompt: "用中文回答",
			session_id: "sess-1",
			file_id: "f-1",
			download_all: true,
			input_files: ["a.py", "b.py"],
		};
		assert.deepEqual(validateParams(openaaasSchema, params), { ok: true, errors: [] });
	});

	it("should accept an empty input_files array", () => {
		assert.equal(
			validateParams(openaaasSchema, { action: "list_files", input_files: [] }).ok,
			true,
		);
	});

	it("should reject when required action is missing", () => {
		const result = validateParams(openaaasSchema, { download_all: true });
		expectErrors(result, "action", "required");
	});

	it("should reject an enum out-of-range value with path, expected and actual", () => {
		const result = validateParams(openaaasSchema, { action: "foo" });
		expectErrors(result, "action: expected one of [discover", 'got "foo"');
	});

	it("should reject a non-string action", () => {
		const result = validateParams(openaaasSchema, { action: 42 });
		expectErrors(result, "action", "string");
	});

	it("should reject download_all with a non-boolean value", () => {
		const result = validateParams(openaaasSchema, { action: "discover", download_all: "yes" });
		expectErrors(result, "download_all", "boolean");
	});

	it("should reject input_files that is not an array", () => {
		const result = validateParams(openaaasSchema, { action: "submit_task", input_files: "a.py" });
		expectErrors(result, "input_files", "array");
	});

	it("should reject an array item of the wrong type with an indexed path", () => {
		const result = validateParams(openaaasSchema, {
			action: "submit_task",
			input_files: ["a.py", 42],
		});
		expectErrors(result, "input_files[1]", "string");
	});

	it("should reject non-object params (string, array, null, undefined)", () => {
		assert.equal(validateParams(openaaasSchema, "discover").ok, false);
		assert.equal(validateParams(openaaasSchema, ["a"]).ok, false);
		assert.equal(validateParams(openaaasSchema, null).ok, false);
		assert.equal(validateParams(openaaasSchema, undefined).ok, false);
	});

	it("should reject extra properties when additionalProperties is false", () => {
		const result = validateParams(openaaasSchema, { action: "discover", extra_field: true });
		expectErrors(result, "extra_field");
	});

	it("should validate a nested object property and prefix its error paths", () => {
		const schema = {
			type: "object",
			properties: {
				action: { type: "string" },
				options: {
					type: "object",
					properties: { verbose: { type: "boolean" } },
					required: ["verbose"],
				},
			},
			required: ["action"],
		};
		assert.equal(validateParams(schema, { action: "x", options: { verbose: true } }).ok, true);
		expectErrors(validateParams(schema, { action: "x", options: {} }), "options.verbose", "required");
		expectErrors(
			validateParams(schema, { action: "x", options: { verbose: "yes" } }),
			"options.verbose",
			"boolean",
		);
	});
});

// ===== validateParams: revive_subagent-style schema =====

describe("validateParams (revive_subagent-style schema)", () => {
	it("should accept valid sessionId and agentName", () => {
		assert.deepEqual(validateParams(reviveSchema, { sessionId: UUID_V7, agentName: "coder" }), {
			ok: true,
			errors: [],
		});
	});

	it("should accept a valid UUID v7 sessionId when the schema has a pattern", () => {
		assert.deepEqual(
			validateParams(reviveSchemaWithPattern, { sessionId: UUID_V7, agentName: "coder" }),
			{ ok: true, errors: [] },
		);
	});

	it("should reject when required sessionId is missing", () => {
		const result = validateParams(reviveSchema, { agentName: "coder" });
		expectErrors(result, "sessionId", "required");
	});

	it("should reject when required agentName is missing", () => {
		const result = validateParams(reviveSchema, { sessionId: UUID_V7 });
		expectErrors(result, "agentName", "required");
	});

	it("should reject a non-string agentName", () => {
		const result = validateParams(reviveSchema, { sessionId: UUID_V7, agentName: 42 });
		expectErrors(result, "agentName", "string");
	});

	it("should reject a non-string sessionId", () => {
		const result = validateParams(reviveSchema, { sessionId: 42, agentName: "coder" });
		expectErrors(result, "sessionId", "string");
	});

	it("should reject a sessionId that fails the schema pattern", () => {
		const result = validateParams(reviveSchemaWithPattern, {
			sessionId: "not-a-uuid",
			agentName: "coder",
		});
		expectErrors(result, "sessionId");
	});

	it("should accept any string sessionId when the schema has no pattern", () => {
		assert.equal(
			validateParams(reviveSchema, { sessionId: "not-a-uuid", agentName: "coder" }).ok,
			true,
		);
	});
});

// ===== validateParams: review-driven regressions（第二轮审查问题） =====

describe("validateParams (review-driven regressions)", () => {
	// A1: 非法 pattern 不得抛 SyntaxError
	it("should not crash on an invalid regex pattern and report it as a validation error", () => {
		let result: { ok: boolean; errors: string[] } | undefined;
		assert.doesNotThrow(() => {
			result = validateParams({ type: "string", pattern: "(" }, "abc");
		});
		assert.equal(result?.ok, false);
		assert.ok(
			(result?.errors ?? []).some((e) => e.includes("pattern")),
			`error should mention the invalid pattern; got: ${JSON.stringify(result)}`,
		);
	});

	// A2: 无显式 type 的 object schema 仍应校验 required/properties
	it("should enforce required and properties on object schemas without an explicit type", () => {
		const schema = { required: ["action"], properties: { action: { type: "string" } } };
		expectErrors(validateParams(schema, {}), "action", "required");
		assert.equal(validateParams(schema, { action: "x" }).ok, true);
	});

	// A3: 无 additionalProperties 时多余字段放行（真实 TypeBox 输出形态）
	it("should allow undeclared properties when additionalProperties is absent", () => {
		assert.equal(
			validateParams({ type: "object", properties: { a: { type: "string" } } }, { a: "x", extra: 1 }).ok,
			true,
		);
	});

	// A4: __proto__ 键（JSON.parse 产物）应视为多余字段而非命中原型链
	it("should treat a __proto__ key parsed from JSON as an extra property when additionalProperties is false", () => {
		const params = JSON.parse('{"action":"discover","__proto__":{"x":1}}') as Record<string, unknown>;
		expectErrors(validateParams(openaaasSchema, params), "__proto__");
	});

	// A5: required 错误应包含实际值
	it("should include the actual value in required-field error messages", () => {
		expectErrors(validateParams(openaaasSchema, {}), "action: required, got undefined");
	});
});

// ===== canCall =====

describe("canCall", () => {
	it("should allow a tool that is whitelisted and activated", () => {
		const result = canCall("revive_subagent", ["revive_subagent"], new Set(["revive_subagent"]));
		assert.equal(result.ok, true);
	});

	it("should reject a tool not in the whitelist even when already activated", () => {
		const result = canCall("evil", ["revive_subagent"], new Set(["evil"]));
		assert.equal(result.ok, false);
		assert.match(result.reason, /lazy 名单/);
	});

	it("should reject a whitelisted tool that has not been activated", () => {
		const result = canCall("revive_subagent", ["revive_subagent"], new Set());
		assert.equal(result.ok, false);
		assert.match(result.reason, /激活/);
		assert.match(result.reason, /confirm: true/, "未激活提示应包含新调用形状 confirm: true");
	});

	it("should reject a tool neither whitelisted nor activated", () => {
		const result = canCall("evil", ["good"], new Set(["other"]));
		assert.equal(result.ok, false);
		assert.match(result.reason, /lazy 名单/);
	});

	it("should reject an empty tool name", () => {
		const result = canCall("", ["revive_subagent"], new Set(["revive_subagent"]));
		assert.equal(result.ok, false);
	});
});

// ===== selectEffectiveConfigPath（新契约） =====

describe("selectEffectiveConfigPath", () => {
	const USER_PATH = "/home/tester/.pi/lazy-tools.json";
	const PROJECT_PATH = "/work/demo/.pi/lazy-tools.json";

	// 项目级含有效 lazy 数组（非空）→ 项目级，即使用户级同样有效
	it("should pick the project path when the project config has a non-empty lazy array", () => {
		assert.equal(
			selectEffectiveConfigPath({ lazy: ["u"] }, { lazy: ["p1", "p2"] }, USER_PATH, PROJECT_PATH),
			PROJECT_PATH,
		);
	});

	// 项目级空数组 → 仍算有效（显式覆盖用户级），返回项目级
	it("should pick the project path when the project config has an empty lazy array", () => {
		assert.equal(
			selectEffectiveConfigPath({ lazy: ["u"] }, { lazy: [] }, USER_PATH, PROJECT_PATH),
			PROJECT_PATH,
		);
	});

	// 项目级 lazy 非数组 → 视为无效，回退用户级
	it("should fall back to the user path when the project lazy field is not an array", () => {
		assert.equal(
			selectEffectiveConfigPath({ lazy: ["u"] }, { lazy: "oops" }, USER_PATH, PROJECT_PATH),
			USER_PATH,
		);
	});

	// 项目级缺失（null）→ 回退用户级
	it("should fall back to the user path when the project config is missing", () => {
		assert.equal(
			selectEffectiveConfigPath({ lazy: ["u"] }, null, USER_PATH, PROJECT_PATH),
			USER_PATH,
		);
	});

	// 非字符串项被过滤但不影响数组本身的有效性（与 mergeLazyConfigs 同源）
	it("should still treat the project array as valid when it contains non-string entries", () => {
		const project = { lazy: ["p", 1, null, true, { x: 1 }] };
		assert.equal(
			selectEffectiveConfigPath({ lazy: ["u"] }, project, USER_PATH, PROJECT_PATH),
			PROJECT_PATH,
		);
	});

	// 两者皆无有效 lazy 数组 → null
	it("should return null when neither config has a valid lazy array", () => {
		assert.equal(
			selectEffectiveConfigPath({ lazy: 42 }, { other: "x" }, USER_PATH, PROJECT_PATH),
			null,
		);
	});

	// 两者全空/缺失 → null（与 mergeLazyConfigs 返回 { lazy: [] } 的语义同源）
	it("should return null when both configs are null or empty", () => {
		assert.equal(selectEffectiveConfigPath(null, null, USER_PATH, PROJECT_PATH), null);
		assert.equal(selectEffectiveConfigPath({}, {}, USER_PATH, PROJECT_PATH), null);
	});
});

// ===== buildStartupNotice（新契约） =====

describe("buildStartupNotice (新契约)", () => {
	const USER_PATH = "/home/tester/.pi/lazy-tools.json";
	const PROJECT_PATH = "/work/demo/.pi/lazy-tools.json";

	function makeInput(overrides: Partial<StartupNoticeInput> = {}): StartupNoticeInput {
		return {
			toolNames: ["revive_subagent"],
			userConfigPath: USER_PATH,
			projectConfigPath: PROJECT_PATH,
			effectiveConfigPath: PROJECT_PATH,
			...overrides,
		};
	}

	// 情况一（effectiveConfigPath 非 null）：名单 + 空行 + 「当前生效的配置文件为：」+ 生效路径
	it("should state the effective config path after the tool list when a config is effective", () => {
		const text = buildStartupNotice(makeInput());

		assert.ok(text.includes("当前 lazy 工具名单："), `notice should have the list header; got: ${text}`);
		assert.ok(text.includes("- revive_subagent"), `notice should list the tool; got: ${text}`);
		assert.ok(
			text.includes("\n\n"),
			`notice should separate the list and the config line with a blank line; got: ${JSON.stringify(text)}`,
		);
		assert.ok(
			text.includes("当前生效的配置文件为："),
			`notice should mark the effective config; got: ${text}`,
		);
		assert.ok(text.includes(PROJECT_PATH), `notice should mention the effective path; got: ${text}`);
	});

	// 情况一：多工具 → 每个工具名逐行列出
	it("should list every tool name on its own line when multiple tools are effective", () => {
		const text = buildStartupNotice(
			makeInput({ toolNames: ["revive_subagent", "openaas", "git_mirror"] }),
		);

		assert.ok(text.includes("- revive_subagent"), `notice should list revive_subagent; got: ${text}`);
		assert.ok(text.includes("- openaas"), `notice should list openaas; got: ${text}`);
		assert.ok(text.includes("- git_mirror"), `notice should list git_mirror; got: ${text}`);
		assert.ok(
			text.includes("当前生效的配置文件为："),
			`notice should mark the effective config; got: ${text}`,
		);
		assert.ok(text.includes(PROJECT_PATH), `notice should mention the effective path; got: ${text}`);
	});

	// 情况一：空名单 → （空）标注，不列任何工具名
	it("should mark an empty tool list with （空） when a config is effective", () => {
		const text = buildStartupNotice(makeInput({ toolNames: [] }));

		assert.ok(text.includes("（空）"), `notice should mark the empty list; got: ${text}`);
		assert.ok(
			text.includes("当前生效的配置文件为："),
			`notice should still state the effective config; got: ${text}`,
		);
		assert.ok(text.includes(PROJECT_PATH), `notice should mention the effective path; got: ${text}`);
	});

	// 情况一：推翻旧契约的逐侧标注——只陈述生效路径，不列用户级/项目级位置
	it("should not mention the user/project config locations individually when a config is effective", () => {
		const text = buildStartupNotice(makeInput());

		assert.ok(
			!text.includes("用户级"),
			`case 1 must not list the user-level location; got: ${text}`,
		);
		assert.ok(
			!text.includes("项目级"),
			`case 1 must not list the project-level location; got: ${text}`,
		);
	});

	// 情况二（effectiveConfigPath 为 null）：双路径分别列出 + 空行 + 「以上两个文件均不存在」，名单为（空）
	it("should list both config locations and the both-missing notice when nothing is effective", () => {
		const text = buildStartupNotice(makeInput({ toolNames: [], effectiveConfigPath: null }));

		assert.ok(text.includes("（空）"), `notice should mark the empty list; got: ${text}`);
		assert.ok(
			text.includes("当前暂无配置文件："),
			`notice should mark no-config; got: ${text}`,
		);
		assert.ok(
			text.includes(`用户级：${USER_PATH}`),
			`notice should list the user-level path; got: ${text}`,
		);
		assert.ok(
			text.includes(`项目级：${PROJECT_PATH}`),
			`notice should list the project-level path; got: ${text}`,
		);
		assert.ok(
			text.includes("\n\n以上两个文件均不存在"),
			`notice should end with a blank line and the both-missing line; got: ${JSON.stringify(text)}`,
		);
	});

	// 情况二：无生效路径时不得出现「当前生效的配置文件为：」
	it("should not claim an effective config when the effective path is null", () => {
		const text = buildStartupNotice(makeInput({ toolNames: [], effectiveConfigPath: null }));

		assert.ok(
			!text.includes("当前生效的配置文件为："),
			`notice must not claim an effective config; got: ${text}`,
		);
	});

	// 措辞禁令：两种情况都不得包含「当前激活」「如需修改」「路径都没有找到」
	it("should never contain any banned phrasing (当前激活 / 如需修改 / 路径都没有找到)", () => {
		const case1 = buildStartupNotice(makeInput());
		const case2 = buildStartupNotice(makeInput({ toolNames: [], effectiveConfigPath: null }));

		for (const text of [case1, case2]) {
			assert.ok(!text.includes("当前激活"), `banned phrase 当前激活; got: ${text}`);
			assert.ok(!text.includes("如需修改"), `banned phrase 如需修改; got: ${text}`);
			assert.ok(!text.includes("路径都没有找到"), `banned phrase 路径都没有找到; got: ${text}`);
		}
	});
});

// ===== buildLoadChallenge（新契约：两步确认） =====

describe("buildLoadChallenge (新契约)", () => {
	// 列出所有工具名与描述（多项）
	it("should list every tool name with its description", () => {
		const text = buildLoadChallenge({
			toolNames: ["revive_subagent", "openaas"],
			toolDescriptions: {
				revive_subagent: "恢复/继续之前的 subagent 会话。",
				openaas: "向远程 OpenAaaS Agent 服务提交任务。",
			},
		});

		assert.ok(text.includes("revive_subagent"), `challenge 应列出 revive_subagent; got: ${text}`);
		assert.ok(text.includes("openaas"), `challenge 应列出 openaas; got: ${text}`);
		assert.ok(
			text.includes("恢复/继续之前的 subagent 会话。"),
			`challenge 应包含 revive_subagent 的 description; got: ${text}`,
		);
		assert.ok(
			text.includes("向远程 OpenAaaS Agent 服务提交任务。"),
			`challenge 应包含 openaas 的 description; got: ${text}`,
		);
	});

	// 包含"未加载任何工具/零副作用"声明语义
	it("should declare that nothing was loaded or activated (zero side effects)", () => {
		const text = buildLoadChallenge({
			toolNames: ["revive_subagent"],
			toolDescriptions: { revive_subagent: "恢复/继续之前的 subagent 会话。" },
		});

		assert.ok(
			text.includes("没有加载或激活任何工具") ||
				text.includes("未加载") ||
				text.includes("零副作用") ||
				text.includes("本次调用不会加载") ||
				text.includes("本次调用未加载"),
			`challenge 应明确声明本次调用未加载/激活任何工具（零副作用）; got: ${text}`,
		);
	});

	// 包含警告语义（激活 + call_tool 可调用）
	it("should warn that loaded tools become activated and callable via call_tool", () => {
		const text = buildLoadChallenge({
			toolNames: ["revive_subagent"],
			toolDescriptions: { revive_subagent: "恢复/继续之前的 subagent 会话。" },
		});

		assert.ok(text.includes("激活"), `challenge 应警告工具将被激活; got: ${text}`);
		assert.ok(text.includes("call_tool"), `challenge 应提示可通过 call_tool 调用; got: ${text}`);
	});

	// 包含第二次调用形状（"confirm: true" 与工具名）
	it("should spell out the exact second-call shape with confirm:true", () => {
		const text = buildLoadChallenge({
			toolNames: ["revive_subagent", "openaas"],
			toolDescriptions: {
				revive_subagent: "恢复/继续之前的 subagent 会话。",
				openaas: "向远程 OpenAaaS Agent 服务提交任务。",
			},
		});

		assert.ok(text.includes("confirm: true"), `challenge 应包含第二次调用形状 confirm: true; got: ${text}`);
		assert.ok(text.includes("revive_subagent"), `第二次调用形状应含工具名 revive_subagent; got: ${text}`);
		assert.ok(text.includes("openaas"), `第二次调用形状应含工具名 openaas; got: ${text}`);
	});

	// 描述缺失时标注未找到
	it("should mark tools without metadata as not found", () => {
		const text = buildLoadChallenge({
			toolNames: ["revive_subagent", "ghost_tool"],
			toolDescriptions: { revive_subagent: "恢复/继续之前的 subagent 会话。" },
		});

		assert.ok(text.includes("未找到工具元数据"), `challenge 应对缺失描述标注"未找到工具元数据"; got: ${text}`);
	});

	// 空描述映射时的表现
	it("should mark all tools as not found when the description map is empty", () => {
		const text = buildLoadChallenge({
			toolNames: ["revive_subagent", "openaas"],
			toolDescriptions: {},
		});

		assert.ok(text.includes("未找到工具元数据"), `challenge 应对所有工具标注"未找到工具元数据"; got: ${text}`);
	});

	// 新契约：挑战文本含「用户主动要求」提示（约束层：仅在用户主动要求时才加载工具）
	it("should include a user-explicitly-asks constraint in the challenge text", () => {
		const text = buildLoadChallenge({
			toolNames: ["revive_subagent"],
			toolDescriptions: { revive_subagent: "恢复/继续之前的 subagent 会话。" },
		});

		// 锁定的措辞：文本须同时含"用户"与"主动要求"（或"用户主动"）
		assert.ok(
			(text.includes("用户") && text.includes("主动要求")) || text.includes("用户主动"),
			`challenge 应含「仅在用户主动要求时才加载工具」类提示; got: ${text}`,
		);
	});

	// 零副作用再锁：challenge 文本不含 buildLoadResult 专属前缀「已加载」
	it("should not include the buildLoadResult prefix （已加载） in the challenge text", () => {
		const text = buildLoadChallenge({
			toolNames: ["revive_subagent"],
			toolDescriptions: { revive_subagent: "恢复/继续之前的 subagent 会话。" },
		});

		assert.ok(
			!text.includes("已加载"),
			`challenge 分支不得拼使用说明正文（不得含"已加载"前缀）; got: ${text}`,
		);
	});
});
