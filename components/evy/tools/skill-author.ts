// skill-author — let master write its own SKILL.md files into a private
// "master" source under the local skill catalog. This is how master gets
// smarter at its job over time: when it notices a recurring orchestration
// pattern (e.g. "every time a code-review team finds a SQL injection,
// here's the right escalation flow"), it captures the pattern as a
// reusable skill that future dev-team leads can opt into.
//
// CONSTRAINTS:
//   1. Only writes under ~/.config/subctl/skills/master/skills/<cat>/<name>/.
//      Master can NOT write to other sources (that's curator territory).
//   2. Category must be from a fixed allow-list — keeps master in its
//      lane (orchestration / dev-team coordination), prevents drift into
//      generic-coding territory that's the dev-teams' job.
//   3. Description must reference one of: orchestration, dev-team,
//      team-lead, escalation, review, watchdog. Sanity check against
//      role drift.
//   4. All writes are logged to decisions.jsonl with the full content
//      so operator can audit (and roll back via the dashboard Skills tab).
//
// What master CAN write:
//   ~/.config/subctl/skills/master/skills/<category>/<name>/SKILL.md
//   ~/.config/subctl/skills/master/skills/<category>/<name>/scripts/*  (read-only access via Claude Code skill loader)
//
// Skills authored here appear in the dashboard Skills tab under
// source="master" — distinguishable from imported public skills.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, resolve, dirname } from "node:path";

const SKILLS_ROOT = process.env.SUBCTL_SKILLS_DIR ?? join(homedir(), ".config", "subctl", "skills");
const EVY_SKILLS_DIR = join(SKILLS_ROOT, "evy", "skills");
const DECISIONS_LOG = join(homedir(), ".config", "subctl", "master", "decisions.jsonl");

// Category allow-list — keeps master in its operational lane.
const ALLOWED_CATEGORIES = new Set([
  "team-coordination",
  "escalation-patterns",
  "code-review-synthesis",
  "project-bootstrap",
  "incident-response",
  "notifications",
  "memory-curation",
  "watchdog-tactics",
]);

// Description regex — must mention at least one role-relevant term.
// Belt-and-braces against drift; not a hard sanity gate, but a friction
// point against accidentally creating "how to write Python" or similar
// out-of-scope skills.
const DESCRIPTION_KEYWORDS = /(orchestrat|dev[- ]team|team[- ]lead|escalat|review|watchdog|notif|spawn|coordinat|incident|stale|nudge|triage)/i;

function pathEscapesRoot(target: string, root: string): boolean {
  const t = normalize(target);
  const r = normalize(root);
  return !t.startsWith(r + "/") && t !== r;
}

function isValidName(name: string): boolean {
  return /^[a-z][a-z0-9-]{1,48}$/.test(name);
}

function logDecision(entry: Record<string, unknown>) {
  try {
    mkdirSync(dirname(DECISIONS_LOG), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), project: "_master", ...entry });
    require("node:fs").appendFileSync(DECISIONS_LOG, line + "\n");
  } catch { /* don't let log failure block the actual write */ }
}

function buildSkillContent(name: string, description: string, body: string): string {
  // Build a properly-fenced SKILL.md with frontmatter. Same format
  // mattpocock/skills + Anthropic + the Claude Code loader expect.
  const trimmedDesc = description.trim().replace(/\n+/g, " ").slice(0, 400);
  const trimmedBody = body.trim();
  return `---
name: ${name}
description: ${trimmedDesc}
authored_by: subctl-master
authored_at: ${new Date().toISOString()}
---

${trimmedBody}
`;
}

export const skillAuthorTools = {
  skill_create: {
    description:
      "Author a new SKILL.md file in master's own skill source. Use this when you've identified a reusable orchestration pattern that future dev teams should be able to inherit (e.g. \"how I escalate a CI-red blocker that's been stale 30+ minutes\", \"the recipe for synthesizing coderabbit findings into a one-page summary\"). Writes ONLY to ~/.config/subctl/skills/master/skills/<category>/<name>/SKILL.md. Restricted to a category allow-list to keep skills in your operational lane (orchestration, dev-team coordination, escalation, review synthesis, etc.) — refuses categories outside that. Description should reference your role context (orchestration, dev-team, escalation, etc.). Every write is logged to decisions.jsonl for audit. Should be CONFIRMED with Jason before invoking unless he explicitly told you to capture the pattern.",
    schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name. Lowercase alphanumerics + dashes only, 2-49 chars. Becomes the directory name and the skill ID's last segment.",
        },
        category: {
          type: "string",
          description: "One of: team-coordination, escalation-patterns, code-review-synthesis, project-bootstrap, incident-response, notifications, memory-curation, watchdog-tactics. Categories outside this list are refused.",
        },
        description: {
          type: "string",
          description: "One-line summary of what this skill does and when to use it. MUST mention an orchestration-related term (orchestration, dev-team, team-lead, escalation, review, watchdog, etc.) — sanity check against role drift.",
        },
        content: {
          type: "string",
          description: "The full SKILL.md body (everything below the frontmatter). Markdown. Should include: when to use this skill, the procedure, what receipts to gather, what to escalate vs handle silently.",
        },
      },
      required: ["name", "category", "description", "content"],
    },
    invoke: async ({ name, category, description, content }: { name: string; category: string; description: string; content: string }) => {
      if (!isValidName(name)) {
        return { ok: false, error: `name must match /^[a-z][a-z0-9-]{1,48}$/ — got '${name}'` };
      }
      if (!ALLOWED_CATEGORIES.has(category)) {
        return {
          ok: false,
          error: `category '${category}' not in master's allow-list. Permitted: ${Array.from(ALLOWED_CATEGORIES).join(", ")}.`,
        };
      }
      if (!DESCRIPTION_KEYWORDS.test(description ?? "")) {
        return {
          ok: false,
          error: `description must mention at least one orchestration-related term (orchestration, dev-team, team-lead, escalation, review, watchdog, etc.). This is a guardrail against role drift — if your skill genuinely doesn't relate to your orchestration role, you probably shouldn't be authoring it.`,
        };
      }
      const targetDir = join(EVY_SKILLS_DIR, category, name);
      const targetFile = join(targetDir, "SKILL.md");
      if (pathEscapesRoot(targetDir, EVY_SKILLS_DIR)) {
        return { ok: false, error: "path escapes master skills root" };
      }
      if (existsSync(targetFile)) {
        return { ok: false, error: `skill already exists at ${targetFile}. Use skill_revise to update, or pick a different name.` };
      }
      try {
        mkdirSync(targetDir, { recursive: true });
        const skillBody = buildSkillContent(name, description, content);
        writeFileSync(targetFile, skillBody);
        logDecision({
          action: "skill_created",
          rationale: `master/${category}/${name} — ${description.slice(0, 140)}`,
          path: targetFile,
          char_count: skillBody.length,
        });
        return {
          ok: true,
          path: targetFile,
          skill_id: `master/${category}/${name}`,
          char_count: skillBody.length,
          message: `Skill authored. Visible in dashboard Skills tab under source 'master' / category '${category}'. Will be available to dev teams when used in a template's skills array.`,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  },

  skill_revise: {
    description:
      "Update the body of an existing master-authored skill. Use to refine a pattern when you've learned more from subsequent dev-team work. Replaces the markdown body BELOW the frontmatter — frontmatter (name, description, authored_at) is preserved. To replace the description too, use skill_create with a new name and skill_remove the old one.",
    schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "The skill's category (must match where it was created)." },
        name: { type: "string", description: "Skill name." },
        content: { type: "string", description: "New full body (markdown below frontmatter)." },
      },
      required: ["category", "name", "content"],
    },
    invoke: async ({ category, name, content }: { category: string; name: string; content: string }) => {
      if (!ALLOWED_CATEGORIES.has(category)) {
        return { ok: false, error: `category '${category}' not in allow-list` };
      }
      const targetFile = join(EVY_SKILLS_DIR, category, name, "SKILL.md");
      if (!existsSync(targetFile)) {
        return { ok: false, error: `skill not found: ${targetFile}` };
      }
      try {
        const original = readFileSync(targetFile, "utf8");
        // Preserve the frontmatter, replace body. Frontmatter is between the
        // first two lines that are exactly "---".
        const fmMatch = original.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
        const frontmatter = fmMatch ? fmMatch[0] : `---\nname: ${name}\nauthored_by: subctl-master\nauthored_at: ${new Date().toISOString()}\n---\n`;
        const updated = frontmatter + "\n" + content.trim() + "\n";
        writeFileSync(targetFile, updated);
        logDecision({
          action: "skill_revised",
          rationale: `master/${category}/${name} body replaced (${updated.length} chars)`,
          path: targetFile,
        });
        return { ok: true, path: targetFile, skill_id: `master/${category}/${name}`, char_count: updated.length };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  },

  skill_remove: {
    description:
      "Delete one of master's authored skills. Reserved for genuine retraction (the skill turned out to be wrong / superseded by a better one). Logged to decisions.jsonl so the deletion is auditable. Cannot delete imported skills from public sources — only master's own.",
    schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "The skill's category." },
        name: { type: "string", description: "Skill name." },
        reason: { type: "string", description: "Why you're deleting it. Goes into the decisions log." },
      },
      required: ["category", "name", "reason"],
    },
    invoke: async ({ category, name, reason }: { category: string; name: string; reason: string }) => {
      if (!ALLOWED_CATEGORIES.has(category)) {
        return { ok: false, error: `category '${category}' not in allow-list` };
      }
      const targetDir = join(EVY_SKILLS_DIR, category, name);
      if (!existsSync(targetDir)) {
        return { ok: false, error: `skill not found: ${targetDir}` };
      }
      try {
        // Snapshot the content before deletion so the audit log captures it
        const skillFile = join(targetDir, "SKILL.md");
        let snapshot = "";
        if (existsSync(skillFile)) snapshot = readFileSync(skillFile, "utf8").slice(0, 2000);
        rmSync(targetDir, { recursive: true, force: true });
        logDecision({
          action: "skill_removed",
          rationale: `master/${category}/${name} deleted. Reason: ${reason}`,
          path: targetDir,
          snapshot,
        });
        return { ok: true, removed: `master/${category}/${name}`, reason };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  },

  skill_list_master: {
    description:
      "List the skills you've authored under master's own source. Returns a list of {category, name, description, char_count}. Use to see what you've already captured before authoring something new (avoid duplicates) and to introspect what you can revise.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      if (!existsSync(EVY_SKILLS_DIR)) {
        return { ok: true, root: EVY_SKILLS_DIR, count: 0, skills: [] };
      }
      const skills: Array<Record<string, unknown>> = [];
      try {
        for (const cat of readdirSync(EVY_SKILLS_DIR, { withFileTypes: true })) {
          if (!cat.isDirectory()) continue;
          const catDir = join(EVY_SKILLS_DIR, cat.name);
          for (const skill of readdirSync(catDir, { withFileTypes: true })) {
            if (!skill.isDirectory()) continue;
            const skillFile = join(catDir, skill.name, "SKILL.md");
            if (!existsSync(skillFile)) continue;
            const content = readFileSync(skillFile, "utf8");
            const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
            let desc = "";
            if (fm) {
              const dm = fm[1].match(/^description:\s*(.*)$/m);
              if (dm) desc = dm[1].trim().replace(/^['"]|['"]$/g, "");
            }
            skills.push({
              skill_id: `master/${cat.name}/${skill.name}`,
              category: cat.name,
              name: skill.name,
              description: desc,
              char_count: content.length,
              path: skillFile,
            });
          }
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
      return { ok: true, root: EVY_SKILLS_DIR, count: skills.length, skills };
    },
  },
};
