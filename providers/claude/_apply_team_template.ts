// providers/claude/_apply_team_template.ts — v2.8.0 TOML team-template bridge.
//
// Tiny bun bridge between the bash spawn flow (providers/claude/teams.sh) and
// the TypeScript template loader (components/master/team-templates.ts).
//
// Usage (from teams.sh):
//   bun run providers/claude/_apply_team_template.ts \
//        <team_id> <template_name> <prompt_out_path>
//
// Side effects:
//   - Loads + validates the TOML template at
//     ~/.config/subctl/team-templates/<template_name>.toml.
//   - Records team_meta.json at ~/.local/state/subctl/teams/<team_id>/meta.json
//     so the dispatch endpoint can route subctl_team_dispatch calls back
//     to this team.
//   - Writes the composed lead boot prompt (persona + roster preamble +
//     boot_prompt body) to <prompt_out_path>, which teams.sh then reads
//     into INITIAL_PROMPT.
//
// Stdout (single line of JSON):
//   {"ok":true,"template":"<name>","autonomy":"ask","developer_count":N,
//    "prompt_path":"<path>"}
//
// Exits non-zero with stderr ERROR: <message> on validation failure so
// the bash caller can subctl_die cleanly.

import { writeFileSync } from "node:fs";
import {
  loadTemplate,
  renderRosterPreamble,
} from "../../components/evy/team-templates";
import { recordTemplateSpawn } from "../../dashboard/lib/team-dispatch";

function fail(msg: string): never {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length !== 3) {
  fail(
    "usage: _apply_team_template.ts <team_id> <template_name> <prompt_out_path>",
  );
}
const [teamId, templateName, promptOutPath] = args as [string, string, string];

let template;
try {
  template = loadTemplate(templateName);
} catch (err) {
  fail((err as Error).message);
}
// Narrow — fail() exits the process, but TS doesn't always reason about
// process.exit from another module.
if (!template) fail("loadTemplate returned undefined");

// Record team_meta so the dispatch endpoint + master tool know which
// template this team was spawned from.
recordTemplateSpawn(teamId, template.name);

// Compose the lead's boot prompt:
//   <roster preamble>     ← so the lead knows its developers + dispatch tool
//   <persona body>        ← role / values / voice
//   <template boot_prompt> ← optional first-action directive (may be empty)
//
// The HMAC team-contract wrapping still happens downstream in teams.sh.
const sections: string[] = [];
sections.push(renderRosterPreamble(template));
if (template.lead.persona) sections.push(template.lead.persona);
if (template.lead.boot_prompt) sections.push(template.lead.boot_prompt);
const composed = sections.join("\n\n---\n\n");

writeFileSync(promptOutPath, composed, "utf-8");

const out = {
  ok: true,
  template: template.name,
  autonomy: template.lead.autonomy ?? "ask",
  developer_count: template.developers.length,
  prompt_path: promptOutPath,
};
process.stdout.write(JSON.stringify(out) + "\n");
