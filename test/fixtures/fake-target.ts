/**
 * Fixture "target extension" for the lazy-tools integration tests.
 *
 * Mimics the OpenAaaS extension shape: registers one tool with an enum
 * `action` param, and subscribes via pi.events.on(...) during factory
 * execution (as the real OpenAaaS extension does). Both side effects are
 * observable through globalThis counters, so tests can assert on the
 * call_tool wiring without importing pi or typebox.
 */

export const FAKE_TOOL_NAME = "fake_discover";

export const FACTORY_CALLS_KEY = "__lazy_tools_fixture_factory_calls__";
export const EXECUTE_CALLS_KEY = "__lazy_tools_fixture_execute_calls__";

/** OpenAaaS-like JSON Schema (plain object, no typebox). */
export const FAKE_TOOL_SCHEMA = {
	type: "object",
	properties: {
		action: { type: "string", enum: ["discover", "submit"] },
		server: { type: "string" },
	},
	required: ["action"],
	additionalProperties: false,
} as const;

interface FixturePi {
	registerTool(tool: Record<string, unknown>): void;
	events?: { on(event: string, handler: () => void): void };
}

const g = globalThis as Record<string, unknown>;

function bump(key: string): number {
	const next = ((g[key] as number | undefined) ?? 0) + 1;
	g[key] = next;
	return next;
}

export default function factory(pi: FixturePi): void {
	// Counts factory *invocations* (not module loads) — findToolDefinition
	// re-runs this factory with a fake pi on every call_tool unless memoized.
	bump(FACTORY_CALLS_KEY);

	// The real OpenAaaS extension subscribes via pi.events.on(...). This call
	// must be swallowed by lazy-tools' fake pi instead of reaching the real pi.
	pi.events?.on("lazy-tools-fixture", () => {});

	pi.registerTool({
		name: FAKE_TOOL_NAME,
		label: "Fake Discover",
		description: "Fake OpenAaaS-like tool for lazy-tools integration tests.",
		parameters: FAKE_TOOL_SCHEMA,
		async execute(
			_toolCallId: unknown,
			params: { action?: string } | undefined,
		): Promise<{ content: Array<{ type: string; text: string }>; details: { executed: boolean } }> {
			bump(EXECUTE_CALLS_KEY);
			return {
				content: [{ type: "text", text: `fake ran: ${params?.action ?? ""}` }],
				details: { executed: true },
			};
		},
	});
}