// dashboard/__tests__/notify-listener-paths.test.ts
//
// W6.5 rider #425 — notify-listener must honor SUBCTL_CONFIG_DIR.
//
// The module used to hardcode ~/.config/subctl/notify.json via HOME, so a
// scratch/test boot of dashboard/server.ts with the operator's real HOME
// read the PRODUCTION notify.json and armed a competing Telegram
// getUpdates long-poll against the live bot (bit worker w6-restore for
// ~2 min on 2026-06-11). With the fix, a scoped boot stays scoped.
//
// Setup: a DECOY notify.json is planted at the XDG/HOME-derived location
// and SUBCTL_CONFIG_DIR points at an EMPTY scoped dir. Under the old
// code the listener would find the decoy and start polling; under the
// fixed code it must report "no notify config". Env is set before the
// dynamic import because the module resolves its paths at import time —
// exactly how the dashboard process does it.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "subctl-notify-paths-"));
const xdgDir = join(root, "xdg");
const scopedDir = join(root, "scoped");
mkdirSync(join(xdgDir, "subctl"), { recursive: true });
mkdirSync(scopedDir, { recursive: true });

// The decoy that the OLD code would have picked up (and long-polled).
writeFileSync(
  join(xdgDir, "subctl", "notify.json"),
  JSON.stringify({
    telegram_bot_token: "000000:DECOY-MUST-NEVER-BE-POLLED",
    telegram_chat_id: "0",
  }),
);

process.env.XDG_CONFIG_HOME = xdgDir;
process.env.SUBCTL_CONFIG_DIR = scopedDir;

const listener = await import("../notify-listener");

describe("notify-listener honors SUBCTL_CONFIG_DIR (#425)", () => {
  test("scoped boot does NOT pick up the HOME/XDG-derived production config", () => {
    const r = listener.startNotifyListener();
    expect(r.running).toBe(false);
    expect(r.reason).toContain("no notify config");
  });

  test("inbox read path is scoped too — reads SUBCTL_CONFIG_DIR/inbox.jsonl", () => {
    const entry = {
      ts: "2026-06-11T00:00:00Z",
      source: "buddy",
      type: "text",
      question_id: "w65-scope-probe",
      answer: null,
      answer_label: null,
      from_id: null,
      from_name: "test",
      raw_text: "scoped inbox entry",
      acked: false,
    };
    writeFileSync(join(scopedDir, "inbox.jsonl"), JSON.stringify(entry) + "\n");
    const got = listener.readInbox({ question_id: "w65-scope-probe" });
    expect(got.length).toBe(1);
    expect(got[0]!.raw_text).toBe("scoped inbox entry");
  });
});
