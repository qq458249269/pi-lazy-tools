/**
 * Pure logic layer for the lazy-tools extension.
 *
 * No pi runtime imports, no typebox. Usable from both the extension and
 * standalone unit tests.
 */

export interface LazyConfig {
	lazy?: unknown;
	[key: string]: unknown;
}

export interface LazyList {
	lazy: string[];
}

export interface FilterResult {
	allowed: string[];
	rejected: string[];
}

export interface ValidationResult {
	ok: boolean;
	errors: string[];
}

export interface CanCallResult {
	ok: boolean;
	reason: string;
}

export interface StartupNoticeInput {
	toolNames: string[];
	userConfigPath: string;
	projectConfigPath: string;
	effectiveConfigPath: string | null;
}

export interface LoadChallengeInput {
	toolNames: string[]; // 将被加载的工具名
	toolDescriptions: Record<string, string>; // 工具名 → description（来自 getAllTools）
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string");
}

/**
 * Merge user-level and project-level lazy tool configs.
 *
 * - If projectCfg is non-null and contains a `lazy` array, it fully replaces
 *   the user config.
 * - Otherwise fall back to userCfg.
 * - Non-array `lazy` fields are treated as absent.
 * - Non-string entries in the array are filtered out.
 */
export function mergeLazyConfigs(
	userCfg: LazyConfig | null,
	projectCfg: LazyConfig | null,
): LazyList {
	for (const cfg of [projectCfg, userCfg]) {
		if (isObject(cfg)) {
			const lazy = extractStringArray(cfg.lazy);
			if (lazy !== undefined) {
				return { lazy };
			}
		}
	}
	return { lazy: [] };
}

/**
 * Split requested tool names into allowed and rejected lists based on a
 * whitelist. Preserves first-seen order and deduplicates. Non-string entries
 * in either input are ignored.
 */
export function filterAllowedTools(requested: unknown[], whitelist: unknown[]): FilterResult {
	const whitelistSet = new Set(
		whitelist.filter((item): item is string => typeof item === "string"),
	);

	const allowed: string[] = [];
	const rejected: string[] = [];
	const seen = new Set<string>();

	for (const item of requested) {
		if (typeof item !== "string") continue;
		if (seen.has(item)) continue;
		seen.add(item);

		if (whitelistSet.has(item)) {
			allowed.push(item);
		} else {
			rejected.push(item);
		}
	}

	return { allowed, rejected };
}

function describeValue(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && !Number.isNaN(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "object":
			return isObject(value);
		case "array":
			return Array.isArray(value);
		default:
			return true;
	}
}

function validateValue(
	schema: unknown,
	value: unknown,
	path: string,
	errors: string[],
): void {
	if (!isObject(schema)) return;

	if (typeof schema.type === "string" && !matchesType(value, schema.type)) {
		errors.push(`${path}: expected ${schema.type}, got ${describeValue(value)}`);
		// Continue validating other constraints so we collect multiple errors,
		// but stop subtype checks when the type is already wrong.
		if (schema.type === "object" || schema.type === "array") return;
	}

	if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value)) {
		const values = schema.enum
			.map((item) => (typeof item === "string" ? item : describeValue(item)))
			.join(", ");
		errors.push(`${path}: expected one of [${values}], got ${describeValue(value)}`);
	}

	if (typeof schema.pattern === "string" && typeof value === "string") {
		let regex: RegExp;
		try {
			regex = new RegExp(schema.pattern);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`${path}: invalid pattern ${schema.pattern}: ${message}`);
			return;
		}
		if (!regex.test(value)) {
			errors.push(`${path}: expected pattern ${schema.pattern}, got ${describeValue(value)}`);
		}
	}

	const properties = isObject(schema.properties) ? schema.properties : {};
	const required = Array.isArray(schema.required) ? schema.required : [];
	const shouldCheckObject = isObject(value) && (schema.type === "object" || schema.type === undefined);

	if (shouldCheckObject) {
		for (const key of required) {
			if (!Object.hasOwn(value, key)) {
				const childPath = path ? `${path}.${key}` : key;
				errors.push(`${childPath}: required, got ${describeValue(value[key])}`);
			}
		}

		for (const [key, subSchema] of Object.entries(properties)) {
			if (Object.hasOwn(value, key)) {
				const childPath = path ? `${path}.${key}` : key;
				validateValue(subSchema, value[key], childPath, errors);
			}
		}

		if (schema.additionalProperties === false) {
			for (const key of Object.keys(value)) {
				if (!Object.hasOwn(properties, key)) {
					const childPath = path ? `${path}.${key}` : key;
					errors.push(`${childPath}: additional property not allowed`);
				}
			}
		}
	}

	if (schema.type === "array" && Array.isArray(value)) {
		const itemsSchema = schema.items;
		for (let i = 0; i < value.length; i++) {
			const childPath = path ? `${path}[${i}]` : `[${i}]`;
			validateValue(itemsSchema, value[i], childPath, errors);
		}
	}
}

/**
 * Validate params against a JSON Schema subset.
 *
 * Supported keywords: type, required, enum, pattern, properties,
 * additionalProperties, items.
 *
 * Returns `{ ok: true, errors: [] }` when valid, otherwise collects all
 * encountered errors with dotted/indexed paths.
 */
export function validateParams(schema: unknown, params: unknown): ValidationResult {
	const errors: string[] = [];
	validateValue(schema, params, "", errors);
	return { ok: errors.length === 0, errors };
}

function hasValidLazyArray(cfg: LazyConfig | null): boolean {
	return isObject(cfg) && Array.isArray(cfg.lazy);
}

/**
 * Select which config path is currently effective.
 *
 * - If the project config contains a valid `lazy` array (empty array counts),
 *   the project path wins.
 * - Otherwise fall back to the user config if it contains a valid `lazy` array.
 * - If neither config has a valid `lazy` array, return null.
 *
 * Non-string entries inside the array do not affect the array's validity.
 */
export function selectEffectiveConfigPath(
	userCfg: LazyConfig | null,
	projectCfg: LazyConfig | null,
	userPath: string,
	projectPath: string,
): string | null {
	if (hasValidLazyArray(projectCfg)) return projectPath;
	if (hasValidLazyArray(userCfg)) return userPath;
	return null;
}

/**
 * Check whether a lazy tool may be invoked through call_tool.
 *
 * - Must be in the whitelist.
 * - Must have been previously loaded (present in activatedSet).
 */
export function canCall(
	tool: string,
	whitelist: string[],
	activatedSet: Set<string>,
): CanCallResult {
	if (!whitelist.includes(tool)) {
		return { ok: false, reason: `工具 "${tool}" 不在 lazy 名单中。` };
	}
	if (!activatedSet.has(tool)) {
		return {
			ok: false,
			reason: `工具 "${tool}" 未激活；先 load_tools({ tools: ["${tool}"], confirm: true })。`,
		};
	}
	return { ok: true, reason: "" };
}

/**
 * Build the two-step confirmation challenge text for load_tools.
 *
 * Lists each tool to be loaded with its description (or a fallback when
 * metadata is missing), states that this call has no side effects, warns that
 * the loaded tools will be activated and callable via call_tool, and spells out
 * the exact second-call shape with confirm: true.
 */
export function buildLoadChallenge(input: LoadChallengeInput): string {
	const lines: string[] = [];
	lines.push("以下工具确认后将激活，可经 call_tool 调用；本次未加载或激活任何工具。");
	lines.push("");
	lines.push("唯用户主动要求方加载，确认前请核对。");
	lines.push("");

	for (const name of input.toolNames) {
		const description = input.toolDescriptions[name] ?? "未找到工具元数据";
		lines.push(`- ${name}: ${description}`);
	}

	lines.push("");
	const toolsList = input.toolNames.map((name) => JSON.stringify(name)).join(", ");
	lines.push(`确认请再调：load_tools({ tools: [${toolsList}], confirm: true })`);

	return lines.join("\n");
}

/**
 * Build the startup notice text shown when a session starts.
 *
 * Lists the merged lazy tool names and states which configuration file is
 * currently effective. When no config is effective, both candidate locations
 * are listed together with a note that neither file exists.
 */
export function buildStartupNotice(input: StartupNoticeInput): string {
	const lines: string[] = [];
	lines.push("当前 lazy 工具名单：");
	if (input.toolNames.length === 0) {
		lines.push("（空）");
	} else {
		for (const name of input.toolNames) {
			lines.push(`- ${name}`);
		}
	}
	lines.push("");

	if (input.effectiveConfigPath !== null) {
		lines.push("当前生效的配置文件为：");
		lines.push(input.effectiveConfigPath);
	} else {
		lines.push("当前暂无配置文件：");
		lines.push(`用户级：${input.userConfigPath}`);
		lines.push(`项目级：${input.projectConfigPath}`);
		lines.push("");
		lines.push("以上两个文件均不存在");
	}

	return lines.join("\n");
}
