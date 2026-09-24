# pi-lazy-tools

Let low-frequency tools load on demand, the way Skills do, inside pi.

> English | [中文](README.md)
>
> npm package: @wolido/pi-lazy-tools

The tools the main agent can call, and the multi-kilobyte manuals attached to each of them, largely decide what it can do. Those manuals appear in full on every request, including the ones used in maybe 5% of sessions: the agent has to re-read all of them every round to find what the current task actually needs. We worked out this "clean context" philosophy at the subagent level with [async-subagent-isolation](https://github.com/Wolido/async-subagent-isolation), where the main agent only assigns work and never touches task details. The tool dimension has the same problem left: low-frequency definitions are present every round.

Skills solve the same problem with progressive disclosure: load only what is needed. pi-lazy-tools applies that idea to tools. Registration stays as-is (the `--tools` whitelist and pi runtime metadata are untouched); at session start every non-resident tool (all installed tools by default) is removed from the LLM-visible active set, granular to individual tools, so a single extension can be partially hidden. When one is needed, the single resident entry `omnify` searches, returns the usage requirements (schema-first) and executes on its behalf in one step (four-in-one: the former load_tools / call_tool / skill_search are merged in); the actual execution is always the target extension's own `execute`. After the removal, the context holds only the tools the agent actually uses; attention stops being spent on low-frequency manuals. Because the tools field and the system prompt never change during a session, lazy loading never invalidates the cache, on any model (argument in [How it works](#how-it-works)).

## Table of contents

- [Quick start](#quick-start)
- [Usage](#usage)
- [Startup notice](#startup-notice)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Design details and lessons learned](#design-details-and-lessons-learned)
- [Development](#development)
- [License](#license)

## Quick start

### Installation

```bash
pi install git:github.com/qq458249269/pi-lazy-tools
```

Personal installs are written to `~/.pi/agent/settings.json`; add `--local` to write to the project-level `.pi/settings.json` (requires project trust first). `pi update --extensions` reconciles updates; `pi remove git:github.com/qq458249269/pi-lazy-tools` uninstalls.

Repository layout:

```
lazy-tools/
├── README.md
├── lazy-tools.ts        # extension entry: config loading, session_start, the two resident tools
├── lazy-tools/
│   └── core.ts          # pure logic layer: no pi runtime, no typebox, unit-testable
└── test/                # 96 tests (node:test + tsx)
    ├── core.test.ts
    ├── integration.test.ts
    └── fixtures/
        └── fake-target.ts
```

Three more steps after installation:

1. Write the config (see [Minimal config](#minimal-config); without one, everything is lazy by default)
2. Keep lazy tools in the `--tools` whitelist of the launch command (registration and hiding are two separate things, see [Configuration](#configuration))
3. Start a new session (extensions load at session start; an old session has no `omnify`)

typebox: the extension imports typebox directly (the same one pi uses; it lives in the root node_modules).

### Minimal config

With no configuration file, the plugin **lazies everything by default**: every installed tool (including built-ins like `read`, `bash`) is loaded on demand except the single resident entry `omnify`; the skills roster stays out of the system prompt too and is reachable through omnify, which returns the matching SKILL.md paths. At session start the `rules`/`docs` sections of the system prompt are also compressed to their essentials (semantics preserved) and the skills roster is replaced by a one-line placeholder, trimming first-request tokens further. The config's `resident` array lists the exceptions (tools that stay always-on); `"resident": []` means no exceptions — everything is lazy.

```jsonc
// ~/.pi/lazy-tools.json
{
  "resident": ["read", "bash"]
}
```

List the tools that stay always-on and out of the lazy set (e.g. `read`, `bash`); everything else loads on demand. Inverted picking criteria in [Picking tools to lazy-load](#picking-tools-to-lazy-load).

Putting the file at `<cwd>/.pi/lazy-tools.json` scopes it to the current project and overrides the user-level list entirely (merge rules in [Configuration](#configuration)).

### Picking tools to lazy-load

Everything is lazy by default, so the criteria below invert: keep the `resident` exceptions to hot, must-have tools — every other use would otherwise cost an extra omnify search / re-call round-trip.

Go through the tools registered in pi's tool list: anything with a long description and a sizeable parameter schema, yet used once every few days, is a candidate. Two criteria: low frequency (days between uses) and simple parameters (one or two fields per call). Keep hot tools out of the lazy set (put them in `resident`); the extra omnify search / re-call round-trip per use is a net loss.

### Usage example

Tell the main agent: "deploy the current version to staging". One omnify call:

```
omnify({ goal: "deploy the current version to staging", args: { env: "staging" } })
```

omnify searches candidate tools by the goal. Without `args` it returns the matching
tools' parameter JSON Schemas (schema-first); fill in `args` and retry. With `args`
it validates and executes directly, returning the result on success. When the tool
name is unknown, call `omnify({ goal })` first to list candidates, then supply args.

## Usage

### omnify: four-in-one search-and-call

omnify is the single resident entry; the former load_tools / call_tool / skill_search
are merged into it:

| Scenario | Behavior |
| --- | --- |
| `goal` matches nothing | Returns the full tool roster + skill hits (SKILL.md paths); suggests falling back to regular means |
| matched + no `args` | schema-first: returns the candidates' parameter JSON Schemas; retry with args |
| matched + `args` | validates against the JSON Schema, then executes; returns the result on success |
| explicit `tool` | skips search and evaluates only that tool; stops on invalid args instead of guessing other tools |

Matching ranks exact/contained tool names first, then the intersection of the goal's
tokens (English words + Chinese bigrams minus stopwords) with descriptions; the top 5
candidates are tried in order until one succeeds. Execution replays the target
extension's factory via a fake pi (createFakePi) to capture its ToolDefinition (with
the real execute), memoized by `${sourcePath}#${name}` (one factory replay per tool per
session), then calls `definition.execute` with the original params, signal, onUpdate
and ctx; the result passes through unchanged.

Schema validation supports the subset type / required / enum / pattern / properties /
additionalProperties / items; invalid params return field-path errors (e.g.
`action: expected one of [discover, submit], got "nope"`) and the target execute never
runs.

Skill hits only return paths: a skill is not a tool — read its SKILL.md via the read
tool to get the usage.

## Startup notice

When a session starts with `reason === "startup"` in session_start, the extension prints a notice via `ctx.ui.notify`: the current lazy tool list and the path of the config file in effect. Other start reasons (new / resume / fork / reload) print nothing.

With a config in effect, the notice looks like:

```
Current lazy tool list:
- deploy_tool

Config file in effect:
~/.pi/lazy-tools.json
```

Which config wins follows the [Configuration](#configuration) merge rules: the project config when it has a `resident` array, otherwise the user config. When neither location has a config with a `resident` array, the notice lists both candidate paths and states that neither exists; the default then takes over — every non-resident tool is lazy, so the notice lists them all:

```
Current lazy tool list:
- read
- bash
- edit
- write
- … (all lazy tools)

No config file present:
user-level: ~/.pi/lazy-tools.json
project-level: <cwd>/.pi/lazy-tools.json

Neither file exists
```

The notice is informational only and never touches core logic: list removal and setActiveTools run as usual. If `ctx.ui.notify` is unavailable or throws, the notice is skipped silently (console.warn only); the session is unaffected.

## Configuration

Two levels; the project config overrides the user config entirely:

| Level | Location | Notes |
| --- | --- | --- |
| User | `~/.pi/lazy-tools.json` | default list for all projects |
| Project | `<cwd>/.pi/lazy-tools.json` | .pi dir under the session cwd; overrides user |

Format: `{ "resident": string[] }`, e.g. `{ "resident": ["read", "bash"] }`

Merge rules:

| Project config | User config | Effective list |
| --- | --- | --- |
| Has a `resident` array | Anything | Project (full replacement; an empty array also wins) |
| Missing or corrupt | Has a `resident` array | User |
| Missing or corrupt | Missing or corrupt | Lazy everything by default (only the resident trio stays active) |

Reading: a JSON parse failure logs a warning and is treated as missing; non-string entries in the array are filtered out. Config is read at session_start; edits mid-session take effect only after starting a new session.

**Note: the --tools whitelist must register every tool you want to lazy-load.** Registration and hiding are two separate things: --tools registers, the extension hides. A tool missing from --tools never reaches `getAllTools()`, so omnify will not find it (an empty-candidate roster still cannot call it); `resident` only decides who stays always-on and does not replace registration (see [Pitfall 1](#1---tools-is-a-strict-registration-whitelist)).

## How it works

The full lazy-load call chain:

```
Session start (session_start, before the first request)
  read both config levels → remove all non-resident tools from the active set → ensure omnify
  the tools field freezes afterwards; the system prompt never changes again
       │
the main agent needs a tool / skill
       ▼
omnify({ goal: "...", args: {...} }) (no args = schema-first)
  search candidates: exact/contained tool-name first + description token overlap (<=5)
       ▼
with args: Schema validation → replay the target extension's factory, capture real execute
  invalid args do not execute; in explicit mode, stops instead of guessing other tools
       ▼
success: execute result passed through unchanged; total failure: candidate + failure
  reasons returned, with a suggestion to fall back to bash/read/edit
  skill hit (not a tool): returns the SKILL.md path for read


## Design details and lessons learned

Everything below covers design trade-offs, pitfalls and maintenance boundaries; skip it for everyday use.

### Design decisions

#### Why not the official setActiveTools dynamic activation

The official mechanism (docs/extensions.md, "Dynamic Tool Loading"): register everything, keep a small initial active set, and have the loader tool call `pi.setActiveTools()` to append targets during execution. Pi detects purely additive changes and, on models with native deferred loading, anchors the new definitions at the tool-result position; all other models get the full updated tools field on the next request.

Two problems:

1. Native deferred loading exists only for Claude 4.5+ (excluding Haiku) and the gpt-5.4+ family; everyone else falls back to a full tools-field rebuild, which invalidates the cache prefix once at activation
2. Activating a tool with promptSnippet / promptGuidelines rebuilds the system prompt, which sits before the tools field; the official docs explicitly tell lazy tools to omit prompt metadata

The choice here: target tools are never activated; their definitions appear as text in the message stream. The prefix never changes, on any model, at any time.

Costs:

- One extra indirection: the model sees omnify's unified call; the target tool is not in the tool list
- Parameter validation is offloaded: no provider-level schema validation backs this up; the in-extension pre-validation compensates
- Coarser UI and permission granularity: target tools get no dedicated permission prompts or rendering; they surface via omnify

#### Why not extension-level lazy loading (the pi-lazy-extensions approach)

pi-lazy-extensions lazy-loads whole extensions: it dynamically imports entire extension modules via jiti, saving extension load cost, and it has known defects such as sourceInfo attribution errors (experimental project).

This design optimizes what each request carries in context: low-frequency definitions occupy attention every round, more so as sessions lengthen and retries accumulate. Granularity therefore has to be per tool; tools of the same extension can be hidden selectively, named individually in `lazy-tools.json`.

#### Why no need to strip guidelines from the system prompt

promptGuidelines enter the system prompt only while a tool is active. Tools here are never activated, so they never appear in the tools field and their guidelines structurally cannot show up in the system prompt. There is nothing to strip. This is a free cache dividend of the never-activate route, and the mirror image of pitfall 3.

### Pitfalls

#### 1. --tools is a strict registration whitelist

Tools outside `--tools` are not even visible to `getAllTools()`, so omnify cannot find them (an empty-candidate roster still cannot call them). pi-lazy-tools only hides visibility; registration must come from --tools. Lesson: `--tools` owns registration; the config's `resident` array owns who stays out of the lazy set — different jobs, one does not replace the other.

#### 2. Extensions load at session start

After installing or modifying the extension, the main agent claims there is no `omnify`. Extensions load when the session is created; old sessions (resume included) do not have the new extension. When debugging "the main agent does not activate", opening a new session is the first move; rule this out first.

#### 3. promptGuidelines rebuild the system prompt on activation

Activating a tool with promptGuidelines via setActiveTools rebuilds the system prompt wholesale; even with native deferred schemas, that change still invalidates the prefix. The official docs explicitly advise lazy tools to omit prompt metadata. It is a hidden cache killer for any setActiveTools approach; this design never activates, so it sidesteps it entirely.

#### 4. pi swallows exceptions from the session_start handler

An exception thrown inside session_start is silently swallowed by pi: tools stay visible, the list stays inactive, and there is no error output at all, which is very hard to debug. Counter-measure: wrap the whole handler in try/catch and log with console.warn yourself (as the extension source does).

#### 5. jiti's injected require can load .ts and has a module cache

`findToolDefinition` relies on the require injected by jiti to load the target extension's source path directly (.ts loads fine, modules are cached), an undocumented behavior that the replay mechanism builds on. Two consequences: the factory replay must be memoized by `(sourcePath, name)`, otherwise every omnify call re-runs the target extension's factory and doubles its side effects; and the fake pi must stub subscription entry points such as `events.on`, otherwise a target extension that starts subscribing during the factory phase after an upgrade will leak into the real pi.

#### 6. JSON Schema pre-validation edge cases

- TypeBox does not validate pattern legality: a schema's pattern is a plain string and may not be a valid regex; a bare `new RegExp` throws, so it must be try/catch'd
- required / properties must not be gated behind `type: "object"`: a valid schema may omit type, and the object-branch checks must still run when type is undefined
- `"key" in obj` can be fooled by the `__proto__` prototype chain: own-property checks must use `Object.hasOwn`
- Without an additionalProperties constraint, extra fields pass by default; that is the actual TypeBox shape, and there is nothing to tighten

### Known risks and maintenance

#### createFakePi's blacklist-stub leak surface

createFakePi spreads `{ ...realPi }` and stubs by blacklist: only registration-class methods and `events.on` are replaced; unstubbed methods (exec, sendMessage, appendEntry, events.emit, ...) reach the real pi during a factory replay. The extensions currently lazy-listed only call registration methods and events.on during their factory phase, so the risk is manageable. If a target extension upgrade introduces factory-phase side effects, re-evaluate; the long-term plan is explicit whitelist delegation that allows only methods confirmed to be harmless.

#### Module instance identity depends on jiti's require cache

The replay load and pi's extension load must resolve to the same module instance. If they diverge, a target extension holding module-level mutable state (e.g. a task registry) ends up with two copies, and the same operation runs twice. After upgrading pi or a target extension, regression-test the target extension's core call chain.

#### When lazy-loading pays off

Lazy-loading keeps low-frequency definitions out of the main agent's context, at the cost of an omnify search / re-call round-trip per use. Low-frequency tools with simple parameters benefit most (remote proxies, session-resume tools); keep hot tools in `resident`.

#### Troubleshooting

- Tools not hidden or `omnify` missing: start a new session first (pitfall 2)
- "Tool metadata not found": check the `--tools` whitelist (pitfall 1)
- List not taking effect: check the merge rules; the project config overrides the user config entirely (empty array included)
- After upgrading pi or a target extension: regression-test the target extension's core call chain; if factory-phase behavior changed, re-evaluate the createFakePi stubs

### References

- pi official docs, docs/extensions.md, "Dynamic Tool Loading": the official activation mechanism, native deferred model requirements, cache notes
- pi-lazy-extensions (GitHub, experimental): extension-level lazy loading, the comparison baseline for the design decisions

## Development

Tests live in `test/`, 97 cases (68 unit + 29 integration):

```bash
cd pi-lazy-tools
npm install
npm test            # node --import tsx --test test/core.test.ts test/integration.test.ts
npm run typecheck   # tsc --noEmit (strict mode)
```

Coverage: config merging, schema pre-validation edge cases (invalid pattern, object schema without an explicit type, `__proto__` keys, required error messages), the omnify four-in-one wiring (schema-first zero execution, explicit tool naming, invalid params not executed, factory memoization, skill hits returning SKILL.md paths). Integration tests load the extension source for real.

## License

MIT