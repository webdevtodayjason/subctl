// specforge — staged project-spec intake. Mirrors the ArgentOS pattern
// (~/argentos/src/infra/specforge-conductor.ts).
//
// 5-stage state machine for converting a vague "let's build X" into a
// reviewed PRD before any dev team gets dispatched:
//
//   project_type_gate   classify GREENFIELD vs BROWNFIELD
//   intake_interview    collect problem, users, success criteria,
//                       constraints, scope, non-scope, tech context
//   draft_review        draft or revise the SPEC
//   awaiting_approval   wait for explicit operator approval
//   approved_execution  implementation handoff unlocked; persisted
//                       to <vault>/<project>/SPEC.md
//
// Single tool surface: specforge with action ∈ {handle, status, exit}.
// Same shape as ArgentOS so operator's mental model carries over.
//
// State persists to ~/.config/subctl/master/specforge/<session-key>.json.
// Default session key is "default" — multiple parallel specs would use
// distinct keys.

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const SPECFORGE_DIR = join(homedir(), ".config", "subctl", "master", "specforge");

type Stage =
  | "project_type_gate"
  | "intake_interview"
  | "draft_review"
  | "awaiting_approval"
  | "approved_execution";

type ProjectType = "greenfield" | "brownfield" | "unknown";

interface IntakeCoverage {
  problem: boolean;
  users: boolean;
  success: boolean;
  constraints: boolean;
  scope: boolean;
  non_scope: boolean;
  technical_context: boolean;
}

interface SpecforgeState {
  session_key: string;
  started_at: string;
  last_touched_at: string;
  stage: Stage;
  project_type: ProjectType;
  project_name?: string;
  intake_coverage: IntakeCoverage;
  intake_notes: Partial<Record<keyof IntakeCoverage, string>>;
  draft_version: number;
  draft_text: string;
  approval_history: Array<{ ts: string; verdict: "approved" | "needs_changes" | "rejected"; note?: string }>;
}

function buildDefaultCoverage(): IntakeCoverage {
  return {
    problem: false,
    users: false,
    success: false,
    constraints: false,
    scope: false,
    non_scope: false,
    technical_context: false,
  };
}

function statePath(sessionKey: string): string {
  return join(SPECFORGE_DIR, `${sessionKey}.json`);
}

function loadState(sessionKey: string): SpecforgeState | null {
  const path = statePath(sessionKey);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SpecforgeState;
  } catch {
    return null;
  }
}

function saveState(state: SpecforgeState): void {
  mkdirSync(SPECFORGE_DIR, { recursive: true });
  state.last_touched_at = new Date().toISOString();
  writeFileSync(statePath(state.session_key), JSON.stringify(state, null, 2));
}

function deleteState(sessionKey: string): void {
  const path = statePath(sessionKey);
  if (existsSync(path)) unlinkSync(path);
}

function createState(sessionKey: string): SpecforgeState {
  const now = new Date().toISOString();
  return {
    session_key: sessionKey,
    started_at: now,
    last_touched_at: now,
    stage: "project_type_gate",
    project_type: "unknown",
    intake_coverage: buildDefaultCoverage(),
    intake_notes: {},
    draft_version: 0,
    draft_text: "",
    approval_history: [],
  };
}

function parseProjectType(message: string): ProjectType {
  const text = message.toLowerCase();
  const brownfield = ["brownfield", "existing project", "existing app", "existing application", "existing code", "extend", "refactor", "modify", "add to"];
  const greenfield = ["greenfield", "new project", "from scratch", "build a new", "start fresh", "blank slate"];
  if (brownfield.some((k) => text.includes(k))) return "brownfield";
  if (greenfield.some((k) => text.includes(k))) return "greenfield";
  return "unknown";
}

function buildGuidance(state: SpecforgeState): string {
  switch (state.stage) {
    case "project_type_gate":
      return [
        "Stage: project_type_gate.",
        "First decision: is this GREENFIELD (new project from scratch) or BROWNFIELD (extending an existing one)?",
        "Ask the operator directly. Once they answer, advance to intake_interview by calling specforge with action='handle' and including the operator's reply.",
      ].join("\n");
    case "intake_interview": {
      const missing = (Object.keys(state.intake_coverage) as Array<keyof IntakeCoverage>)
        .filter((k) => !state.intake_coverage[k]);
      const all = [
        `Stage: intake_interview (${7 - missing.length}/7 covered).`,
        "Goal: collect a minimum-viable spec by interviewing the operator. Don't draft yet.",
        "Coverage checklist:",
        "  - problem            What's the underlying problem this solves?",
        "  - users              Who uses this; what do they want from it?",
        "  - success            How do we know it worked? (concrete acceptance signal)",
        "  - constraints        Hard requirements / non-negotiables / tech stack pinned",
        "  - scope              What IS in this build",
        "  - non_scope          What's explicitly OUT of scope (anti-scope creep)",
        "  - technical_context  Existing code / data / infra it has to fit into",
        "",
        missing.length
          ? `Still missing: ${missing.join(", ")}. Ask one focused question at a time.`
          : "All 7 dimensions covered. Advance to draft_review by drafting the SPEC and calling specforge handle with the draft text.",
      ];
      return all.join("\n");
    }
    case "draft_review":
      return [
        `Stage: draft_review (draft v${state.draft_version}).`,
        "Goal: present the draft SPEC to the operator for review. Get pointed feedback. Iterate (revise + bump draft_version) or move to awaiting_approval if operator says 'looks good'.",
      ].join("\n");
    case "awaiting_approval":
      return [
        "Stage: awaiting_approval.",
        "Goal: get explicit operator approval. Watch for clear yes ('approved', 'go', 'ship it') vs requests for more changes.",
        "On approval: call specforge handle with action context like 'operator approved' — moves to approved_execution and persists the SPEC to the vault.",
        "On revision request: revise the draft and call specforge handle with the new draft.",
      ].join("\n");
    case "approved_execution":
      return [
        "Stage: approved_execution. Implementation is unlocked.",
        `SPEC saved to <vault>/${state.project_name ?? "(no project)"}/SPEC.md.`,
        "Spawn dev teams off the saved spec via subctl_orch_spawn_template. Reference the SPEC's section/step numbers in worker prompts.",
      ].join("\n");
  }
}

// Stage transitions are explicit. Master decides which transition to
// invoke based on operator interaction; this tool just persists the
// move + returns guidance for the next stage.
function applyTransition(state: SpecforgeState, args: SpecforgeHandleArgs): { state: SpecforgeState; transitioned: boolean; note: string } {
  const msg = (args.message ?? "").trim();
  let transitioned = false;
  let note = "";

  if (state.stage === "project_type_gate" && args.set_project_type) {
    state.project_type = args.set_project_type;
    if (args.project_name) state.project_name = args.project_name;
    state.stage = "intake_interview";
    transitioned = true;
    note = `project_type=${state.project_type}; advanced to intake_interview.`;
  } else if (state.stage === "project_type_gate" && msg) {
    // Heuristic: parse type from the operator message if available
    const inferred = parseProjectType(msg);
    if (inferred !== "unknown") {
      state.project_type = inferred;
      state.stage = "intake_interview";
      transitioned = true;
      note = `inferred project_type=${inferred} from message; advanced to intake_interview.`;
    } else {
      note = `couldn't parse project_type from message; ask operator directly.`;
    }
  } else if (state.stage === "intake_interview" && args.coverage_update) {
    for (const [k, v] of Object.entries(args.coverage_update)) {
      const key = k as keyof IntakeCoverage;
      if (key in state.intake_coverage) {
        state.intake_coverage[key] = !!v;
        if (typeof args.intake_notes?.[key] === "string") {
          state.intake_notes[key] = args.intake_notes[key];
        }
      }
    }
    const missing = (Object.keys(state.intake_coverage) as Array<keyof IntakeCoverage>).filter((k) => !state.intake_coverage[k]);
    if (missing.length === 0) {
      state.stage = "draft_review";
      transitioned = true;
      note = `intake complete; advanced to draft_review. Now draft the SPEC and call specforge handle with draft_text.`;
    } else {
      note = `coverage updated; still missing ${missing.join(", ")}.`;
    }
  } else if (state.stage === "draft_review" && args.draft_text) {
    state.draft_text = args.draft_text;
    state.draft_version += 1;
    state.stage = "awaiting_approval";
    transitioned = true;
    note = `draft v${state.draft_version} recorded; advanced to awaiting_approval. Present to operator for approval.`;
  } else if (state.stage === "awaiting_approval") {
    if (args.approval === "approved") {
      state.approval_history.push({ ts: new Date().toISOString(), verdict: "approved", note: msg });
      state.stage = "approved_execution";
      transitioned = true;
      // Persist SPEC.md to the vault if project_name + vault root configured
      if (state.project_name) {
        try {
          const vaultRoot = (() => {
            try {
              const cfgPath = join(homedir(), ".config/subctl/master/obsidian.json");
              if (existsSync(cfgPath)) {
                const j = JSON.parse(readFileSync(cfgPath, "utf8")) as { vault_root?: string };
                if (j.vault_root) return j.vault_root.replace(/^~/, homedir());
              }
            } catch { /* ignore */ }
            return join(homedir(), "Documents", "Obsidian Vault");
          })();
          if (existsSync(vaultRoot)) {
            const projDir = join(vaultRoot, state.project_name);
            mkdirSync(projDir, { recursive: true });
            const specPath = join(projDir, "SPEC.md");
            const finalSpec = `# ${state.project_name} — SPEC

**Project type:** ${state.project_type}
**Approved:** ${state.approval_history.at(-1)?.ts}
**Draft version:** v${state.draft_version}

---

${state.draft_text}

---

## Intake notes

${(Object.keys(state.intake_coverage) as Array<keyof IntakeCoverage>)
  .map((k) => `### ${k}\n\n${state.intake_notes[k] ?? "_(not captured)_"}\n`)
  .join("\n")}
`;
            writeFileSync(specPath, finalSpec);
            note = `SPEC.md persisted to ${specPath}. Implementation unlocked.`;
          } else {
            note = `approved, but vault root ${vaultRoot} doesn't exist — set it via Settings → Obsidian vault before running specforge again.`;
          }
        } catch (err) {
          note = `approved, but SPEC write failed: ${(err as Error).message}`;
        }
      } else {
        note = `approved, but no project_name set — couldn't save to vault. Add project_name and re-approve.`;
      }
    } else if (args.approval === "needs_changes") {
      state.approval_history.push({ ts: new Date().toISOString(), verdict: "needs_changes", note: msg });
      state.stage = "draft_review";
      transitioned = true;
      note = `operator wants changes; back to draft_review. Revise the draft based on feedback.`;
    } else if (args.draft_text) {
      // Operator gave new feedback that produced a revised draft directly
      state.draft_text = args.draft_text;
      state.draft_version += 1;
      note = `revised to draft v${state.draft_version}; awaiting approval again.`;
    }
  } else if (state.stage === "approved_execution") {
    note = "already in approved_execution. Use specforge exit to clear and start fresh.";
  }

  saveState(state);
  return { state, transitioned, note };
}

interface SpecforgeHandleArgs {
  session_key?: string;
  message?: string;
  set_project_type?: ProjectType;
  project_name?: string;
  coverage_update?: Partial<IntakeCoverage>;
  intake_notes?: Partial<Record<keyof IntakeCoverage, string>>;
  draft_text?: string;
  approval?: "approved" | "needs_changes";
}

export const specforgeTools = {
  specforge: {
    description: [
      "Staged project-spec intake. Use this BEFORE dispatching any dev team for new development work — converts a vague 'let's build X' into a reviewed PRD that lives in the operator's Obsidian vault.",
      "",
      "Three actions:",
      "  - 'handle': process the latest user message, advance the staged workflow if appropriate. Pass operator's words via `message`. Pass structured updates via set_project_type / coverage_update / intake_notes / draft_text / approval.",
      "  - 'status': inspect current stage without mutation. Use to introspect before deciding what to ask next.",
      "  - 'exit': clear the active session (start fresh).",
      "",
      "5-stage flow: project_type_gate → intake_interview (7 dimensions: problem, users, success, constraints, scope, non_scope, technical_context) → draft_review → awaiting_approval → approved_execution.",
      "",
      "On 'approved_execution', the SPEC is written to <vault>/<project_name>/SPEC.md. After that, spawn dev teams via subctl_orch_spawn_template and reference SPEC sections in their boot prompts. Don't dispatch implementation work without an approved spec — that's the whole point of this tool.",
    ].join("\n"),
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["handle", "status", "exit"],
          description: "What to do this turn.",
        },
        session_key: {
          type: "string",
          description: "Spec-session identifier. Default 'default'. Use distinct keys for parallel specs.",
        },
        message: {
          type: "string",
          description: "Operator's latest message verbatim (handle action). Used for type inference + approval-phrase detection.",
        },
        set_project_type: {
          type: "string",
          enum: ["greenfield", "brownfield", "unknown"],
          description: "Explicit project-type setter (handle action). Use when message is ambiguous and you've asked operator directly.",
        },
        project_name: {
          type: "string",
          description: "Short slug for this project. Used as the vault directory name on approval.",
        },
        coverage_update: {
          type: "object",
          description: "Mark intake dimensions as covered (handle action, intake_interview stage). Keys: problem, users, success, constraints, scope, non_scope, technical_context. Values: true to mark covered.",
        },
        intake_notes: {
          type: "object",
          description: "Operator's actual content per intake dimension. Keys match coverage_update. Saved into final SPEC.md.",
        },
        draft_text: {
          type: "string",
          description: "Full markdown draft of the SPEC (handle action, draft_review or awaiting_approval stage). Each call bumps draft_version.",
        },
        approval: {
          type: "string",
          enum: ["approved", "needs_changes"],
          description: "Operator's verdict at awaiting_approval stage.",
        },
      },
      required: ["action"],
    },
    invoke: async (args: { action: "handle" | "status" | "exit" } & SpecforgeHandleArgs) => {
      const sessionKey = args.session_key ?? "default";

      if (args.action === "exit") {
        deleteState(sessionKey);
        return { ok: true, message: `specforge session '${sessionKey}' cleared.` };
      }

      if (args.action === "status") {
        const state = loadState(sessionKey);
        if (!state) return { ok: true, active: false, session_key: sessionKey };
        return {
          ok: true,
          active: true,
          state,
          guidance: buildGuidance(state),
        };
      }

      // action === "handle"
      let state = loadState(sessionKey);
      if (!state) {
        state = createState(sessionKey);
        saveState(state);
      }
      const result = applyTransition(state, args);
      return {
        ok: true,
        session_key: sessionKey,
        stage: result.state.stage,
        transitioned: result.transitioned,
        note: result.note,
        guidance: buildGuidance(result.state),
        state_summary: {
          project_type: result.state.project_type,
          project_name: result.state.project_name,
          coverage_count: Object.values(result.state.intake_coverage).filter(Boolean).length,
          draft_version: result.state.draft_version,
        },
      };
    },
  },
};
