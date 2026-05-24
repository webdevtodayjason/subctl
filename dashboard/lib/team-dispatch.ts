// dashboard/lib/team-dispatch.ts — v2.8.0 team-template dispatch helpers.
//
// Pure module so bun:test can exercise it without booting the dashboard
// HTTP server. The exported helpers:
//
//   - readTeamMeta / writeTeamMeta:  per-team meta.json at
//     ~/.local/state/subctl/teams/<team_id>/meta.json. Stores the template
//     name + the developer→tmux-window mapping. Read by the orchestration
//     status endpoint so the master tool subctl_team_dispatch knows the
//     team was spawned from a template.
//
//   - resolveDispatchTarget: given (team_id, developer_name), look up the
//     team's meta + load its template, validate the developer exists, and
//     return the routing info the HTTP handler needs to deliver the task.
//
//   - tmuxWindowForDeveloper: deterministic <session>:<window-name> target.
//
//   - buildDeveloperBootPrompt: composes the developer's first-message
//     prompt (persona + skills + roster + task) for lazy spawn.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  loadTemplate,
  type TeamTemplate,
  type TeamTemplateDeveloper,
  projectDeveloperToolScope,
} from "../../components/evy/team-templates";

// ─── per-team state on disk ─────────────────────────────────────────────────

export interface TeamMeta {
  /** Template name (filename without .toml) used to spawn this team. */
  template: string;
  /** Map of developer_name → tmux window name inside the team's session. */
  developer_panes: Record<string, string>;
  /** Spawn timestamp (ISO-8601). */
  spawned_at: string;
}

export function stateDir(): string {
  return process.env.SUBCTL_STATE_DIR ?? join(homedir(), ".local", "state", "subctl");
}

export function teamMetaPath(teamId: string): string {
  return join(stateDir(), "teams", teamId, "meta.json");
}

/** Read meta for a team; returns null if not template-spawned or missing. */
export function readTeamMeta(teamId: string): TeamMeta | null {
  const p = teamMetaPath(teamId);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as TeamMeta;
    if (typeof parsed.template !== "string" || !parsed.template) return null;
    if (parsed.developer_panes == null || typeof parsed.developer_panes !== "object") {
      parsed.developer_panes = {};
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Write meta for a team. Creates the parent dir if needed. */
export function writeTeamMeta(teamId: string, meta: TeamMeta): void {
  const p = teamMetaPath(teamId);
  const dir = join(p, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(meta, null, 2), "utf-8");
}

/** Record a fresh template spawn. Overwrites any existing meta. */
export function recordTemplateSpawn(teamId: string, template: string): TeamMeta {
  const meta: TeamMeta = {
    template,
    developer_panes: {},
    spawned_at: new Date().toISOString(),
  };
  writeTeamMeta(teamId, meta);
  return meta;
}

/** Mark a developer as having a live pane. Idempotent. */
export function recordDeveloperPane(
  teamId: string,
  developerName: string,
  windowName: string,
): TeamMeta | null {
  const meta = readTeamMeta(teamId);
  if (!meta) return null;
  meta.developer_panes[developerName] = windowName;
  writeTeamMeta(teamId, meta);
  return meta;
}

// ─── dispatch routing ───────────────────────────────────────────────────────

export interface DispatchTarget {
  team: string;
  template: TeamTemplate;
  developer: TeamTemplateDeveloper;
  /** Has this developer already been spawned into a pane on this team? */
  alreadySpawned: boolean;
  /** Deterministic tmux window name we'll create or send to. */
  windowName: string;
  /** Fully-qualified tmux target (session:window). */
  tmuxTarget: string;
}

export interface DispatchError {
  ok: false;
  error: string;
  /** True when caller could fall back to subctl_orch_msg. */
  recoverable?: boolean;
}

/**
 * Deterministic tmux window name for a developer. Plain "dev-<name>" so
 * the operator can find it quickly via `tmux list-windows -t <team>`.
 */
export function tmuxWindowForDeveloper(developerName: string): string {
  return `dev-${developerName}`;
}

/**
 * Resolve (team, developer_name) to a routable dispatch target. Returns
 * the parsed template + developer block + spawn state so the HTTP handler
 * can decide between lazy-spawn and live-pane delivery.
 */
export function resolveDispatchTarget(
  teamId: string,
  developerName: string,
): DispatchTarget | DispatchError {
  const meta = readTeamMeta(teamId);
  if (!meta) {
    return {
      ok: false,
      error: `team "${teamId}" was not spawned from a v2.8.0 team template (no meta.json found). Use subctl_orch_msg for free-form messages.`,
      recoverable: true,
    };
  }
  let template: TeamTemplate;
  try {
    template = loadTemplate(meta.template);
  } catch (err) {
    return {
      ok: false,
      error: `failed to load template "${meta.template}" for team "${teamId}": ${(err as Error).message}`,
    };
  }
  const developer = template.developers.find((d) => d.name === developerName);
  if (!developer) {
    return {
      ok: false,
      error: `developer "${developerName}" not in template "${meta.template}". Available: ${template.developers
        .map((d) => d.name)
        .join(", ")}`,
    };
  }
  const windowName = tmuxWindowForDeveloper(developerName);
  return {
    team: teamId,
    template,
    developer,
    alreadySpawned: developerName in meta.developer_panes,
    windowName,
    tmuxTarget: `${teamId}:${windowName}`,
  };
}

// ─── developer first-message composition ────────────────────────────────────

/**
 * Compose a developer worker's first message after lazy spawn:
 *   1. Persona / role declaration (TEMPLATE_PERSONA-style)
 *   2. Skills declaration (which skills are pre-installed)
 *   3. Tool scope summary (what bash commands they can run)
 *   4. The concrete task description from the lead
 *
 * Returns the assembled prompt string. The HMAC trust-marker wrap happens
 * downstream — this function just produces the message body.
 */
export function buildDeveloperBootPrompt(
  template: TeamTemplate,
  developer: TeamTemplateDeveloper,
  task: string,
): string {
  const scope = projectDeveloperToolScope(developer);
  const skillsLine = developer.skills.length
    ? developer.skills.join(", ")
    : "(none — generic context)";
  const bashLine =
    scope.bashAllowlist.length === 0
      ? "(no shell — Read/Edit/Write only)"
      : scope.bashAllowlist.includes("*")
        ? "(unconstrained — trusted mode)"
        : scope.bashAllowlist.join(", ");
  const permsLine = scope.permissions.length ? scope.permissions.join(", ") : "(Read by default)";

  return `[subctl developer role]
You are "${developer.name}" on team "${template.name}". Your role persona:
${developer.persona}

Skills pre-installed: ${skillsLine}
Permissions:          ${permsLine}
Shell allowlist:      ${bashLine}

You receive task assignments from your team lead via subctl's HMAC-authenticated
directive channel. Execute each assigned task to completion within your tool
scope, then report status back to the lead with a concise summary.
[/subctl developer role]

---

Your first task:

${task}
`;
}
