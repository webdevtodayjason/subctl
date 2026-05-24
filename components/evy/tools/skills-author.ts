// components/evy/tools/skills-author.ts — v2.8.1 Evy-authored skills.
//
// The operator-visible counterpart to the legacy skill-author.ts. That older
// tool wrote master-only skills into a private subdirectory of the imported
// skill catalog (~/.config/subctl/skills/master/skills/<cat>/<name>/) and was
// rendered into the dashboard's Skills tab under a quiet "master" source —
// which is exactly the visibility gap operator surfaced on 2026-05-13:
// *"I've got no visual when Evy creates her own skills."*
//
// This tool is the explicit, operator-curated channel:
//   1. Evy calls `evy_author_skill` with name/description/body/scope/reason.
//   2. The skill lands as a draft at ~/.local/state/subctl/evy-skills/<name>/
//      SKILL.md, with full v2.8.1 frontmatter (`created_by: evy` etc.).
//   3. A notification fires immediately (`kind: "evy-authored-skill"`) so the
//      tray + Telegram see it instantly.
//   4. The reason gets appended to ~/.local/state/subctl/audit/evy-skills.jsonl
//      so the operator has a per-call audit trail of WHY Evy created each.
//   5. The dashboard Skills tab shows the draft under "Evy-authored skills"
//      with [Promote to repo] and [Delete] buttons; Telegram /skills exposes
//      the same actions inline.
//
// We deliberately don't reuse the legacy skill-author.ts category allow-list
// or description-keyword regex here. Those guardrails were designed for the
// fire-and-forget "master writes to its own private catalog" flow. The
// curation channel is different: every draft passes through the operator
// before promotion, so the guardrails belong at the *promote* step, not at
// the author step. We do keep the kebab-case name regex and the repo-collision
// refusal — those are correctness gates, not policy gates.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  authorEvySkill,
  deleteEvySkill,
  evySkillsAuditLog,
  listSkills,
  promoteEvySkill,
} from "../skills-registry";
import { emitNotification } from "../notifications";

// Caller-supplied broadcast hook for the dashboard SSE bus. Wired at boot
// alongside notify.ts so this tool's notifications fan out without taking
// a direct dependency on server.ts.
let _broadcast: ((eventType: string, payload: unknown) => void) | null = null;

export function bindSkillsAuthorBroadcast(
  fn: (eventType: string, payload: unknown) => void,
) {
  _broadcast = fn;
}

function logAudit(entry: Record<string, unknown>) {
  try {
    const path = evySkillsAuditLog();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    );
  } catch {
    /* don't let audit failure block the action */
  }
}

export const evySkillsAuthorTools = {
  evy_author_skill: {
    description:
      "Persist a reusable pattern you've developed during this conversation as a SKILL.md draft. Use when you've worked out an approach the operator will benefit from re-using across sessions — recurring playbooks, MSP onboarding flows, escalation recipes, project bootstrap patterns. The draft lands under ~/.local/state/subctl/evy-skills/<name>/ where the operator can review it via the Skills tab and either promote it into the repo's components/skills/ (becoming canonical) or delete it. CONFIRM with the operator first unless they explicitly told you to capture the pattern. Every call emits an info notification + an audit-log entry containing your `reason`.",
    schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "kebab-case skill name. 2–49 chars, lowercase alphanumerics + dashes. Becomes the directory name and SKILL.md frontmatter `name`. Example: 'msp-client-onboarding'.",
        },
        description: {
          type: "string",
          description:
            "One-line summary, <400 chars. Shows up in the Skills tab list. Lead with the verb / purpose ('Walks the operator through MSP client intake...').",
        },
        body: {
          type: "string",
          description:
            "The full SKILL.md body (everything below the frontmatter). Markdown. Should include: when to use this skill, the procedure, what receipts to gather, what to escalate vs handle silently. The frontmatter is generated automatically — do NOT include `---` fences yourself.",
        },
        scope: {
          type: "string",
          enum: ["evy", "dev-team", "both"],
          description:
            "Who should load this skill. 'evy' = Evy's master persona only; 'dev-team' = available to team templates' developer rosters; 'both' = both surfaces. Project-local scoping is set when promoted, not here.",
        },
        reason: {
          type: "string",
          description:
            "What prompted you to create this skill — operator-facing audit trail. Will appear in the audit log + the notification body. Example: 'Same MSP onboarding steps came up in 4 conversations this week.'",
        },
      },
      required: ["name", "description", "body", "scope", "reason"],
    },
    invoke: async ({
      name,
      description,
      body,
      scope,
      reason,
    }: {
      name: string;
      description: string;
      body: string;
      scope: "evy" | "dev-team" | "both";
      reason: string;
    }) => {
      const trimmedReason = (reason ?? "").trim();
      if (!trimmedReason) {
        return {
          ok: false,
          error:
            "reason required — this is the audit trail line so the operator knows WHY you captured this pattern",
        };
      }
      const result = authorEvySkill({ name, description, body, scope, reason: trimmedReason });
      if (!result.ok) return result;

      // Audit log: capture name + reason + a small content snapshot so the
      // operator can reconstruct exactly what Evy wrote without re-reading
      // the file (which they may have already promoted / deleted).
      logAudit({
        action: "evy_author_skill",
        name,
        scope,
        description: description.slice(0, 240),
        reason: trimmedReason.slice(0, 600),
        path: result.path,
        char_count: body.length,
      });

      // Notification — info severity, so it lands in the tray without
      // demanding immediate attention. Operator can read it when they
      // glance, then jump to the Skills tab to review/promote/delete.
      try {
        emitNotification({
          kind: "evy-authored-skill",
          severity: "info",
          title: `Evy authored skill '${name}'`,
          body: `${description}\n\nReason: ${trimmedReason}\n\nReview in the Skills tab → Evy-authored.`,
          metadata: { name, scope, path: result.path, reason: trimmedReason },
        });
      } catch (err) {
        // notifications failure is non-fatal — the file was written and
        // audited; the tray notification is a nicety.
        console.error(
          `[evy_author_skill] notification failed: ${(err as Error).message ?? err}`,
        );
      }

      try {
        _broadcast?.("evy-authored-skill", {
          name,
          scope,
          path: result.path,
          description,
        });
      } catch {
        /* broadcast failure is non-fatal */
      }

      return {
        ok: true,
        path: result.path,
        name: result.name,
        message: `Draft saved. Operator can review at Skills tab → 'Evy-authored skills' (or via /skills evy on Telegram). Promote to make it canonical, delete to discard.`,
      };
    },
  },

  evy_list_authored_skills: {
    description:
      "List the skill drafts you've authored under ~/.local/state/subctl/evy-skills/. Returns each with name, description, scope, created_at, and path. Use before authoring a new skill to avoid duplicate names and to introspect what the operator has yet to review.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      const skills = listSkills({ category: "evy-authored", skipImported: true });
      return {
        ok: true,
        count: skills.length,
        skills: skills.map((s) => ({
          name: s.name,
          description: s.description,
          scope: s.scope,
          created_at: s.created_at,
          path: s.path,
        })),
      };
    },
  },

  evy_promote_skill: {
    description:
      "Promote one of your drafts from ~/.local/state/subctl/evy-skills/ into the repo's components/skills/<name>/. This is the operator's curation action — Evy should only call it when the operator explicitly asks ('promote that skill', '/promote <name>'). Adds promoted_at + promoted_by to the frontmatter so the audit trail survives. Does NOT auto-commit — operator reviews the file diff in git themselves.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The draft's kebab-case name." },
        promoted_by: {
          type: "string",
          description: "Who triggered the promotion. Usually 'operator'.",
        },
      },
      required: ["name", "promoted_by"],
    },
    invoke: async ({
      name,
      promoted_by,
    }: {
      name: string;
      promoted_by: string;
    }) => {
      const r = promoteEvySkill(name, promoted_by);
      if (!r.ok) return r;
      logAudit({ action: "evy_promote_skill", name, promoted_by, from: r.from, to: r.to });
      try {
        emitNotification({
          kind: "evy-authored-skill",
          severity: "info",
          title: `Skill '${name}' promoted to repo`,
          body: `Promoted by ${promoted_by}. Review the file diff in git: ${r.to}`,
          metadata: { name, promoted_by, to: r.to },
        });
      } catch {
        /* non-fatal */
      }
      return r;
    },
  },

  evy_delete_authored_skill: {
    description:
      "Delete one of your drafts from ~/.local/state/subctl/evy-skills/. Reserved for the operator's discard action — Evy should only call it when the operator explicitly asks ('delete that skill', '/skills delete <name>'). Repo-tracked skills cannot be removed via this path.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The draft's kebab-case name." },
        reason: { type: "string", description: "Why it's being deleted (audit trail)." },
      },
      required: ["name", "reason"],
    },
    invoke: async ({ name, reason }: { name: string; reason: string }) => {
      const r = deleteEvySkill(name);
      if (!r.ok) return r;
      logAudit({ action: "evy_delete_authored_skill", name, reason, removed: r.removed });
      return r;
    },
  },
};
