/**
 * Pure logic layer for the lazy-tools extension.
 *
 * No pi runtime imports, no typebox. Usable from both the extension and
 * standalone unit tests.
 */

export interface LazyConfig {
	resident?: unknown;
	[key: string]: unknown;
}

export interface LazyList {
	resident: string[];
}

export interface ValidationResult {
	ok: boolean;
	errors: string[];
}

export interface StartupNoticeInput {
	toolNames: string[];
	userConfigPath: string;
	projectConfigPath: string;
	effectiveConfigPath: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string");
}

/**
 * Merge user-level and project-level resident (non-lazy) exception configs.
 *
 * - If projectCfg is non-null and contains a `resident` array, it fully replaces
 *   the user config.
 * - Otherwise fall back to userCfg.
 * - Non-array `resident` fields are treated as absent.
 * - Non-string entries in the array are filtered out.
 */
export function mergeLazyConfigs(
	userCfg: LazyConfig | null,
	projectCfg: LazyConfig | null,
): LazyList {
	for (const cfg of [projectCfg, userCfg]) {
		if (isObject(cfg)) {
			const resident = extractStringArray(cfg.resident);
			if (resident !== undefined) {
				return { resident };
			}
		}
	}
	return { resident: [] };
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

function hasValidResidentArray(cfg: LazyConfig | null): boolean {
	return isObject(cfg) && Array.isArray(cfg.resident);
}

/**
 * Select which config path is currently effective.
 *
 * - If the project config contains a valid `resident` array (empty array counts),
 *   the project path wins.
 * - Otherwise fall back to the user config if it contains a valid `resident` array.
 * - If neither config has a valid `resident` array, return null.
 *
 * Non-string entries inside the array do not affect the array's validity.
 */
export function selectEffectiveConfigPath(
	userCfg: LazyConfig | null,
	projectCfg: LazyConfig | null,
	userPath: string,
	projectPath: string,
): string | null {
	if (hasValidResidentArray(projectCfg)) return projectPath;
	if (hasValidResidentArray(userCfg)) return userPath;
	return null;
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

export interface ToolInfoLike {
	name: string;
	description: string;
}

/** 中文高频虚词（2-gram 计分时剔除，避免噪声覆盖语义）。 */
const CJK_STOPWORDS = new Set([
	"一个", "两个", "什么", "怎么", "哪个", "哪些", "这个", "那个", "这些", "那些",
	"想要", "希望", "需要", "可以", "能否", "帮忙", "帮我", "请帮", "请你", "请把",
	"使用", "调用", "搜索", "找回", "查找", "通过", "完成", "执行", "进行", "然后",
	"以及", "或者", "还是", "并且", "但是", "所以", "因为", "如果", "假如", "既然",
	"我的", "你的", "我们", "你们", "他们", "自己", "咱们", "这里", "那里", "现在",
	"自动", "一步", "直接", "先把", "先试", "试试", "尝试", "一下", "是否", "是否",
	"做些", "做一", "的", "了", "把", "被", "于", "在", "至", "给", "从", "向",
]);

function ngramSet(text: string, n: number): string[] {
	const out: string[] = [];
	for (let i = 0; i + n <= text.length; i++) {
		const g = text.slice(i, i + n);
		if (!CJK_STOPWORDS.has(g)) out.push(g);
	}
	return out;
}

/**
 * Rank candidate tools by relevance to a natural-language goal.
 *
 * Scoring (higher wins):
 * - goal equals tool name: 10
 * - goal or tool name contains the other: 6
 * - goal appears in description verbatim: 5
 * - each >=2-char space-separated word of goal found in description: +1
 *
 * Returns names with score > 0, best first. Empty goal yields no matches.
 * Chinese goals rarely embed as substrings, so prefer the explicit `tool`
 * param of omnify when the goal is a sentence, not a tool keyword.
 */
export function rankToolMatches(goal: string, toolInfos: ToolInfoLike[]): string[] {
	const g = goal.trim().toLowerCase();
	if (!g) return [];

	// 中英文词元：整词（≥2 字符）或 2-gram 窗口。
	const tokens = new Set<string>();
	for (const w of g.split(/\W+/)) {
		if (w.length >= 2) tokens.add(w);
	}
	for (const g2 of ngramSet(g, 2)) tokens.add(g2);

	const scored = toolInfos
		.map((t) => {
			const name = t.name.toLowerCase();
			const desc = t.description.toLowerCase();
			let score = 0;
			if (name === g) score += 10;
			else if (name.includes(g) || g.includes(name)) score += 6;
			if (desc.includes(g)) score += 5;
			for (const w of tokens) {
				if (desc.includes(w)) score += 1;
			}
			return { name: t.name, score };
		})
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score);
	return scored.map((s) => s.name);
}
