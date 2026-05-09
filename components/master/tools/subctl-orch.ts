// subctl orchestration control plane — exposed to subctl master as tools.
// All calls go via the dashboard HTTP API at SUBCTL_API (default
// http://127.0.0.1:8787). The dashboard service must be running.

const API = process.env.SUBCTL_API ?? "http://127.0.0.1:8787";

async function apiGet<T = unknown>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`subctl ${path} → HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

async function apiPost<T = unknown>(
  path: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`subctl ${path} → HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export const subctlOrchTools = {
  /**
   * List currently running orchestrator sessions.
   * Returns: name, attached, account_dir, project_path, last_activity.
   */
  list: {
    description:
      "List all running orchestrator (worker) sessions. Use this to walk the portfolio.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      return apiGet("/api/orchestration");
    },
  },

  /**
   * Get detailed status of one session by name.
   * Returns: pane preview, last activity, attached state, account dir.
   */
  status: {
    description:
      "Get the live state of a specific orchestrator session by name. Use this to detect stalls (no thinking indicator + idle prompt) or check progress.",
    schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    invoke: async ({ name }: { name: string }) => {
      return apiGet(`/api/orchestration/${encodeURIComponent(name)}`);
    },
  },

  /**
   * Spawn a new worker orchestrator on a named project.
   * IRREVERSIBLE-ish (creates a tmux session, consumes rate-limit headroom).
   * Master should consult policy.json before invoking.
   */
  spawn: {
    description:
      "Spawn a worker orchestrator on a named account + project with a specific mandate (prompt). Costs rate-limit on the chosen account. Check subctl radar before invoking.",
    schema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description:
            "Account alias from accounts.conf (e.g. claude-titanium, claude-jason).",
        },
        project: {
          type: "string",
          description: "Absolute path to the project directory.",
        },
        prompt: {
          type: "string",
          description: "First message piped into the spawned session.",
        },
        orchestrator: {
          type: "boolean",
          description: "Spawn with the orchestrator flag (Team* tools available).",
          default: false,
        },
        skip_perms: {
          type: "boolean",
          description:
            "Pass --dangerously-skip-permissions. Required for autonomous workers.",
          default: true,
        },
      },
      required: ["account", "project", "prompt"],
    },
    invoke: async (args: {
      account: string;
      project: string;
      prompt: string;
      orchestrator?: boolean;
      skip_perms?: boolean;
    }) => {
      return apiPost("/api/orchestration/spawn", {
        account: args.account,
        project: args.project,
        prompt: args.prompt,
        orchestrator: args.orchestrator ?? false,
        skip_perms: args.skip_perms ?? true,
      });
    },
  },

  /**
   * Inject a message into a running session's tmux pane.
   * The agent picks it up on its next turn.
   */
  msg: {
    description:
      "Inject a message into a running worker session. Use to nudge a stalled worker, deliver a follow-up question, or course-correct. The worker sees the message in its conversation context.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        text: { type: "string" },
      },
      required: ["name", "text"],
    },
    invoke: async ({ name, text }: { name: string; text: string }) => {
      return apiPost(
        `/api/orchestration/${encodeURIComponent(name)}/msg`,
        { text },
      );
    },
  },

  /**
   * Gracefully kill an orchestrator session by name. The tmux session is destroyed.
   * IRREVERSIBLE — must consult policy.json (e.g. don't kill sessions with unsaved
   * working state).
   */
  kill: {
    description:
      "Kill a worker orchestrator session by name. Destroys the tmux session. IRREVERSIBLE — verify the worker has no unsaved working state first via status().",
    schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    invoke: async ({ name }: { name: string }) => {
      return apiPost(`/api/orchestration/${encodeURIComponent(name)}/kill`);
    },
  },

  /**
   * Read overall subctl state — accounts, sessions, dispatch verdict, rate-limit headroom.
   * Use this BEFORE spawning to check headroom.
   */
  state: {
    description:
      "Get full subctl state: dispatch verdict, all accounts with rate-limit headroom, all sessions, recent RL events. Call this before spawning a worker to verify headroom.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      return apiGet("/api/state");
    },
  },

  /**
   * Read pending operator-replies + system notifications from the inbox.
   */
  inbox: {
    description:
      "Read the operator-notify inbox — pending replies to ask-yesno questions, status messages, etc.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      return apiGet("/api/notify/inbox");
    },
  },
};
