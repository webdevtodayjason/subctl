// context7 — query up-to-date library documentation via the Context7 MCP
// HTTP gateway. Lets master cite current docs (e.g. "what's the React 19
// API for use()?") instead of guessing from training-data cached state.
//
// The same Context7 MCP server gets dropped into every dev-team Claude
// Code session via a .mcp.json snippet (see providers/claude/teams.sh
// after Phase 3c.1) so leads + workers can call it directly during work.
//
// Endpoint: https://mcp.context7.com/mcp (JSON-RPC over HTTP).
// Auth:     header `CONTEXT7_API_KEY: <key>` from env.

const CONTEXT7_URL = process.env.SUBCTL_CONTEXT7_URL ?? "https://mcp.context7.com/mcp";

function getApiKey(): string | null {
  return (process.env.CONTEXT7_API_KEY ?? "").trim() || null;
}

let _rpcId = 0;
async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T | { error: string }> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { error: "CONTEXT7_API_KEY env var not set on the master daemon process. Set it in ~/Library/LaunchAgents/com.subctl.master.plist EnvironmentVariables and reload the launchd job." };
  }
  _rpcId++;
  try {
    const r = await fetch(CONTEXT7_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "CONTEXT7_API_KEY": apiKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: method, arguments: params },
        id: _rpcId,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return { error: `HTTP ${r.status}: ${text.slice(0, 300)}` };
    }
    // The MCP server responds either with application/json or with a single
    // SSE event. Both contain the same JSON-RPC payload — parse defensively.
    const ct = r.headers.get("content-type") ?? "";
    let json;
    if (ct.includes("text/event-stream")) {
      const text = await r.text();
      const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) return { error: "no data line in SSE response" };
      json = JSON.parse(dataLine.slice(6));
    } else {
      json = await r.json();
    }
    if (json.error) return { error: json.error.message ?? JSON.stringify(json.error) };
    return json.result as T;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export const context7Tools = {
  context7_resolve: {
    description:
      "Resolve a library name (e.g. 'react', 'next.js', 'typebox') to a Context7-compatible library ID. Pre-step before context7_docs when you don't already know the canonical ID. Returns a list of candidate libraries with their IDs and snippet counts.",
    schema: {
      type: "object",
      properties: {
        library: {
          type: "string",
          description: "Library name to resolve, e.g. 'react' or 'tailwindcss'.",
        },
      },
      required: ["library"],
    },
    invoke: async ({ library }: { library: string }) => {
      // Context7's MCP gateway has been inconsistent about whether it
      // expects `libraryName` or `query` — observed both error messages
      // hours apart. Send both to be safe; whichever it doesn't expect
      // will be ignored.
      const r = await rpc<{ content?: Array<{ type: string; text: string }> }>(
        "resolve-library-id",
        { libraryName: library, query: library },
      );
      if ("error" in r) return { ok: false, error: r.error };
      const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return { ok: true, library, raw: text.slice(0, 4000) };
    },
  },

  context7_docs: {
    description:
      "Fetch up-to-date documentation for a library by topic via Context7. Use when you need current API references / examples / configuration for a third-party tool — don't guess from cached training data, especially for fast-moving libraries (React, Next.js, Tailwind, AI SDKs). The library_id can come from context7_resolve, OR you can pass a known canonical ID like '/vercel/next.js'. Topic narrows the docs (e.g. 'app router', 'server components').",
    schema: {
      type: "object",
      properties: {
        library_id: {
          type: "string",
          description: "Context7-compatible library ID (e.g. '/vercel/next.js'). Use context7_resolve first if unknown.",
        },
        topic: {
          type: "string",
          description: "Optional topic narrowing (e.g. 'hooks', 'app router', 'authentication').",
        },
        tokens: {
          type: "number",
          description: "Approximate max docs token budget. Default 5000, cap 20000.",
        },
      },
      required: ["library_id"],
    },
    invoke: async ({
      library_id,
      topic,
      tokens,
    }: {
      library_id: string;
      topic?: string;
      tokens?: number;
    }) => {
      const tokBudget = Math.max(500, Math.min(20_000, tokens ?? 5_000));
      const args: Record<string, unknown> = {
        context7CompatibleLibraryID: library_id,
        tokens: tokBudget,
      };
      if (topic) args.topic = topic;
      const r = await rpc<{ content?: Array<{ type: string; text: string }> }>(
        "get-library-docs",
        args,
      );
      if ("error" in r) return { ok: false, error: r.error };
      const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return {
        ok: true,
        library_id,
        topic: topic ?? null,
        tokens_requested: tokBudget,
        chars_returned: text.length,
        docs: text,
      };
    },
  },

  context7_health: {
    description:
      "Verify that Context7 is configured (CONTEXT7_API_KEY env var set) and reachable. Returns a status snapshot.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      const key = getApiKey();
      if (!key) return { ok: false, error: "CONTEXT7_API_KEY not set in master env" };
      // Smallest-possible call to validate auth + connectivity
      const r = await rpc<{ content?: Array<{ type: string; text: string }> }>(
        "resolve-library-id",
        { libraryName: "react", query: "react" },
      );
      if ("error" in r) return { ok: false, error: r.error, host: CONTEXT7_URL };
      return { ok: true, host: CONTEXT7_URL, key_present: true, sample_resolved: !!(r.content?.length) };
    },
  },
};
