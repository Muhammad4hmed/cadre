/**
 * Controllable stand-in for @anthropic-ai/claude-agent-sdk, swapped in via an
 * esbuild alias. Lets the lifecycle tests drive failure modes that are hard to
 * provoke against the real CLI: a stream that ends silently, a subprocess that
 * crashes mid-run, disposal while busy.
 */
/**
 * esbuild inlines this module into the bundle under test, so the test process
 * and the bundle each hold their own copy. Park the registry on globalThis so
 * both copies observe the same array.
 */
const registry = (globalThis.__AI_TEAM_FAKE_SDK__ ??= { instances: [], sessions: [] });
export const __instances = registry.instances;
export const __registry = registry;

export function query({ prompt, options }) {
  const outbox = [];
  const received = [];
  const receivedUuids = [];
  let wake = null;
  let ended = false;
  let failure = null;

  const nudge = () => { const w = wake; wake = null; w?.(); };

  const control = {
    options,
    /**
     * The prompt exactly as handed over. A nested run is given a plain string,
     * so `received` (which iterates the prompt) sees it one character at a
     * time — useless for asserting what an agent was actually told.
     */
    prompt: typeof prompt === "string" ? prompt : undefined,
    received,
    receivedUuids,
    interrupts: 0,
    closed: false,
    emit(message) { outbox.push(message); nudge(); },
    /** Stream completes normally, as when the CLI exits cleanly. */
    end() { ended = true; nudge(); },
    /** Stream throws, as on a transport error or crash. */
    fail(error) { failure = error; ended = true; nudge(); },
  };
  registry.instances.push(control);

  void (async () => {
    for await (const message of prompt) {
      const content = message?.message?.content;
      received.push(typeof content === "string" ? content : JSON.stringify(content));
      if (message?.uuid) receivedUuids.push(message.uuid);
      nudge();
    }
  })();

  const stream = (async function* () {
    while (true) {
      if (outbox.length) { yield outbox.shift(); continue; }
      if (failure) throw failure;
      if (ended) return;
      await new Promise((resolve) => { wake = resolve; });
    }
  })();

  stream.interrupt = async () => { control.interrupts += 1; };
  stream.close = () => { control.closed = true; ended = true; nudge(); };
  stream.setPermissionMode = async () => {};
  stream.setModel = async () => {};
  return stream;
}

export function initMessage(overrides = {}) {
  return {
    type: "system", subtype: "init", model: "test-model", cwd: "/tmp",
    claude_code_version: "0.0.0", apiKeySource: "none", tools: ["Read"],
    permissionMode: "default", mcp_servers: [], slash_commands: [], skills: [],
    plugins: [], output_style: "default", ...overrides,
  };
}

export function resultMessage(overrides = {}) {
  return {
    type: "result", subtype: "success", is_error: false, num_turns: 1,
    duration_ms: 10, total_cost_usd: 0.01, result: "ok", ...overrides,
  };
}

/** Enough of the in-process MCP surface for the orchestrator to construct itself. */
/** The start of an assistant turn. Deltas are ignored until one arrives. */
export function messageStart(id = "m1") {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "message_start", message: { id } },
  };
}

/** A streamed prose delta, as the CLI emits it. */
export function textDelta(text) {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

/** An assistant turn carrying tool calls. */
export function assistantMessage(content) {
  return { type: "assistant", parent_tool_use_id: null, message: { content } };
}

/** The CLI summarised the history and carried on in the same conversation. */
export function compactBoundary(trigger = "auto") {
  return {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger, pre_tokens: 180000, post_tokens: 42000 },
  };
}

export function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

export function createSdkMcpServer(options) {
  return { type: "sdk", name: options.name, instance: { __fake: true }, tools: options.tools ?? [] };
}

/** A stored transcript, so resume can be tested without the real store. */
export async function getSessionMessages(_id, _options) {
  return registry.messages ?? [];
}

/** Stored sessions the home screen lists. Tests set registry.sessions. */
export async function listSessions(_options) {
  return registry.sessions ?? [];
}
