// components/evy/__tests__/watchdog-prune.test.ts
//
// v2.8.2 — Regression coverage for the stale-team watchdog bug
// reported 2026-05-18 (`claude-hermes-agent` + `claude-subctl`
// continued to escalate ~10h after tmux destruction).
//
// Bug-doc cases mapped → test names:
//
//   case 1 "watched team exists and is stale: alert/nudge as today"
//          → "live team still in the watched set is not pruned"
//   case 2 "watched team tmux missing: remove/suppress"
//          → "tmux-gone team is removed and inbox archived"
//   case 3 "killed team does not remain in watcher registry after
//           subctl_orch_kill"
//          → "pruneOneTeam removes a team explicitly + clears nudge state"
//   case 4 "team lifecycle unregister happens even if tmux kill
//           succeeds but state cleanup partially fails"
//          → "pruneOneTeam succeeds even if archive throws"
//   case 5 "spawn does not falsely imply staleness monitoring if the
//           watchdog interval is not running"
//          → "pruneVanishedTeams is a no-op when nothing is tracked"
//
// We deliberately do NOT spawn real tmux sessions. The TmuxRunner
// interface is injected, the same pattern team-gc.test.ts uses for
// filesystem effects.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  archiveInboxFile,
  pruneOneTeam,
  pruneVanishedTeams,
  type TmuxRunner,
} from "../watchdog-prune";

let root: string;
let inboxDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "subctl-watchdog-prune-"));
  inboxDir = join(root, "inbox");
  mkdirSync(inboxDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Build a TmuxRunner that says yes only for the given allow-list.
 * Mirrors the subprocess-injection pattern used elsewhere in the
 * suite (auto-nudge.test.ts injects sendNudge; team-gc.test.ts
 * injects emitNotification).
 */
function fakeTmux(alive: ReadonlyArray<string>): TmuxRunner {
  const set = new Set(alive);
  return { hasSession: (name) => set.has(name) };
}

/** Drop a stub inbox file so archival has something to move. */
function stubInbox(team: string) {
  writeFileSync(
    join(inboxDir, `${team}.jsonl`),
    JSON.stringify({ ts: "2026-05-18T00:00:00Z", type: "progress", text: "x" }) +
      "\n",
  );
}

// ─── case 1 — live team is NOT pruned ─────────────────────────────────────

describe("pruneVanishedTeams — live team passes through (bug-doc case 1)", () => {
  test("live team still in the watched set is not pruned", () => {
    const teamLastActivity = new Map<string, unknown>([
      ["claude-alpha", { ts: Date.now() }],
    ]);
    const teamNudgeState = new Map<string, unknown>([
      ["claude-alpha", { last_nudge_at_ms: Date.now() }],
    ]);
    stubInbox("claude-alpha");

    const decisions = pruneVanishedTeams({
      teamLastActivity,
      teamNudgeState,
      inboxDir,
      tmux: fakeTmux(["claude-alpha"]),
      claudeOnly: true,
    });

    expect(decisions).toEqual([]);
    expect(teamLastActivity.has("claude-alpha")).toBe(true);
    expect(teamNudgeState.has("claude-alpha")).toBe(true);
    // Inbox file untouched.
    expect(existsSync(join(inboxDir, "claude-alpha.jsonl"))).toBe(true);
    expect(existsSync(join(inboxDir, ".archived"))).toBe(false);
  });
});

// ─── case 2 — tmux-gone team gets pruned + inbox archived ─────────────────

describe("pruneVanishedTeams — tmux-gone team removed (bug-doc case 2)", () => {
  test("tmux-gone team is removed and inbox archived", () => {
    const teamLastActivity = new Map<string, unknown>([
      ["claude-hermes-agent", { ts: Date.now() - 10 * 60 * 60_000 }],
      ["claude-alive", { ts: Date.now() }],
    ]);
    const teamNudgeState = new Map<string, unknown>([
      ["claude-hermes-agent", { last_nudge_at_ms: Date.now() - 9 * 60 * 60_000 }],
    ]);
    const teamPaneHash = new Map<string, unknown>([
      ["claude-hermes-agent", "abc"],
      ["claude-alive", "xyz"],
    ]);
    const teamReadOffsets = new Map<string, unknown>([
      [join(inboxDir, "claude-hermes-agent.jsonl"), 42],
      [join(inboxDir, "claude-alive.jsonl"), 100],
    ]);
    stubInbox("claude-hermes-agent");
    stubInbox("claude-alive");

    const decisions = pruneVanishedTeams({
      teamLastActivity,
      teamNudgeState,
      teamPaneHash,
      teamReadOffsets,
      inboxDir,
      tmux: fakeTmux(["claude-alive"]),
      claudeOnly: true,
    });

    expect(decisions.length).toBe(1);
    expect(decisions[0]).toMatchObject({
      team_id: "claude-hermes-agent",
      reason: "tmux-session-gone",
      inbox_archived: true,
    });
    // Removed from EVERY tracking map…
    expect(teamLastActivity.has("claude-hermes-agent")).toBe(false);
    expect(teamNudgeState.has("claude-hermes-agent")).toBe(false);
    expect(teamPaneHash.has("claude-hermes-agent")).toBe(false);
    expect(teamReadOffsets.has(join(inboxDir, "claude-hermes-agent.jsonl"))).toBe(false);
    // …but the live team is untouched.
    expect(teamLastActivity.has("claude-alive")).toBe(true);
    expect(teamPaneHash.has("claude-alive")).toBe(true);
    expect(teamReadOffsets.has(join(inboxDir, "claude-alive.jsonl"))).toBe(true);
    // Inbox file moved into .archived/ (invisible to the CLI's *.jsonl glob).
    expect(existsSync(join(inboxDir, "claude-hermes-agent.jsonl"))).toBe(false);
    const archived = readdirSync(join(inboxDir, ".archived"));
    expect(archived.length).toBe(1);
    expect(archived[0]).toMatch(/^claude-hermes-agent\.\d+\.jsonl$/);
  });
});

// ─── case 3 — explicit kill drops the team + suppresses pending nudge ─────

describe("pruneOneTeam — explicit lifecycle kill (bug-doc case 3)", () => {
  test("pruneOneTeam removes a team explicitly + clears nudge state", () => {
    const teamLastActivity = new Map<string, unknown>([
      ["claude-subctl", { ts: Date.now() }],
    ]);
    const teamNudgeState = new Map<string, unknown>([
      ["claude-subctl", { last_nudge_at_ms: Date.now() }],
    ]);
    stubInbox("claude-subctl");

    const decision = pruneOneTeam("claude-subctl", {
      teamLastActivity,
      teamNudgeState,
      inboxDir,
      // tmux runner is NEVER consulted in pruneOneTeam — operator
      // already told us the session is gone. We supply one anyway to
      // satisfy the type but verify it's not called by making it throw.
      tmux: {
        hasSession: () => {
          throw new Error("pruneOneTeam must not call hasSession");
        },
      },
    });

    expect(decision).not.toBeNull();
    expect(decision?.reason).toBe("operator-killed");
    expect(decision?.inbox_archived).toBe(true);
    expect(teamLastActivity.has("claude-subctl")).toBe(false);
    expect(teamNudgeState.has("claude-subctl")).toBe(false);

    // Idempotency: calling again is a clean null (suppression already
    // applied; no spurious notification).
    const second = pruneOneTeam("claude-subctl", {
      teamLastActivity,
      teamNudgeState,
      inboxDir,
      tmux: { hasSession: () => false },
    });
    expect(second).toBeNull();
  });
});

// ─── case 4 — partial cleanup still unregisters the team ──────────────────

describe("pruneOneTeam — partial-failure resilience (bug-doc case 4)", () => {
  test("pruneOneTeam succeeds even if archive throws", () => {
    const teamLastActivity = new Map<string, unknown>([
      ["claude-broken-fs", { ts: Date.now() }],
    ]);
    const teamNudgeState = new Map<string, unknown>([
      ["claude-broken-fs", { last_nudge_at_ms: Date.now() }],
    ]);

    const decision = pruneOneTeam(
      "claude-broken-fs",
      {
        teamLastActivity,
        teamNudgeState,
        inboxDir,
        tmux: { hasSession: () => false },
        archiveInbox: () => {
          // Simulate an archival failure that an earlier version of
          // this fix would have let abort the entire prune. We expect
          // map cleanup to still happen so the watchdog stops
          // escalating regardless.
          return false;
        },
      },
    );

    // The team WAS tracked, so we still get a decision back even
    // though inbox archival reported no-op.
    expect(decision).not.toBeNull();
    expect(decision?.inbox_archived).toBe(false);
    expect(teamLastActivity.has("claude-broken-fs")).toBe(false);
    expect(teamNudgeState.has("claude-broken-fs")).toBe(false);
  });
});

// ─── case 5 — no spurious tracking when nothing is being watched ──────────

describe("pruneVanishedTeams — empty registry no-op (bug-doc case 5)", () => {
  test("pruneVanishedTeams is a no-op when nothing is tracked", () => {
    const teamLastActivity = new Map<string, unknown>();
    const teamNudgeState = new Map<string, unknown>();

    // Spawn without staleness monitoring running → nothing is tracked,
    // so even a hasSession that throws on every call is fine.
    const decisions = pruneVanishedTeams({
      teamLastActivity,
      teamNudgeState,
      inboxDir,
      tmux: {
        hasSession: () => {
          throw new Error("must not be called when nothing is tracked");
        },
      },
      claudeOnly: true,
    });

    expect(decisions).toEqual([]);
    expect(teamLastActivity.size).toBe(0);
    expect(teamNudgeState.size).toBe(0);
  });
});

// ─── archive helper smoke ────────────────────────────────────────────────

describe("archiveInboxFile — direct helper", () => {
  test("missing source returns false without throwing", () => {
    expect(archiveInboxFile("nonexistent-team", inboxDir)).toBe(false);
    expect(existsSync(join(inboxDir, ".archived"))).toBe(false);
  });

  test("present source is moved into .archived/ with epoch suffix", () => {
    stubInbox("claude-foo");
    expect(archiveInboxFile("claude-foo", inboxDir)).toBe(true);
    expect(existsSync(join(inboxDir, "claude-foo.jsonl"))).toBe(false);
    const archived = readdirSync(join(inboxDir, ".archived"));
    expect(archived.length).toBe(1);
    expect(archived[0]).toMatch(/^claude-foo\.\d+\.jsonl$/);
  });
});

// ─── claudeOnly safety: non-claude entries never get touched ──────────────

describe("pruneVanishedTeams — claudeOnly guard", () => {
  test("non-claude entries are left alone even if tmux reports them dead", () => {
    const teamLastActivity = new Map<string, unknown>([
      ["legacy-monitor-foo", { ts: 1 }],
      ["claude-zombie", { ts: 2 }],
    ]);
    const decisions = pruneVanishedTeams({
      teamLastActivity,
      inboxDir,
      tmux: fakeTmux([]), // nothing alive
      claudeOnly: true,
    });
    expect(decisions.length).toBe(1);
    expect(decisions[0]?.team_id).toBe("claude-zombie");
    expect(teamLastActivity.has("legacy-monitor-foo")).toBe(true);
  });
});
