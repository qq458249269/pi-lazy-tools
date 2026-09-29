/**
 * Unit tests for the lazy-tools pure logic layer.
 *
 * Target module:
 *   /Users/liuyu/pi-workspace/pi-lazy-tools/lazy-tools/core.ts
 *
 * Contract under test (no pi runtime, no typebox imports):
 *   resolveDefaultTools(candidates, fallback?)     -> { resident, path }
 *   validateParams(schema, params)                       -> { ok, errors }
 *   buildStartupNotice(input)                            -> string
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	resolveDefaultTools,
	validateParams,
	buildStartupNotice,
	rankToolMatches,
	PI_BUILTIN_DEFAULT_TOOLS,
	nonLoadableSourceReason,
	StartupNoticeInput,
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

// ===== resolveDefaultTools =====

describe("resolveDefaultTools", () => {
	const PROJECT = "/work/demo/.pi/settings.json";
	const USER = "/home/tester/.pi/agent/settings.json";

	it("should fall back to pi's builtin defaults when no candidate has defaultTools", () => {
		assert.deepEqual(resolveDefaultTools([{ path: PROJECT, defaultTools: undefined }]), {
			resident: [...PI_BUILTIN_DEFAULT_TOOLS],
			path: null,
		});
	});

	it("should fall back to pi's builtin defaults when there are no candidates at all", () => {
		assert.deepEqual(resolveDefaultTools([]), {
			resident: ["read", "bash", "edit", "write"],
			path: null,
		});
	});

	it("should honour an explicit fallback argument", () => {
		assert.deepEqual(resolveDefaultTools([], []), { resident: [], path: null });
	});

	it("should use the first candidate that carries a valid defaultTools array", () => {
		assert.deepEqual(
			resolveDefaultTools([
				{ path: PROJECT, defaultTools: ["p1", "p2"] },
				{ path: USER, defaultTools: ["u"] },
			]),
			{ resident: ["p1", "p2"], path: PROJECT },
		);
	});

	it("should use the user candidate when the project one has no defaultTools", () => {
		assert.deepEqual(
			resolveDefaultTools([
				{ path: PROJECT, defaultTools: undefined },
				{ path: USER, defaultTools: ["u"] },
			]),
			{ resident: ["u"], path: USER },
		);
	});

	it("should treat an empty array as an explicit 'everything is lazy' value", () => {
		assert.deepEqual(
			resolveDefaultTools([
				{ path: PROJECT, defaultTools: [] },
				{ path: USER, defaultTools: ["u"] },
			]),
			{ resident: [], path: PROJECT },
		);
	});

	it("should treat a non-array defaultTools as absent and keep looking", () => {
		assert.deepEqual(
			resolveDefaultTools([
				{ path: PROJECT, defaultTools: "oops" },
				{ path: USER, defaultTools: ["u"] },
			]),
			{ resident: ["u"], path: USER },
		);
		assert.deepEqual(
			resolveDefaultTools([
				{ path: PROJECT, defaultTools: 42 },
				{ path: USER, defaultTools: null },
			]),
			{ resident: [...PI_BUILTIN_DEFAULT_TOOLS], path: null },
		);
	});

	it("should filter non-string entries and drop duplicates", () => {
		assert.deepEqual(
			resolveDefaultTools([
				{ path: PROJECT, defaultTools: ["a", 1, null, true, "b", { x: 1 }, "a"] },
			]),
			{ resident: ["a", "b"], path: PROJECT },
		);
	});
});

// ===== filterAllowedTools =====

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

// ===== buildStartupNotice（新契约） =====

describe("buildStartupNotice (新契约)", () => {
	const USER_PATH = "/home/tester/.pi/agent/settings.json";
	const PROJECT_PATH = "/work/demo/.pi/settings.json";

	function makeInput(overrides: Partial<StartupNoticeInput> = {}): StartupNoticeInput {
		return {
			toolNames: ["revive_subagent"],
			resident: ["read", "bash"],
			sourcePath: PROJECT_PATH,
			userSettingsPath: USER_PATH,
			projectSettingsPath: PROJECT_PATH,
			...overrides,
		};
	}

	// 情况一（sourcePath 非 null）：lazy 名单 + 常驻名单 + 「当前生效的配置文件为：」+ 生效路径
	it("should state the effective settings path after the lists when defaultTools is configured", () => {
		const text = buildStartupNotice(makeInput());

		assert.ok(text.includes("当前 lazy 工具名单："), `notice should have the list header; got: ${text}`);
		assert.ok(text.includes("- revive_subagent"), `notice should list the tool; got: ${text}`);
		assert.ok(
			text.includes("当前常驻名单（settings.json 的 defaultTools）："),
			`notice should have the resident header; got: ${text}`,
		);
		assert.ok(text.includes("- read"), `notice should list resident tools; got: ${text}`);
		assert.ok(text.includes("- bash"), `notice should list resident tools; got: ${text}`);
		assert.ok(
			text.includes("\n\n"),
			`notice should separate blocks with blank lines; got: ${JSON.stringify(text)}`,
		);
		assert.ok(
			text.includes("当前生效的配置文件为："),
			`notice should mark the effective config; got: ${text}`,
		);
		assert.ok(text.includes(PROJECT_PATH), `notice should mention the effective path; got: ${text}`);
	});

	// 情况一：多工具 → 每个工具名逐行列出
	it("should list every tool name on its own line when multiple tools are lazy", () => {
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

	// 情况一：空 lazy 名单 → （空）标注
	it("should mark an empty tool list with （空）", () => {
		const text = buildStartupNotice(makeInput({ toolNames: [] }));

		assert.ok(text.includes("（空）"), `notice should mark the empty list; got: ${text}`);
		assert.ok(
			text.includes("当前生效的配置文件为："),
			`notice should still state the effective config; got: ${text}`,
		);
	});

	// 空常驻名单（defaultTools: []）→ 说明「除 omnify 外全部按需加载」
	it("should spell out the fully-lazy meaning when the resident list is empty", () => {
		const text = buildStartupNotice(makeInput({ resident: [] }));

		assert.ok(
			text.includes("（空：除 omnify 外全部按需加载）"),
			`empty resident list should be explained; got: ${text}`,
		);
	});

	// 情况一：只陈述生效路径，不列用户级/项目级位置
	it("should not mention the user/project settings locations individually when a config is effective", () => {
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

	// 情况二（sourcePath 为 null）：说明取 pi 内置默认 + 双路径配置位置
	it("should list both settings locations and the pi-default notice when defaultTools is absent", () => {
		const text = buildStartupNotice(
			makeInput({ toolNames: [], resident: ["read", "bash", "edit", "write"], sourcePath: null }),
		);

		assert.ok(text.includes("（空）"), `notice should mark the empty list; got: ${text}`);
		assert.ok(
			text.includes("当前未配置 defaultTools，取 pi 内置默认。配置位置："),
			`notice should mark the pi-default fallback; got: ${text}`,
		);
		assert.ok(
			text.includes(`用户级：${USER_PATH}`),
			`notice should list the user-level path; got: ${text}`,
		);
		assert.ok(
			text.includes(`项目级：${PROJECT_PATH}`),
			`notice should list the project-level path; got: ${text}`,
		);
	});

	// 情况二：不得出现「当前生效的配置文件为：」
	it("should not claim an effective config when no defaultTools is configured", () => {
		const text = buildStartupNotice(makeInput({ sourcePath: null }));

		assert.ok(
			!text.includes("当前生效的配置文件为："),
			`notice must not claim an effective config; got: ${text}`,
		);
	});

	// 措辞禁令：两种情况都不得包含「当前激活」「如需修改」「路径都没有找到」
	it("should never contain any banned phrasing (当前激活 / 如需修改 / 路径都没有找到)", () => {
		const case1 = buildStartupNotice(makeInput());
		const case2 = buildStartupNotice(makeInput({ sourcePath: null }));

		for (const text of [case1, case2]) {
			assert.ok(!text.includes("当前激活"), `banned phrase 当前激活; got: ${text}`);
			assert.ok(!text.includes("如需修改"), `banned phrase 如需修改; got: ${text}`);
			assert.ok(!text.includes("路径都没有找到"), `banned phrase 路径都没有找到; got: ${text}`);
		}
	});
});

// ===== buildLoadChallenge（新契约：两步确认） =====

// ===== rankToolMatches（omnify 候选定位） =====

describe("rankToolMatches", () => {
	const TOOLS = [
		{ name: "fake_discover", description: "Fake discover tool for tests (OpenAaaS-like)." },
		{ name: "load_proxy", description: "载入 lazy 工具之使用说明" },
		{ name: "tool_caller", description: "调用已激活之 lazy 工具" },
	];

	it("should rank an exact tool-name goal first", () => {
		const hits = rankToolMatches("fake_discover", TOOLS);
		assert.equal(hits[0], "fake_discover");
		assert.ok(hits.length >= 1);
	});

	it("should match a Chinese goal against descriptions via 2-grams, ignoring stopwords", () => {
		const hits = rankToolMatches("想调用一个工具", TOOLS);
		assert.ok(hits.includes("tool_caller"), `中文目标应命中调用类工具; got: ${JSON.stringify(hits)}`);
	});

	it("should return no hits for an unrelated goal", () => {
		assert.deepEqual(rankToolMatches("量子物理引力波", TOOLS), []);
	});

	it("should return no hits for an empty or whitespace goal", () => {
		assert.deepEqual(rankToolMatches("", TOOLS), []);
		assert.deepEqual(rankToolMatches("   ", TOOLS), []);
	});
});

describe("nonLoadableSourceReason", () => {
	it("should reject pi builtin tools carrying a synthetic <sdk:name> source", () => {
		const reason = nonLoadableSourceReason({
			sourceInfo: { path: "<sdk:ls>", source: "sdk" },
		});
		assert.ok(reason);
		assert.match(reason, /omnify 执行不了/);
		assert.match(reason, /bash/);
	});

	it("should also reject the older <builtin:name> marker and source=builtin", () => {
		const reason = nonLoadableSourceReason({
			sourceInfo: { path: "<builtin:ls>", source: "builtin" },
		});
		assert.ok(reason);
	});

	it("should report a missing source path instead of silently returning null", () => {
		assert.match(nonLoadableSourceReason({ sourceInfo: { path: "" } }) ?? "", /缺少来源路径/);
		assert.match(nonLoadableSourceReason(undefined) ?? "", /缺少来源路径/);
	});

	it("should allow extension tools that have a real file path", () => {
		assert.equal(
			nonLoadableSourceReason({ sourceInfo: { path: "C:/pi/extensions/pi-fd.ts", source: "local" } }),
			null,
		);
		assert.equal(
			nonLoadableSourceReason({ sourceInfo: { path: "/home/u/.pi/agent/extensions/pi-fd.ts" } }),
			null,
		);
	});
});
