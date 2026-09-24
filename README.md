# pi-lazy-tools

pi-lazy-tools：让低频工具像 Skill 一样按需加载的 pi 扩展。

> [English](README.en.md) | 中文
>

主 Agent 能调用哪些工具、每个工具几千字节的说明书，很大程度上决定了它能做什么。这些说明书每一轮请求都完整出现在上下文里，包括那些 95% 场合根本用不上的工具：主 Agent 不得不一遍遍重新扫过它们，注意力持续被稀释。我们此前做的 [async-subagent-isolation](https://github.com/Wolido/async-subagent-isolation) 在 subagent 维度落实了这条「上下文纯净」哲学：主智能体只负责派活、不碰任务细节；工具维度还剩一类问题：低频工具的定义每轮都在场。

Skills 对同类问题的解法是渐进式披露（progressive disclosure）：需要时才加载。pi-lazy-tools 把同一思路套到工具上：注册照常（--tools 白名单、pi 运行时元数据都不动），会话开始时把非常驻工具（缺省 = 全部已装工具）从 LLM 可见的 active 集剔除，粒度到单个工具，同一扩展里的工具可以部分隐藏；需要时由唯常驻入口 `omnify` 一步完成搜索、取用法与代理执行（四合一：原 load_tools / call_tool / skill_search 并入），执行逻辑始终是目标扩展自己的 `execute`。剔除之后，主 Agent 的上下文只保留它真正会用的工具，注意力不再被低频说明书占用。因 tools 字段与系统提示词在会话内再也不变，懒加载不造成任何缓存失效，任意模型通用（论证见[工作原理](#工作原理)）。

## 目录

- [快速上手](#快速上手)
- [使用](#使用)
- [启动提示](#启动提示)
- [配置](#配置)
- [工作原理](#工作原理)
- [设计细节与踩坑记录](#设计细节与踩坑记录)
- [开发](#开发)
- [License](#license)

## 快速上手

### 安装

```bash
pi install git:github.com/qq458249269/pi-lazy-tools
```

个人级写入 `~/.pi/agent/settings.json`；加 `--local` 改写项目级 `.pi/settings.json`（需先信任项目）。`pi update --extensions` 对账更新，`pi remove git:github.com/qq458249269/pi-lazy-tools` 卸载。

仓库布局：

```
lazy-tools/
├── README.md
├── lazy-tools.ts        # 扩展入口：配置读取、session_start、omnify 单常驻
├── lazy-tools/
│   └── core.ts          # 纯逻辑层：无 pi 依赖、无 typebox，可独立测试
└── test/                # 71 个测试（node:test + tsx）
    ├── core.test.ts
    ├── integration.test.ts
    └── fixtures/
        └── fake-target.ts
```

安装后还需三步：

1. 写配置（见[最小配置](#最小配置)；不写则默认全量 lazy）
2. 启动命令的 `--tools` 白名单里保留 lazy 工具（注册与隐藏是两件事，详见[配置](#配置)）
3. 开新会话生效（扩展在会话启动时加载，旧会话没有 `omnify`）

typebox：扩展直接 import typebox（pi 运行时同款，位于根目录 node_modules）。

### 最小配置

无任何配置文件时**默认全量 lazy**：除单入口 `omnify` 常驻外，全部已装工具（含 `read`、`bash` 等内置工具）按需加载；技能清单也不入系统提示词，由 omnify 检索并返回其 SKILL.md 路径。配置文件的 `resident` 数组写**不 lazy（常驻）的例外工具**；`"resident": []` 表示无例外、全部 lazy。

```jsonc
// ~/.pi/lazy-tools.json
{
  "resident": ["read", "bash"]
}
```

`resident` 里写始终常驻、不参与 lazy 的工具名（示例 read、bash）；其余工具全部按需加载，名单取舍标准见[挑选要 lazy 化的工具](#挑选要-lazy-化的工具)。

放在 `<cwd>/.pi/lazy-tools.json` 则只对当前项目生效，并整体覆盖用户级名单（合并规则见[配置](#配置)）。

### 挑选要 lazy 化的工具

默认已全量 lazy，本节标准反过来用：`resident` 常驻名单只留高频刚需（否则每次使用多一轮 omnify 搜索/补参往返，反而亏），其余留在 lazy 侧。

在 pi 的工具列表里过一遍已注册的工具：description 很长、参数 schema 不小，但实际几天才用一次的工具，就是候选。判断标准两条：低频（几天才用一次）＋ 参数简单（每次调用只有一两个字段）。高频工具应进 `resident` 常驻名单，每次使用多一轮 omnify 搜索/补参往返，反而亏。

### 使用示例

对主智能体说：「把当前版本部署到 staging」。一步调用 omnify：

```
omnify({ goal: "把当前版本部署到 staging", args: { env: "staging" } })
```

omnify 按 goal 自动搜索候选工具；无 `args` 时返回匹配工具的参数 JSON Schema（schema-first），按它补上 `args` 重试即可；带 `args` 时直接校验并执行，成功即返结果。不确定工具名时可先 `omnify({ goal })` 拿候选，再补参数。

## 使用

### omnify：四合一搜索调用

omnify 是唯常驻入口，四合一（原 load_tools / call_tool / skill_search 已并入）：

| 情形 | 行为 |
| --- | --- |
| `goal` 无匹配 | 返回全部工具名录 + 技能命中（SKILL.md 路径），建议退常规手段 |
| 匹配 + 无 `args` | schema-first：返回候选工具的参数 JSON Schema，补 args 重试 |
| 匹配 + 有 `args` | Schema 预校验后执行，成功即返结果 |
| `tool` 显式指名 | 跳过搜索直接评估该工具；参数不符即止，不代猜其他工具 |

匹配规则：目标名精确/包含优先，其次目标词（英文整词 + 中文双字去虚词）与 description 的交集，取前 5 个候选依次试调。目标 execute 由 findToolDefinition 重放捕获：以伪造 pi 重放目标扩展 factory，截获其 ToolDefinition（含真实 execute），按 `${sourcePath}#${name}` memoize（每工具每会话只重放一次 factory），随后以原始参数、signal、onUpdate、ctx 调用，结果原样返回。

Schema 预校验支持 type / required / enum / pattern / properties / additionalProperties / items 子集；不合法时返回字段路径级错误（例：`action: expected one of [discover, submit], got "nope"`），目标 execute 不执行。

技能命中只返路径：skill 不是工具，按 omnify 返回的 SKILL.md 路径用 read 读取用法。

## 启动提示

会话以 startup 原因启动（session_start 的 `reason === "startup"`）时，扩展通过 `ctx.ui.notify` 打印一条提示：当前 lazy 工具名单，以及当前生效的配置文件路径。new / resume / fork / reload 等其余启动原因不打印。

有生效配置时，提示形如：

```
当前 lazy 工具名单：
- deploy_tool

当前生效的配置文件为：
~/.pi/lazy-tools.json
```

用户级、项目级都没有含 `resident` 数组的配置时，提示列出两个候选路径并注明均不存在；此时默认全量 lazy，名单列出全部非常驻工具：

```
当前 lazy 工具名单：
- read
- bash
- edit
- write
- …（全部非常驻工具）

当前暂无配置文件：
用户级：~/.pi/lazy-tools.json
项目级：<cwd>/.pi/lazy-tools.json

以上两个文件均不存在
```

提示只做告知，不影响核心逻辑：名单剔除与 setActiveTools 照常执行；`ctx.ui.notify` 不可用或抛错时静默跳过（仅 console.warn），不打断会话。

## 配置

两级配置，项目级整体覆盖用户级：

| 级别 | 位置 | 说明 |
| --- | --- | --- |
| 用户级 | `~/.pi/lazy-tools.json` | 所有项目的默认名单 |
| 项目级 | `<cwd>/.pi/lazy-tools.json` | 会话工作目录下的 .pi 目录，覆盖用户级 |

格式：`{ "resident": string[] }`，示例：`{ "resident": ["read", "bash"] }`

合并规则：

| 项目级配置 | 用户级配置 | 生效名单 |
| --- | --- | --- |
| 含 `resident` 数组 | 任意 | 项目级（整体替换，空数组也覆盖） |
| 缺失或损坏 | 含 `resident` 数组 | 用户级 |
| 缺失或损坏 | 缺失或损坏 | 默认全量 lazy（除 omnify 外全部按需加载） |

文件读取：JSON 解析失败只打告警、按缺失处理；数组中的非字符串项被过滤。配置在 session_start 时读取，会话中途修改不生效，需开新会话。

**注意：--tools 白名单须注册你要按需加载的工具。** 注册与隐藏是两件事：--tools 负责注册，扩展只负责隐藏。未进 `--tools` 的工具 `getAllTools()` 查不到，omnify 会搜不到它（候选为空时返名录后仍无法调用）；`resident` 只决定谁常驻、不替代注册（详见[坑 1](#1---tools-是严格注册白名单)）。

## 工作原理

一次懒加载的完整调用链：

```
会话开始（session_start，首轮请求前）
  读两级配置 → 从 active 集剔除名单工具 → 补上 omnify
  此后 tools 字段冻结，系统提示词不再变化
        │
主智能体需要某个工具/技能
        ▼
omnify({ goal: "...", args: {...} })（无 args = schema-first）
  搜索候选：目标名精确/包含优先 + description 词交集（≤5 个）
        ▼
带 args：Schema 预校验 → 重放目标扩展 factory 捕获真实 execute
  校验失败不执行；指名模式参数不符即止，不代猜其他工具
        ▼
成功：execute 结果原样透传；全败：返候选与失败原因，建议退常规手段
匹配技能（skill 非工具）：返回 SKILL.md 路径，read 取用法
```

四个设计要点：

- session_start（首轮请求前）是唯一一次修改 tools 字段的动作，此后 tools 字段与系统提示词全程冻结
- omnify 无 args 时返回候选工具的参数 Schema（schema-first、零执行副作用），带 args 时 Schema 预校验后重放目标扩展 factory 捕获真实 execute 并执行，结果原样透传，全追加在消息流末尾，模型像读文档一样读到用法
- 未匹配时返回全部工具名录与技能命中（SKILL.md 路径），并建议退回 bash/read/编辑 等常规手段
- 因此懒加载不造成任何一次缓存失效，任意模型、任意 provider 通用（论证见下）

<details>
<summary>缓存安全论证：为什么任意模型零失效</summary>

prompt cache 按前缀匹配：请求序列化后，与上一轮共享的前缀命中缓存，前缀之后任何字节变化都会让后续内容全部落到缓存之外。tools 字段在序列化开头，系统提示词还在它前面，这两处任何一处变化都是整轮失效。

本设计对两者的处理：

- tools 字段只在 session_start 写一次（首轮请求前），此后冻结
- 系统提示词全程不变：lazy 工具从不激活，promptGuidelines 结构性不会进入系统提示词

会话内的消息增长全部发生在消息流末尾：omnify 的 schema-first 用法与其执行结果都是追加内容，追加不改变前缀。结论：本设计在任何模型、任何 provider 上，懒加载不造成任何一次缓存失效。

</details>

## 设计细节与踩坑记录

以下内容讲设计取舍、踩过的坑和维护边界，日常使用可以跳过。

### 设计决策

#### 为什么不用官方 setActiveTools 动态激活

官方机制（docs/extensions.md「Dynamic Tool Loading」）：全部工具照常注册，加载工具执行时 `pi.setActiveTools()` 追加目标集；pi 检测到纯增量变化后，在模型支持原生 deferred loading 时把新定义锚定在 tool-result 位置，其余模型在下一轮请求发送完整的新 tools 字段。

两个问题：

1. 原生 deferred path 只有 Claude 4.5+（不含 Haiku）与 gpt-5.4+ 系支持；其余模型走 fallback，激活那一刻 tools 字段重建，缓存前缀失效一次
2. 激活带 promptSnippet / promptGuidelines 的工具会重建系统提示词，这个变化位于 tools 字段之前，官方文档明确提示 lazy 工具应省略这些字段

本设计的选择：目标工具永不激活，定义以文本形式出现在消息流里。任何模型、任何时刻，前缀不变。

代价：

- 调用多一层间接：模型看到的是 omnify 的统一调用，目标工具不在工具列表中
- 参数校验下沉：没有 provider 协议层的 schema 兜底，用扩展内预校验补偿
- UI 与权限粒度退化：目标工具没有独立的权限提示与渲染呈现，统一以 omnify 形态出现

#### 为什么不做扩展级懒加载（pi-lazy-extensions 思路）

pi-lazy-extensions 按扩展粒度懒加载：jiti 动态 import 整个扩展模块，省的是扩展加载开销，并且有 sourceInfo 归因错误等已知缺陷（实验性项目）。

本设计优化的是每轮请求的上下文构成：低频工具的定义每轮都在场，随会话变长、重试增多而复利占用主 Agent 的注意力。因此粒度必须到单个工具，同一个扩展里的工具可以部分隐藏，`lazy-tools.json` 里精确到工具名。

#### 为什么不需要剥离系统提示词里的 guidelines

promptGuidelines 只在工具 active 时进入系统提示词。本设计的工具从不激活，tools 字段里始终没有它们，guidelines 结构性不会出现在系统提示词里，没有需要剥离的内容。这是「永不激活」路线自动获得的缓存红利，也是坑 3 那条经验的反面。

### 踩过的坑

#### 1. --tools 是严格注册白名单

不在 `--tools` 名单里的工具连 `getAllTools()` 都查不到，表现为 omnify 搜不到它（候选为空返名录后仍无法调用）。pi-lazy-tools 只负责隐藏可见性；注册必须由 --tools 完成。教训：`--tools` 决定注册，`lazy-tools.json` 的 `resident` 决定常驻例外，各管一头、互不替代。

#### 2. 扩展在会话启动时加载

装完扩展或改完配置，主智能体表示没有 `omnify`。扩展在会话建立时加载，旧会话（包括 resume 的）没有新扩展。排查「主智能体不激活」问题时，开新会话是第一优先动作，永远要先排除这个。

#### 3. promptGuidelines 会随工具激活重建系统提示词

setActiveTools 激活一个带 promptGuidelines 的工具，系统提示词整体重建；即使 provider 支持原生 deferred schema，这个变化照样前缀失效。官方文档明确提示 lazy 工具应省略 prompt 元数据。对任何 setActiveTools 方案这都是隐藏的缓存杀手；本设计从不激活，天然绕开。

#### 4. pi 会吞掉 session_start handler 的异常

session_start 里抛异常，pi 静默吞掉，表现为工具没被隐藏、名单没生效，且没有任何报错，极难排查。对策：handler 内部全包 try/catch，自行 console.warn（扩展源码即此写法）。

#### 5. jiti 注入的 require 可加载 .ts 且有模块缓存

`findToolDefinition` 依赖 jiti 注入的 require 直接加载目标扩展源码路径（.ts 可加载，模块有缓存），这是未文档化行为，重放机制建立其上。两个连带要求：factory 重放必须按 `(sourcePath, name)` memoize，否则每次 omnify 都重跑目标扩展 factory，副作用翻倍；伪造 pi 必须打桩 `events.on` 等订阅入口，否则目标扩展升级后在工厂期订阅真实事件会泄漏。

#### 6. JSON Schema 预校验的边界

- TypeBox 不校验 pattern 合法性：schema 里的 pattern 是普通字符串，可能不是合法正则，直接 `new RegExp` 会抛异常，必须 try/catch
- required / properties 不能被 `type: "object"` 门控：合法 schema 可以省略 type，缺 type 时 object 分支的校验也要走
- `"key" in obj` 会被 `__proto__` 原型链欺骗：属主属性判断必须用 `Object.hasOwn`
- 没有 additionalProperties 约束时多余字段默认放行，这是真实 TypeBox 形态，不要画蛇添足地报错

### 已知风险与维护

#### createFakePi 黑名单打桩的泄漏面

createFakePi 用 `{ ...realPi }` 展开后黑名单打桩：只替换注册类方法与 `events.on`；exec、sendMessage、appendEntry、events.emit 等未打桩方法在重放目标 factory 时会直通真实 pi。当前纳入 lazy 名单的扩展工厂期只调注册类方法与 events.on，风险可控。目标扩展升级若引入工厂期副作用，需重新评估；远期方案是改为显式白名单委托，只放行确认无害的方法。

#### 模块实例身份依赖 jiti require 缓存

重放加载与 pi 扩展加载必须命中同一模块实例。若两者分裂，目标扩展的模块级可变状态（如任务注册表）会分成两份，同一操作被执行两次。升级 pi 或目标扩展后，回归验证目标扩展的核心调用链路。

#### 适用范围

lazy 化的收益是让主 Agent 的上下文只保留真正会用到的工具，注意力不再被低频定义占用。代价是每次使用都要经 omnify 的搜索/补参往返间接调用。对已知参数可以直接一次调用。低频、参数简单的工具收益最大（远程代理、会话恢复类）；高频工具请写进 `resident` 常驻名单。

#### 排障清单

- 工具没隐藏或 `omnify` 不存在：先开新会话（坑 2）
- 「未找到工具元数据」：查 `--tools` 白名单（坑 1）
- 名单不生效：查合并规则，项目级整体覆盖用户级（含空数组）
- 升级 pi 或目标扩展后：回归目标扩展的核心调用链路；目标扩展工厂期行为若有变化，重评 createFakePi 打桩

### 参考

- pi 官方文档 docs/extensions.md「Dynamic Tool Loading」章节：官方动态激活机制、原生 deferred 模型门槛、缓存提示
- pi-lazy-extensions（GitHub，实验性）：扩展级懒加载思路，本文决策记录对比对象

## 开发

测试位于 `test/`，97 个用例（68 单元 + 29 集成）：

```bash
cd pi-lazy-tools
npm install
npm test            # node --import tsx --test test/core.test.ts test/integration.test.ts
npm run typecheck   # tsc --noEmit（严格模式）
```

覆盖：配置合并、Schema 预校验边界（非法 pattern、无 type 的 object schema、`__proto__` 键、required 错误消息）、omnify 四合一接线（schema-first 零执行、显式指名、参数错误不执行、factory memoize、技能命中返 SKILL.md 路径）。集成测试真实加载扩展源码。

## License

MIT