# pi-lazy-tools

Let low-frequency tools load on demand, the way Skills do, inside pi.

> English | [中文](README.md)
>
> npm package: @wolido/pi-lazy-tools

The tools the main agent can call, and the multi-kilobyte manuals attached to each of them, largely decide what it can do. Those manuals appear in full on every request, including the ones used in maybe 5% of sessions: the agent has to re-read all of them every round to find what the current task actually needs. We worked out this "clean context" philosophy at the subagent level with [async-subagent-isolation](https://github.com/Wolido/async-subagent-isolation), where the main agent only assigns work and never touches task details. The tool dimension has the same problem left: low-frequency definitions are present every round.

Skills solve the same problem with progressive disclosure: load only what is needed. pi-lazy-tools applies that idea to tools. Registration stays as-is (the `--tools` whitelist and pi runtime metadata are untouched); at session start every non-resident tool (all installed tools by default) is removed from the LLM-visible active set, granular to individual tools, so a single extension can be partially hidden. When one is needed, `load_tools` injects its usage instructions as plain text and `call_tool` executes on its behalf; the actual execution is always the target extension's own `execute`. After the removal, the context holds only the tools the agent actually uses; attention stops being spent on low-frequency manuals. Because the tools field and the system prompt never change during a session, lazy loading never invalidates the cache, on any model (argument in [How it works](#how-it-works)).

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
3. Start a new session (extensions load at session start; an old session has no `load_tools`)

typebox: the extension imports typebox directly (the same one pi uses; it lives in the root node_modules).

### Minimal config

With no configuration file, the plugin **lazies everything by default**: every installed tool (including built-ins like `read`, `bash`) is loaded on demand except the resident `load_tools`, `call_tool`, `skill_search`; the skills roster stays out of the system prompt too and is reachable only via `skill_search`. The config's `resident` array lists the exceptions (tools that stay always-on); `"resident": []` means no exceptions — everything is lazy.

```jsonc
// ~/.pi/lazy-tools.json
{
  "resident": ["read", "bash"]
}
```

List the tools that stay always-on and out of the lazy set (e.g. `read`, `bash`); everything else loads on demand. Inverted picking criteria in [Picking tools to lazy-load](#picking-tools-to-lazy-load).

Putting the file at `<cwd>/.pi/lazy-tools.json` scopes it to the current project and overrides the user-level list entirely (merge rules in [Configuration](#configuration)).

### Picking tools to lazy-load

Everything is lazy by default, so the criteria below invert: keep the `resident` exceptions to hot, must-have tools — every other use would otherwise cost an extra `load_tools` round-trip.

Go through the tools registered in pi's tool list: anything with a long description and a sizeable parameter schema, yet used once every few days, is a candidate. Two criteria: low frequency (days between uses) and simple parameters (one or two fields per call). Keep hot tools out of the lazy set (put them in `resident`); the extra `load_tools` round-trip per use is a net loss.

### Usage example

Tell the main agent: "activate deploy_tool and deploy the current version to staging". The flow has three steps:

1. `load_tools({ tools: ["deploy_tool"] })`
   zero side effects; returns only a challenge text and activates nothing. The challenge lists each tool's name and description, states that this call loaded or activated nothing, warns that after confirmation the tools will be activated (per-session) and callable via call_tool, and spells out the exact second-call shape
2. `load_tools({ tools: ["deploy_tool"], confirm: true })`
   activates the tools for real and returns the usage instructions: description, parameter JSON Schema, guidelines
3. `call_tool({ tool: "deploy_tool", params: { env: "staging" } })`
   deploy_tool executes for real, the result is passed through unchanged

The second step must rest on an explicit user request to load: naming "activate deploy_tool" counts. When the user names no tool, the main agent must not load a tool merely because it judged the task needs one; it should ask the user first.

## Usage

### load_tools: on-demand usage injection

`load_tools` has a two-step confirmation gate: the `confirm` parameter is an optional boolean, defaulting to false. A call without `confirm: true` has zero side effects: it registers nothing, activates nothing, and only returns a challenge text (with `confirmRequired: true` in details):

```
Load confirmation: the tools below will be activated after confirmation and become callable via call_tool. This call loaded or activated nothing.

Note: only load tools when the user explicitly asks for them; before confirming the load, make sure this is something the user explicitly asked for.

- deploy_tool: <description>

To confirm the load, call again: load_tools({ tools: ["deploy_tool"], confirm: true })
```

The challenge lists each tool to be loaded with its name and description, states that nothing was loaded or activated by this call, warns that after confirmation the tools will be activated (per-session) and callable via call_tool, and finally spells out the exact second-call shape. The same "only on explicit user request" constraint is written into load_tools' own promptGuidelines: `"Only load tools when the user explicitly asks for them; never load on your own initiative."`

Only a second call with `confirm: true` actually adds the tools to the per-session activated set and reads the target tool's description, parameter JSON Schema (pretty-printed) and promptGuidelines from `getAllTools()` (runtime metadata available after registration, independent of active state), assembling them into a Markdown text block appended to the message stream as a tool_result. The model reads the usage like a document. The tools field and the system prompt are never touched.

Edge cases: an empty request returns a "no tools requested" notice directly; a request where every tool is off the lazy list returns a direct rejection. Neither case enters the confirmation gate, so no confirmRequired appears.

Whitelist filtering: requesting a tool outside the list returns "Rejected (not in the lazy list)"; a tool inside the list but not registered returns "tool metadata not found" (usually the tool is missing from the `--tools` whitelist, see [Pitfall 1](#1---tools-is-a-strict-registration-whitelist)).

### call_tool: proxied invocation

Four gates; the target tool is never touched if any of them fails:

1. Whitelist check: the target must be listed in lazy-tools.json
2. Activation gate: it must first be activated via `load_tools({ tools: [...], confirm: true })` (activation is per-session memory, cleared at session start)
3. JSON Schema pre-validation: supports the subset type / required / enum / pattern / properties / additionalProperties / items; invalid input returns field-path errors (e.g. `role: expected one of [admin, member], got "foo"`), and the target execute is not run
4. Replay-capture execute: run the target extension's factory with a fake pi (createFakePi), intercept the ToolDefinition it registers via registerTool (including the real execute), memoized by `${sourcePath}#${name}` (each tool's factory replays at most once per session), then call `definition.execute` with the original params, signal, onUpdate and ctx; the result is returned unchanged

### Call order

- `call_tool` requires the target to be activated via `load_tools({ tools: [...], confirm: true })` first; unactivated calls are rejected with a hint showing the exact `load_tools({ tools: ["<tool name>"], confirm: true })` call
- Activation is per-session memory, cleared at session start
- Both resident tools' promptGuidelines state the "load_tools first, then call_tool" order; load_tools' guidelines also require loading only when the user explicitly asks. The exact confirm: true call shape is presented by the challenge text and call_tool's rejection hint for unactivated tools

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

**Note: the --tools whitelist must register every tool you want to lazy-load.** Registration and hiding are two separate things: --tools registers, the extension hides. A tool missing from --tools never reaches `getAllTools()`, so `load_tools` returns "tool metadata not found"; `resident` only decides who stays always-on and does not replace registration (see [Pitfall 1](#1---tools-is-a-strict-registration-whitelist)).

## How it works

The full lazy-load call chain:

```
Session start (session_start, before the first request)
  read both config levels → remove all non-resident tools from the active set → ensure load_tools / call_tool
  tools field frozen afterwards; system prompt never changes
        │
main agent needs a tool
        ▼
load_tools({ tools: ["deploy_tool"] })
  whitelist filter → return a challenge text (zero side effects, confirmRequired: true)
  list target tool names and descriptions, warn about activation, spell out the confirm: true call shape
        ▼
user confirms the load is explicitly requested
        ▼
load_tools({ tools: ["deploy_tool"], confirm: true })
  confirmation gate passed → tools join the per-session activated set
  pull Description + parameter JSON Schema + Guidelines from getAllTools(), assemble a plain-text tool_result
        │
main agent shapes params per the usage
        ▼
call_tool({ tool: "deploy_tool", params: { env: "staging" } })
  whitelist check → activation gate → schema pre-validation → replay target extension factory
  capture and call the real execute → pass through the result unchanged
```

Four things worth knowing:

- session_start (before the first request) is the only place the tools field is written; from then on the tools field and the system prompt stay frozen
- `load_tools` returns a zero-side-effect challenge on the first call; only a second call with `confirm: true` assembles the target tool's description, parameter Schema and guidelines into a plain-text tool_result appended at the end of the message stream; the model reads it like a document
- `call_tool` passes four gates, then replays the target extension's factory to capture the real execute; the result is passed through unchanged
- Consequently lazy loading never invalidates the cache, on any model or provider (argument below)

<details>
<summary>Cache safety: why zero invalidation on any model</summary>

Prompt caches match on a prefix: after serialization, the prefix shared with the previous request hits the cache; any byte change after the prefix pushes everything downstream out of cache. The tools field sits at the start of the serialized request, and the system prompt even earlier; changing either one invalidates the whole round.

This design handles both:

- the tools field is written exactly once at session_start (before the first request) and then stays frozen
- the system prompt never changes: lazy tools are never activated, so promptGuidelines structurally cannot enter the system prompt

All message growth within a session happens at the end of the stream: `load_tools`' injected usage and `call_tool` results are appended content, and appends do not touch the prefix. Conclusion: on any model and provider, lazy loading causes zero cache invalidations.

</details>

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

- One extra indirection: the model sees `call_tool`; the target tool is not in the tool list
- Parameter validation is offloaded: no provider-level schema validation backs this up; the in-extension pre-validation compensates
- Coarser UI and permission granularity: target tools get no dedicated permission prompts or rendering; they surface as `call_tool`

#### Why not extension-level lazy loading (the pi-lazy-extensions approach)

pi-lazy-extensions lazy-loads whole extensions: it dynamically imports entire extension modules via jiti, saving extension load cost, and it has known defects such as sourceInfo attribution errors (experimental project).

This design optimizes what each request carries in context: low-frequency definitions occupy attention every round, more so as sessions lengthen and retries accumulate. Granularity therefore has to be per tool; tools of the same extension can be hidden selectively, named individually in `lazy-tools.json`.

#### Why no need to strip guidelines from the system prompt

promptGuidelines enter the system prompt only while a tool is active. Tools here are never activated, so they never appear in the tools field and their guidelines structurally cannot show up in the system prompt. There is nothing to strip. This is a free cache dividend of the never-activate route, and the mirror image of pitfall 3.

### Pitfalls

#### 1. --tools is a strict registration whitelist

Tools outside `--tools` are not even visible to `getAllTools()`, surfacing as "tool metadata not found" from `load_tools`. pi-lazy-tools only hides visibility; registration must come from --tools. Lesson: `--tools` owns registration; the config's `resident` array owns who stays out of the lazy set — different jobs, one does not replace the other.

#### 2. Extensions load at session start

After installing or modifying the extension, the main agent claims there is no `load_tools`. Extensions load when the session is created; old sessions (resume included) do not have the new extension. When debugging "the main agent does not activate", opening a new session is the first move; rule this out first.

#### 3. promptGuidelines rebuild the system prompt on activation

Activating a tool with promptGuidelines via setActiveTools rebuilds the system prompt wholesale; even with native deferred schemas, that change still invalidates the prefix. The official docs explicitly advise lazy tools to omit prompt metadata. It is a hidden cache killer for any setActiveTools approach; this design never activates, so it sidesteps it entirely.

#### 4. pi swallows exceptions from the session_start handler

An exception thrown inside session_start is silently swallowed by pi: tools stay visible, the list stays inactive, and there is no error output at all, which is very hard to debug. Counter-measure: wrap the whole handler in try/catch and log with console.warn yourself (as the extension source does).

#### 5. jiti's injected require can load .ts and has a module cache

`findToolDefinition` relies on the require injected by jiti to load the target extension's source path directly (.ts loads fine, modules are cached), an undocumented behavior that the replay mechanism builds on. Two consequences: the factory replay must be memoized by `(sourcePath, name)`, otherwise every call_tool re-runs the target extension's factory and doubles its side effects; and the fake pi must stub subscription entry points such as `events.on`, otherwise a target extension that starts subscribing during the factory phase after an upgrade will leak into the real pi.

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

Lazy-loading keeps low-frequency definitions out of the main agent's context, at the cost of a two-step `load_tools` confirmation round-trip and the `call_tool` indirection per use. Low-frequency tools with simple parameters benefit most (remote proxies, session-resume tools); keep hot tools in `resident`.

#### Troubleshooting

- Tools not hidden or `load_tools` missing: start a new session first (pitfall 2)
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

Coverage: config merging, whitelist filtering, schema pre-validation edge cases (invalid pattern, object schema without an explicit type, `__proto__` keys, required error messages), the load_tools two-step confirmation gate (challenge text content, confirm omitted or false activates nothing, confirm: true activates, empty and all-rejected requests skip the gate, the user-explicitly-asks constraint) and the call_tool end-to-end wiring (unactivated call rejected, invalid params not executed, factory memoization, events.on stubbing). Integration tests load the extension source for real.

## License

MIT