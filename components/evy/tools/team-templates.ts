// components/master/tools/team-templates.ts — v2.8.0 team-template tools.
//
// Exposes the team-template foundation to the master agent:
//
//   - subctl_team_template_list:     enumerate available templates
//   - subctl_team_template_show:     show one template's parsed shape
//   - subctl_team_dispatch:          dispatch work to a developer in a
//                                    template-spawned team
//
// All template I/O goes through the in-process loader at
// components/master/team-templates.ts (parse + validate + cache).
//
// Dispatch routing: each developer in the template gets its own tmux pane
// (lazy-created on first dispatch). Re-dispatching to a live developer
// injects the new task into the existing pane via the same trust-marker
// HMAC path used by subctl_orch_msg — so the worker can verify the message
// is a legitimate supervisor directive.

import {
  listTemplates,
  loadTemplate,
  type TeamTemplate,
} from "../team-templates";

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

/**
 * Shape returned by /api/orchestration/:name. We only need a few fields for
 * the dispatch decision, but `unknown` keeps us defensive against churn.
 */
interface OrchSessionStatus {
  ok?: boolean;
  name?: string;
  template?: string;
  /** Developer pane map populated by the spawn flow when a template is used. */
  developer_panes?: Record<string, string>;
}

/**
 * Render the team-roster summary line used by list/show. Kept tiny so it's
 * readable in chat without overwhelming the assistant's working memory.
 */
function summarizeTemplate(t: TeamTemplate): {
  name: string;
  description: string;
  lead_persona: string;
  developers: { name: string; persona: string; tools_count: number }[];
} {
  return {
    name: t.name,
    description: t.description,
    lead_persona: t.lead.persona,
    developers: t.developers.map((d) => ({
      name: d.name,
      persona: d.persona,
      tools_count: d.tools.length,
    })),
  };
}

export const teamTemplateTools = {
  /**
   * List all available team templates with their developer rosters.
   */
  subctl_team_template_list: {
    description:
      "List available v2.8.0 team templates (TOML, multi-developer rosters). Use BEFORE subctl_team_dispatch to confirm which developers exist in a template. Distinct from subctl_orch_spawn_template (legacy single-persona JSON templates).",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      const { templates, errors } = listTemplates();
      return {
        ok: errors.length === 0,
        count: templates.length,
        templates: templates.map(summarizeTemplate),
        errors,
      };
    },
  },

  /**
   * Show one template's full shape (lead + developers + skills + tools).
   */
  subctl_team_template_show: {
    description:
      "Show a single team template's full shape — lead persona, every developer's persona/skills/tools. Use when planning a team spawn so you know exactly what each developer can do.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Template name (filename without .toml)." },
      },
      required: ["name"],
    },
    invoke: async ({ name }: { name: string }) => {
      try {
        const t = loadTemplate(name);
        return {
          ok: true,
          name: t.name,
          description: t.description,
          path: t.path,
          lead: t.lead,
          developers: t.developers,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  },

  /**
   * Dispatch a concrete task to a named developer in a template-spawned team.
   * Lazy-spawns the developer's tmux pane on first call.
   */
  subctl_team_dispatch: {
    description:
      "**Use this when** the lead of a template-spawned team needs to assign work to a specific developer (e.g. frontend-dev, backend-dev). Validates the developer exists in the team's template, then routes the task to that developer's tmux pane via the trust-marker HMAC channel. Lazy-creates the developer's pane on first call. Distinct from subctl_orch_msg — that's free-form text to a single-pane worker; this is roster-aware dispatch to a multi-developer team.",
    schema: {
      type: "object",
      properties: {
        team: {
          type: "string",
          description:
            "Team session name (matches the tmux session_name from subctl_orch_spawn_template). Example: 'claude-myproject'.",
        },
        developer_name: {
          type: "string",
          description:
            "Developer to dispatch to. Must exist in the team's template (call subctl_team_template_show to confirm).",
        },
        task_description: {
          type: "string",
          description:
            "Concrete task with file paths + acceptance criteria. Don't pass bare imperatives — include the WHY and the DONE-WHEN.",
        },
        phase: {
          type: "string",
          description:
            "Optional phase / context — embedded in the directive marker so the developer knows where this fits in the work plan.",
        },
      },
      required: ["team", "developer_name", "task_description"],
    },
    invoke: async ({
      team,
      developer_name,
      task_description,
      phase,
    }: {
      team: string;
      developer_name: string;
      task_description: string;
      phase?: string;
    }) => {
      if (!task_description || task_description.trim().length < 10) {
        return {
          ok: false,
          error: "task_description must be >= 10 chars — include the WHY and the DONE-WHEN",
        };
      }

      // 1) Resolve the team's template via the orchestration status endpoint.
      let status: OrchSessionStatus;
      try {
        status = await apiGet<OrchSessionStatus>(
          `/api/orchestration/${encodeURIComponent(team)}`,
        );
      } catch (err) {
        return {
          ok: false,
          error: `team "${team}" not found via subctl orch status: ${(err as Error).message}`,
        };
      }
      const templateName = status.template;
      if (!templateName) {
        return {
          ok: false,
          error: `team "${team}" was not spawned from a v2.8.0 team template — subctl_team_dispatch requires one. Use subctl_orch_msg for free-form messages.`,
        };
      }

      // 2) Validate developer exists in template.
      let template: TeamTemplate;
      try {
        template = loadTemplate(templateName);
      } catch (err) {
        return {
          ok: false,
          error: `failed to load template "${templateName}": ${(err as Error).message}`,
        };
      }
      const dev = template.developers.find((d) => d.name === developer_name);
      if (!dev) {
        return {
          ok: false,
          error: `developer "${developer_name}" not in template "${templateName}". Available: ${template.developers.map((d) => d.name).join(", ")}`,
        };
      }

      // 3) Dispatch via the new /api/orchestration/:team/dispatch endpoint
      //    (dashboard server-side). The endpoint handles lazy pane creation
      //    + HMAC marker wrapping; we just supply the routing inputs.
      return apiPost(
        `/api/orchestration/${encodeURIComponent(team)}/dispatch`,
        {
          developer_name,
          task_description,
          phase: phase ?? undefined,
        },
      );
    },
  },
};
