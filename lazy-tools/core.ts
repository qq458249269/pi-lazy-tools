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
			reason: `工具 "${tool}" 尚未通过 load_tools 激活。请先调用 load_tools({ tools: ["${tool}"] })。`,
		};
	}
	return { ok: true, reason: "" };
}
