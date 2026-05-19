// subctl orchestration control plane — exposed to subctl master as tools.
// All calls go via the dashboard HTTP API at SUBCTL_API (default
// http://127.0.0.1:8787). The dashboard service must be running.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";

import {
  getTemplate,
  renderBootPrompt,
  listTemplates,
} from "../templates-loader";

const API = process.env.SUBCTL_API ?? "http://127.0.0.1:8787";

// Format a non-OK response so the supervisor sees the actual cause and
// can decide whether to retry, escalate, or fall back. Previously these
// helpers threw `subctl /api/... → HTTP 500` with no body — the supervisor
// (Evy) saw an opaque 500 from subctl_orch_spawn_template and abandoned
// the template path for raw spawn on first failure. Surfacing the
// dashboard's structured body (incl. error_kind) lets the model recover.
async function describeFailure(path: string, r: Response): Promise<string> {
  let detail = "";
  try {
    const text = await r.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as {
          error?: unknown;
          error_kind?: unknown;
        };
        const err = typeof parsed.error === "string" ? parsed.error : "";
        const kind = typeof parsed.error_kind === "string" ? parsed.error_kind : "";
        if (err && kind) detail = `${kind}: ${err}`;
        else detail = err || text;
      } catch {
        detail = text;
      }
    }
  } catch {
    // best-effort; fall through to bare status code
  }
  const head = detail.length > 600 ? detail.slice(0, 600) + "…" : detail;
  return head
    ? `subctl ${path} → HTTP ${r.status}: ${head}`
    : `subctl ${path} → HTTP ${r.status}`;
}

async function apiGet<T = unknown>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(await describeFailure(path, r));
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
  if (!r.ok) throw new Error(await describeFailure(path, r));
  return r.json() as Promise<T>;
}

// After a successful spawn, write a synthetic "spawned" event into the
// team's inbox file so the master daemon's inbox tailer registers the
// team into teamLastActivity immediately. Without this, /health reports
// teams_tracked: 0 and the Orchestration tab shows no teams until the
// worker self-reports — which may never happen for an idle worker.
//
// Diagnosed 2026-05-10 during the FOOTHOLD dogfood: a tmux session was
// alive and visible to `subctl orch list`, but the master saw nothing.
function seedInboxOnSpawn(result: unknown): void {
  if (!result || typeof result !== "object") return;
  const r = result as { ok?: boolean; session_name?: string };
  if (!r.ok || !r.session_name) return;
  try {
    const inboxDir = join(
      process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl"),
      "master",
      "inbox",
    );
    if (!existsSync(inboxDir)) mkdirSync(inboxDir, { recursive: true });
    const inboxFile = join(inboxDir, `${r.session_name}.jsonl`);
    const event = {
      ts: new Date().toISOString(),
      kind: "spawned",
      detail: "team spawned via subctl_orch_spawn(_template)",
      by: "master",
    };
    appendFileSync(inboxFile, JSON.stringify(event) + "\n");
  } catch {
    // Best-effort; the spawn itself succeeded. If inbox seeding fails,
    // the team still exists in tmux + subctl orch list, just not in the
    // master's tracking map until it self-reports.
  }
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
      "**Use this FIRST when** asked about a dev team's state, progress, or whether it's stalled. Don't guess from your context — query the actual pane. Returns pane preview, last activity, attached state, account dir.",
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
      const result = await apiPost("/api/orchestration/spawn", {
        account: args.account,
        project: args.project,
        prompt: args.prompt,
        orchestrator: args.orchestrator ?? false,
        skip_perms: args.skip_perms ?? true,
      });
      seedInboxOnSpawn(result);
      return result;
    },
  },

  /**
   * Spawn a worker orchestrator using a saved team template. Same as
   * spawn() but reads ~/.config/subctl/master/team-templates/<name>.json
   * to get the persona, skills, autonomy, and boot prompt — no need to
   * pass a freeform prompt. Use this when a template fits the work; use
   * raw spawn() only for one-offs that don't match any template.
   */
  spawn_template: {
    description:
      "Spawn a worker orchestrator using a saved team template. Reads ~/.config/subctl/master/team-templates/<template>.json for persona + skills + autonomy + boot prompt and applies them automatically. Prefer this over raw spawn() when a template fits — it codifies the role and skill set so dev-team behavior is consistent. Costs rate-limit on the chosen account just like spawn(). Always confirm with Jason before invoking — this is irreversible-ish (creates a tmux session, may push to git via the lead's work).",
    schema: {
      type: "object",
      properties: {
        template: {
          type: "string",
          description:
            "Template name (filename without .json). Use subctl templates list / the dashboard Teams tab to see available ones. Common: code-review, feature-dev.",
        },
        account: {
          type: "string",
          description: "Account alias from accounts.conf (e.g. claude-jason).",
        },
        project: {
          type: "string",
          description: "Absolute path to the project directory.",
        },
        prompt: {
          type: "string",
          description: "Optional additional scope to layer on top of the template's boot_prompt (e.g. 'Specifically focus on PR #42'). Empty if none.",
        },
      },
      required: ["template", "account", "project"],
    },
    invoke: async (args: {
      template: string;
      account: string;
      project: string;
      prompt?: string;
    }) => {
      // Resolve the template against the in-tree registry
      // (components/templates/<name>/). Surfacing the loader's clear
      // template_not_found / parse error here means the supervisor sees the
      // actual cause instead of a generic HTTP 500 from the bash flow.
      let rendered: string;
      try {
        // getTemplate throws if missing/invalid; render fills in vars.
        getTemplate(args.template);
        rendered = renderBootPrompt(args.template, {
          project_path: args.project,
          account: args.account,
          additional_scope: args.prompt ?? "",
        });
      } catch (err) {
        const { templates } = listTemplates();
        const available = templates.map((t) => t.metadata.name).join(", ");
        return {
          ok: false,
          error: `${(err as Error).message}${available ? ` — available: ${available}` : ""}`,
          error_kind: "template_not_found",
        };
      }
      // Post the rendered prompt directly. We deliberately do NOT forward
      // `template: args.template` to the spawn endpoint — that would invoke
      // the legacy `~/.config/subctl/master/team-templates/<name>.json` path
      // in providers/claude/teams.sh, which is a different registry and is
      // empty on fresh installs. The in-tree registry is the source of
      // truth from this point.
      const result = await apiPost("/api/orchestration/spawn", {
        account: args.account,
        project: args.project,
        prompt: rendered,
        orchestrator: false,
        skip_perms: true,
      });
      seedInboxOnSpawn(result);
      return result;
    },
  },

  /**
   * Inject a message into a running session's tmux pane.
   * The agent picks it up on its next turn.
   */
  msg: {
    description:
      "**Use this when** you need to inject a directive into a running worker — nudge a stalled team, deliver a follow-up, course-correct. Match operator style: terse, lowercase, imperative. Verbose hedged formal phrasing is a red flag workers correctly suspect. The runtime wraps the text in an HMAC-authenticated trust marker (v2.7.20 / ADR 0011 Layer 1) so the worker's lead cryptographically verifies it as a legitimate supervisor directive. Always include `phase` plus a short WHY — bare imperatives without context get refused.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        text: { type: "string" },
        phase: {
          type: "string",
          description:
            "Current phase / context — gets embedded in the directive marker so the worker knows where this fits in the work plan. Example: 'baseline-verification', 'feature-impl-step-3'. Optional but strongly recommended.",
        },
      },
      required: ["name", "text"],
    },
    invoke: async ({ name, text, phase }: { name: string; text: string; phase?: string }) => {
      const payload: Record<string, unknown> = { text };
      if (phase) payload.phase = phase;
      return apiPost(
        `/api/orchestration/${encodeURIComponent(name)}/msg`,
        payload,
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
      "**Use this when** a worker session must be torn down — confirmed shutdown, deliberate cleanup. Destroys the tmux session. IRREVERSIBLE. Requires `confirmation: true` and a `reason` (≥10 chars) so the destruction is on the record. Verify no unsaved working state first via status().",
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        confirmation: {
          type: "boolean",
          description:
            "Required. Must be literally `true`. Forces explicit acknowledgement that the worker is being destroyed — irreversible.",
        },
        reason: {
          type: "string",
          description:
            "Required. ≥10 chars. Short rationale for the kill — gets logged so the decision is recoverable later (e.g. 'worker completed deliverable, no longer needed' or 'paranoia-loop, restarting fresh').",
        },
      },
      required: ["name", "confirmation", "reason"],
    },
    invoke: async ({
      name,
      confirmation,
      reason,
    }: {
      name: string;
      confirmation?: boolean;
      reason?: string;
    }) => {
      if (confirmation !== true) {
        return {
          ok: false,
          error: "subctl_orch_kill requires explicit confirmation: true",
        };
      }
      if (typeof reason !== "string" || reason.trim().length < 10) {
        return {
          ok: false,
          error:
            "subctl_orch_kill requires a reason string of at least 10 chars",
        };
      }
      return apiPost(`/api/orchestration/${encodeURIComponent(name)}/kill`, {
        reason,
      });
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
