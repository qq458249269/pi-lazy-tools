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
	/**
	 * omnify 无法代理执行、因而强制常驻的内建/sdk 工具名（默认 []）。
	 * 与 `resident` 可能重复；重复展示是为了说明「配置里没写，为什么它还在场上」。
	 */
	forcedResident?: string[];
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
		lines.push(
			input.forcedResident && input.forcedResident.length > 0
				? "（空：defaultTools 未列工具）"
				: "（空：除 omnify 外全部按需加载）",
		);
	} else {
		for (const name of input.resident) {
			lines.push(`- ${name}`);
		}
	}
	lines.push("");

	// 内建/sdk 工具没有可重放的源码，omnify 调不动，故不会被 lazy 隐藏；
	// defaultTools: [] 时还会把内建基线补回常驻，单独列出以免用户困惑。
	if (input.forcedResident && input.forcedResident.length > 0) {
		lines.push("以下内建工具 omnify 无法代理，强制常驻（与 defaultTools 无关）：");
		for (const name of input.forcedResident) {
			lines.push(`- ${name}`);
		}
		lines.push("");
	}

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
 * - each goal word appearing in the tool NAME: +3
 * - each goal word (or CN synonym) found in the name/description: +1
 *
 * 入候选门槛：score>0 且（中文 2-gram 命中 ≥1 或 拉丁词元命中 ≥2 或 score≥5）。
 * 单个拉丁词的顺带命中（任何提到 find 的 md_* 描述）不算相关。
 *
* 2-gram 只走中文：拉丁 2-gram（il/le/nd/in…）对任何英文 goal 都是噪声，会把
 * md_edit/md_diff/md_inspect 同时点亮并挤掉真正对口的 fd。
 *
 * 工具描述皆英文，中文 goal 靠 CN→EN 同义词桥（CN_SYNONYMS）才能命中；无桥时
 * 中文 goal 几乎必然零命中，只能回落名录。
 *
 * Returns names with score > 0, best first. Empty goal yields no matches.
 * Chinese goals rarely embed as substrings, so prefer the explicit `tool`
 * param of omnify when the goal is a sentence, not a tool keyword.
 */
export function rankToolMatches(goal: string, toolInfos: ToolInfoLike[]): string[] {
	const g = goal.trim().toLowerCase();
	if (!g) return [];

	// 英文虚词：对工具描述而言全是噪声（"find files by name" 里的 by/name 会点亮
	// 每个描述含 by 的工具）。中文语义靠 CJK 2-gram 承担。
	const EN_STOPWORDS = new Set([
		"by", "of", "to", "in", "on", "at", "is", "it", "an", "and", "or", "for", "with",
		"from", "that", "this", "name", "names", "use", "using", "want", "need", "please",
	]);
	// 中文→英文概念桥：描述全是英文，无桥则中文 goal 零命中。刻意只收「描述里真会出现
	// 的词」，不求覆盖率——同义词越泛，噪声越大。
	const CN_SYNONYMS: readonly (readonly [RegExp, readonly string[]])[] = [
		[/查找|搜索|搜一?下|找找|找/, ["find", "search"]],
		[/文件/, ["file", "files"]],
		[/目录|文件夹/, ["directory", "dir", "path"]],
		[/内容|文本|字符串|代码里/, ["content", "text", "string"]],
		[/最近|改动过|改过|变更|新加/, ["changed", "recent", "new"]],
		[/截图|截屏/, ["screenshot"]],
		[/浏览器|网页/, ["browser", "page"]],
		[/重命名/, ["rename"]],
		[/对比|比较|差异|不同/, ["diff", "compare"]],
		[/段落|章节|小节/, ["section", "block"]],
		[/安装|装上/, ["install", "setup"]],
		[/终端|命令行/, ["shell", "command", "terminal"]],
	];
	/** 拉丁词元：goal 里真实写下的英文（或经同义词桥补出的英文）。 */
	const ascii = new Set<string>();
	/** 中文 2-gram：中文语义的主载体。 */
	const cjk = new Set<string>();
	for (const w of g.split(/\W+/)) {
		if (w.length >= 2 && !EN_STOPWORDS.has(w)) ascii.add(w);
	}
	for (const g2 of ngramSet(g, 2)) {
		// 2-gram 只为中文而生：英文已由整词覆盖，而拉丁 2-gram（il/le/nd/in…）纯属噪声，
		// 会让「文件」类 goal 同时点亮 md_edit/md_diff/md_inspect 三家。
		if (/[^\x00-\x7F]/.test(g2)) cjk.add(g2);
	}
	for (const [re, words] of CN_SYNONYMS) {
		if (re.test(g)) for (const w of words) ascii.add(w);
	}

	const scored = toolInfos
		.map((t) => {
			const name = t.name.toLowerCase();
			const desc = t.description.toLowerCase();
			const countHits = (words: ReadonlySet<string>): number => {
				let n = 0;
				for (const w of words) if (name.includes(w) || desc.includes(w)) n += 1;
				return n;
			};
			let score = 0;
			if (name === g) score += 10;
			else if (name.includes(g) || g.includes(name)) score += 6;
// 整句/整词在描述中原样出现才算强证据；短 goal（ls/ts/go）不然会藏在
			// 任意长词里（ca**ls**、impor**ts**）白拿 +5。
			if (g.length >= 4 && desc.includes(g)) score += 5;
			// 名字命中权重高于描述：描述里出现一个词常是顺带（长描述几乎必含），
			// 名字命中才说明「说的就是它」。
			for (const w of new Set([...ascii, ...cjk])) {
				if (name.includes(w)) score += 3;
			}
			score += countHits(ascii) + countHits(cjk);
			return { name: t.name, score, asciiHits: countHits(ascii), cjkHits: countHits(cjk) };
		})
		// 门槛：单个拉丁词命中不算相关（"find" 会顺带点亮每个提到 find 的 md_* 描述）；
		// 中文 2-gram 命中一次即算（「找文件」之于 fd）。名字/整句命中已叠在上方 score 里。
		.filter((s) => s.score > 0 && (s.asciiHits >= 2 || s.cjkHits > 0 || s.score >= 5))
		.sort((a, b) => b.score - a.score);
	return scored.map((s) => s.name);
}

/** omnify 取 ToolInfo 时用到的最小来源信息（pi 的 SourceInfo 子集）。 */
export interface ToolSourceLike {
	path?: string;
	source?: string;
}

/**
 * 判断某个候选工具的定义能否用「重新 import 源文件」的方式取到；不能时给出可直接
 * 转达给模型的中文原因（null = 可以加载）。
 *
* pi 内建工具（read/bash/edit/write/ls/powershell/grep）不是扩展模块：它们由 pi
 * 自己的工厂函数（createLsTool(cwd, options) 之类）造出来，sourceInfo 是**合成标记**
 * ——path 形如 `<sdk:ls>` / `<builtin:ls>`，source 为 `sdk` / `builtin`。对这种路径做
 * jiti.import 必然抛错，旧实现只报一句「执行定义加载失败」，模型看不出该换手段。
 */
export function nonLoadableSourceReason(info: { sourceInfo?: ToolSourceLike } | undefined): string | null {
	const source = info?.sourceInfo;
	const path = source?.path ?? "";
	if (!path) return "缺少来源路径（sourceInfo.path 为空），omnify 无法定位其定义";
	const synthetic = source?.source === "sdk" || source?.source === "builtin" || /^<[^>]*>$/.test(path);
	if (synthetic) {
		const kind = source?.source ?? "内置";
		return `${kind}工具（sourceInfo=${path}，由 pi 内部工厂生成、没有可 import 的源码）→ omnify 执行不了；请直接用常驻的 bash / powershell 等工具完成`;
	}
	return null;
}
