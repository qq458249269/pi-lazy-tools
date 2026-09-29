/**
 * Pure logic layer for the lazy-tools extension.
 *
 * No pi runtime imports, no typebox. Usable from both the extension and
 * standalone unit tests.
 */

/**
 * pi 未配置 `defaultTools` 时的内置默认常驻工具（与 pi sdk 的
 * `defaultActiveToolNames` 保持一致：read, bash, edit, write）。
 */
export const PI_BUILTIN_DEFAULT_TOOLS: readonly string[] = ["read", "bash", "edit", "write"];

export interface ValidationResult {
	ok: boolean;
	errors: string[];
}

export interface StartupNoticeInput {
	/** lazy（移出 active 集）的工具名。 */
	toolNames: string[];
	/** 常驻（不 lazy）工具名。 */
	resident: string[];
	/** 提供 defaultTools 的 settings.json 路径；null = 未配置，取 pi 内置默认。 */
	sourcePath: string | null;
	userSettingsPath: string;
	projectSettingsPath: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string");
}

/** 候选取值来源：settings.json 路径 + 其 defaultTools 原始值。 */
export interface DefaultToolsCandidate {
	path: string;
	defaultTools: unknown;
}

export interface ResolvedResident {
	/** 常驻（不 lazy）工具名：已过滤非字符串项并去重。 */
	resident: string[];
	/** 命中的 settings.json 路径；null = 所有候选都没有合法 defaultTools，取 pi 内置默认。 */
	path: string | null;
}

/**
 * 解析常驻名单：与 pi 共用 `settings.json` 的 `defaultTools` 字段。
 *
 * - 候选按优先级排列（项目级在前），取第一个含合法 `defaultTools` 字符串数组的来源。
 * - 非数组（缺失/类型错）视为未配置，继续看下一个候选。
 * - 空数组是合法取值：表示除 omnify 外全部 lazy。
 * - 全部候选都没有合法取值时，回退 pi 内置默认（PI_BUILTIN_DEFAULT_TOOLS）。
 */
export function resolveDefaultTools(
	candidates: readonly DefaultToolsCandidate[],
	fallback: readonly string[] = PI_BUILTIN_DEFAULT_TOOLS,
): ResolvedResident {
	for (const candidate of candidates) {
		const list = extractStringArray(candidate.defaultTools);
		if (list !== undefined) {
			return { resident: [...new Set(list)], path: candidate.path };
		}
	}
	return { resident: [...new Set(fallback)], path: null };
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
 * Build the startup notice text shown when a session starts.
 *
 * Lists the lazy tool names, the resident (non-lazy) names, and where the
 * resident list came from. When no `defaultTools` is configured anywhere, both
 * settings.json locations are listed so the user knows where to write it.
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
	lines.push("当前常驻名单（settings.json 的 defaultTools）：");
	if (input.resident.length === 0) {
		lines.push("（空：除 omnify 外全部按需加载）");
	} else {
		for (const name of input.resident) {
			lines.push(`- ${name}`);
		}
	}
	lines.push("");

	if (input.sourcePath !== null) {
		lines.push("当前生效的配置文件为：");
		lines.push(input.sourcePath);
	} else {
		lines.push("当前未配置 defaultTools，取 pi 内置默认。配置位置：");
		lines.push(`用户级：${input.userSettingsPath}`);
		lines.push(`项目级：${input.projectSettingsPath}`);
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
