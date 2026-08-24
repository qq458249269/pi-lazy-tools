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
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	mergeLazyConfigs,
	filterAllowedTools,
	validateParams,
	canCall,
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

// ===== canCall =====

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