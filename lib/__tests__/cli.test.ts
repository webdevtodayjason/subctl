// lib/__tests__/cli.test.ts
//
// v2.7.28 — covers the five new subcommands added to bin/subctl:
//   status, logs, deploy, notif, memory
//
// Approach: Bun.spawnSync against the actual bin/subctl bash dispatcher,
// matching the existing lib/__tests__/update.test.ts style. We stand up
// tiny throwaway HTTP servers on ephemeral ports for status/notif/memory
// happy-path tests so the assertions don't depend on a running master/
// dashboard daemon.
//
// What we don't test here:
//   - tail -F follow mode (would need a long-running subprocess + signal handling)
//   - launchctl kickstart paths in `deploy` (would mutate real launchd state)
//     — instead `deploy --dry-run --no-pull` is exercised, which prints the
//     kickstart command without executing it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SUBCTL = join(REPO_ROOT, "bin", "subctl");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  args: string[],
  env: Record<string, string> = {},
  cwd?: string,
): RunResult {
  const proc = Bun.spawnSync([SUBCTL, ...args], {
    cwd: cwd ?? REPO_ROOT,
    env: {
      ...process.env,
      ...env,
      NO_COLOR: "1",
      // Default both ports to 0 → tests that don't override get a clean
      // "unreachable" path instead of accidentally hitting a real daemon
      // on someone's dev box.
      SUBCTL_EVY_PORT: env.SUBCTL_EVY_PORT ?? "1",
      SUBCTL_SERVICE_PORT: env.SUBCTL_SERVICE_PORT ?? "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

// Spin up a tiny Bun server that responds to a route → JSON body table.
// Returns { port, stop } — call stop() in afterAll.
function spawnFake(
  routes: Record<string, (req: Request) => Response | Promise<Response>>,
): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key] ?? routes[url.pathname];
      if (!handler) {
        return new Response("not found", { status: 404 });
      }
      return handler(req);
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

// v2.8.9 — Version was hardcoded to "2.7.36" when these tests were authored;
// every release bump made these tests stale. Read VERSION dynamically so the
// suite stays green across bumps.
const CURRENT_VERSION = readFileSync(
  join(import.meta.dir, "..", "..", "VERSION"),
  "utf8",
).trim();

// ── --version / --help / -V ─────────────────────────────────────────────────
describe("subctl --version / --help", () => {
  test("`subctl version` prints VERSION file content", () => {
    const r = run(["version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(CURRENT_VERSION);
  });

  test("`subctl --version` and `-V` are accepted", () => {
    const a = run(["--version"]);
    const b = run(["-V"]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.stdout).toContain(CURRENT_VERSION);
    expect(b.stdout).toContain(CURRENT_VERSION);
  });

  test("`subctl --help` lists v2.7.28 + v2.7.36 subcommands", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    // The five v2.7.28 verbs.
    expect(r.stdout).toContain("subctl status");
    expect(r.stdout).toContain("subctl logs");
    expect(r.stdout).toContain("subctl deploy");
    expect(r.stdout).toContain("subctl notif");
    expect(r.stdout).toContain("subctl memory");
    // v2.7.36 expansion: team mgmt, config, profile.
    expect(r.stdout).toContain("subctl team list");
    expect(r.stdout).toContain("subctl team kill");
    expect(r.stdout).toContain("subctl team exec");
    expect(r.stdout).toContain("subctl team logs");
    expect(r.stdout).toContain("subctl config show");
    expect(r.stdout).toContain("subctl config validate");
    expect(r.stdout).toContain("subctl profile show");
    expect(r.stdout).toContain("subctl profile switch");
  });
});

// ── status ──────────────────────────────────────────────────────────────────
describe("subctl status", () => {
  test("master down → exit 1 + clear error", () => {
    const r = run(["status"]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/unreachable/);
  });

  test("master + dashboard up → exit 0 with versions", async () => {
    const master = spawnFake({
      "/health": () =>
        Response.json({
          ok: true,
          version: "2.7.28",
          uptime_s: 42,
          subscribers: 3,
          active_profile: "chat",
          telegram_listener: { running: true, offset: 0, queue_size: 0 },
        }),
    });
    const dash = spawnFake({
      "/api/version": () => Response.json({ version: "2.7.28" }),
    });
    try {
      const r = run(["status"], {
        SUBCTL_EVY_PORT: String(master.port),
        SUBCTL_SERVICE_PORT: String(dash.port),
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/master.*v2\.7\.28/);
      expect(r.stdout).toMatch(/dashboard.*v2\.7\.28/);
      expect(r.stdout).toMatch(/profile=chat/);
      expect(r.stdout).toMatch(/telegram=polling/);
    } finally {
      master.stop();
      dash.stop();
    }
  });

  test("--json emits parseable doc with ok flag", async () => {
    const master = spawnFake({
      "/health": () =>
        Response.json({
          ok: true,
          version: "2.7.28",
          uptime_s: 1,
          subscribers: 0,
          active_profile: "default",
          telegram_listener: { running: false },
        }),
    });
    const dash = spawnFake({
      "/api/version": () => Response.json({ version: "2.7.28" }),
    });
    try {
      const r = run(["status", "--json"], {
        SUBCTL_EVY_PORT: String(master.port),
        SUBCTL_SERVICE_PORT: String(dash.port),
      });
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.ok).toBe(true);
      expect(doc.cli_version).toBe(CURRENT_VERSION);
      expect(doc.master.version).toBe("2.7.28");
      expect(doc.dashboard.version).toBe("2.7.28");
    } finally {
      master.stop();
      dash.stop();
    }
  });

  test("--json with everything down → ok:false + error stubs", () => {
    const r = run(["status", "--json"]);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.master.error).toBe("unreachable");
    expect(doc.dashboard.error).toBe("unreachable");
  });

  test("--help exits 0 without making any HTTP call", () => {
    const r = run(["status", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("subctl status");
    expect(r.stdout).toContain("--json");
  });
});

// ── logs ────────────────────────────────────────────────────────────────────
describe("subctl logs", () => {
  let logRoot: string;

  beforeAll(() => {
    logRoot = mkdtempSync(join(tmpdir(), "subctl-cli-logs-"));
    writeFileSync(join(logRoot, "evy.log"), "master line 1\nmaster line 2\n");
    writeFileSync(
      join(logRoot, "dashboard.out.log"),
      "dash out line 1\ndash out line 2\n",
    );
    writeFileSync(
      join(logRoot, "dashboard.err.log"),
      "dash err line 1\n",
    );
  });

  afterAll(() => {
    rmSync(logRoot, { recursive: true, force: true });
  });

  test("default prints from all three files with banners", () => {
    const r = run(["logs"], { SUBCTL_LOG_DIR: logRoot });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("master line 2");
    expect(r.stdout).toContain("dash out line 2");
    expect(r.stdout).toContain("dash err line 1");
  });

  test("--master only prints evy.log (no dashboard content)", () => {
    const r = run(["logs", "--master"], { SUBCTL_LOG_DIR: logRoot });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("master line 2");
    expect(r.stdout).not.toContain("dash out");
    expect(r.stdout).not.toContain("dash err");
  });

  test("--dashboard only prints dashboard.{out,err} (no master content)", () => {
    const r = run(["logs", "--dashboard"], { SUBCTL_LOG_DIR: logRoot });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("dash out line 2");
    expect(r.stdout).toContain("dash err line 1");
    expect(r.stdout).not.toContain("master line");
  });

  test("--tail N respects line count", () => {
    const r = run(["logs", "--master", "--tail", "1"], {
      SUBCTL_LOG_DIR: logRoot,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("master line 2");
    expect(r.stdout).not.toContain("master line 1");
  });

  test("--tail rejects non-integer", () => {
    const r = run(["logs", "--tail", "banana"], { SUBCTL_LOG_DIR: logRoot });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/positive integer/);
  });

  test("missing log dir → exit 1 with friendly error", () => {
    const empty = mkdtempSync(join(tmpdir(), "subctl-cli-empty-"));
    try {
      const r = run(["logs"], { SUBCTL_LOG_DIR: empty });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/no log files found/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ── deploy ──────────────────────────────────────────────────────────────────
describe("subctl deploy", () => {
  test("--dry-run --no-pull prints kickstart commands without executing", () => {
    const r = run(["deploy", "--dry-run", "--no-pull"]);
    // Exit 0 even if plists are missing (we warn + skip per service).
    expect(r.code).toBe(0);
    // The dry-run path always prints the kickstart command for any plist
    // that's installed; if neither is installed we get warnings — accept
    // either branch as long as we didn't fall over.
    expect(r.stdout + r.stderr).toMatch(/kickstart|plist not installed|not currently loaded/);
    // Must never actually invoke kickstart in dry-run.
    expect(r.stdout).not.toMatch(/^launchctl: /m);
  });

  test("--help exits 0", () => {
    const r = run(["deploy", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("subctl deploy");
  });
});

// ── notif ───────────────────────────────────────────────────────────────────
describe("subctl notif", () => {
  test("recent (dashboard down) → exit 1 with friendly error", () => {
    const r = run(["notif", "recent"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/failed|dashboard running/);
  });

  test("recent renders empty notification list", async () => {
    const dash = spawnFake({
      "/api/notifications": () =>
        Response.json({ ok: true, notifications: [] }),
    });
    try {
      const r = run(["notif", "recent"], {
        SUBCTL_SERVICE_PORT: String(dash.port),
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("(no notifications)");
    } finally {
      dash.stop();
    }
  });

  test("list <N> renders rows", async () => {
    const dash = spawnFake({
      "/api/notifications": () =>
        Response.json({
          ok: true,
          notifications: [
            {
              id: "n1",
              created_at: "2026-05-13T10:30:00Z",
              severity: "alert",
              kind: "team_stale",
              title: "Team idle 45m",
              read: false,
            },
            {
              id: "n2",
              created_at: "2026-05-13T10:15:00Z",
              severity: "info",
              kind: "auto_compact",
              title: "Compact ok",
              read: true,
            },
          ],
        }),
    });
    try {
      const r = run(["notif", "list", "5"], {
        SUBCTL_SERVICE_PORT: String(dash.port),
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Team idle 45m");
      expect(r.stdout).toContain("Compact ok");
      expect(r.stdout).toContain("alert");
      expect(r.stdout).toContain("team_stale");
    } finally {
      dash.stop();
    }
  });

  test("mark-all-read POSTs and reports count", async () => {
    let posted = false;
    const dash = spawnFake({
      "POST /api/notifications/read-all": () => {
        posted = true;
        return Response.json({ ok: true, marked: 7 });
      },
    });
    try {
      const r = run(["notif", "mark-all-read"], {
        SUBCTL_SERVICE_PORT: String(dash.port),
      });
      expect(r.code).toBe(0);
      expect(posted).toBe(true);
      expect(r.stdout).toMatch(/marked 7/);
    } finally {
      dash.stop();
    }
  });

  test("invalid list count rejected", () => {
    const r = run(["notif", "list", "999"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/1\.\.200/);
  });
});

// ── memory ──────────────────────────────────────────────────────────────────
describe("subctl memory", () => {
  test("recent renders rows", async () => {
    const dash = spawnFake({
      "/api/memory/recent": () =>
        Response.json({
          ok: true,
          count: 2,
          entries: [
            {
              id: "m1",
              created_at: "2026-05-13T11:00:00Z",
              kind: "note",
              team_id: null,
              content: "operator says: deploy looks clean",
            },
            {
              id: "m2",
              created_at: "2026-05-13T10:00:00Z",
              kind: "decision",
              team_id: "v2.7.28-cli",
              content: "shipping CLI",
            },
          ],
        }),
    });
    try {
      const r = run(["memory", "recent"], {
        SUBCTL_SERVICE_PORT: String(dash.port),
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("operator says");
      expect(r.stdout).toContain("shipping CLI");
      expect(r.stdout).toContain("decision");
    } finally {
      dash.stop();
    }
  });

  test("search hits /api/memory/search with url-encoded query", async () => {
    let seenQuery: string | null = null;
    const dash = spawnFake({
      "/api/memory/search": (req) => {
        const u = new URL(req.url);
        seenQuery = u.searchParams.get("query");
        return Response.json({
          ok: true,
          count: 1,
          entries: [
            {
              id: "m9",
              created_at: "2026-05-13T12:00:00Z",
              kind: "note",
              team_id: null,
              content: "matched: deploy looks clean",
            },
          ],
        });
      },
    });
    try {
      const r = run(["memory", "search", "deploy looks clean"], {
        SUBCTL_SERVICE_PORT: String(dash.port),
      });
      expect(r.code).toBe(0);
      expect(seenQuery).toBe("deploy looks clean");
      expect(r.stdout).toContain("matched: deploy looks clean");
    } finally {
      dash.stop();
    }
  });

  test("remember POSTs payload + reports id", async () => {
    let body: unknown = null;
    const dash = spawnFake({
      "POST /api/memory/entries": async (req) => {
        body = await req.json();
        return Response.json({
          ok: true,
          entry: { id: "abc-123" },
        });
      },
    });
    try {
      const r = run(["memory", "remember", "v2.7.28", "CLI", "bootstrap"], {
        SUBCTL_SERVICE_PORT: String(dash.port),
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/abc-123/);
      expect(body).toEqual({
        content: "v2.7.28 CLI bootstrap",
        kind: "note",
      });
    } finally {
      dash.stop();
    }
  });

  test("remember without text → exit 1", () => {
    const r = run(["memory", "remember"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/body text/);
  });
});

// ── v2.7.36 — team ──────────────────────────────────────────────────────────
describe("subctl team (v2.7.36)", () => {
  test("--help lists list/kill/exec/logs verbs", () => {
    const r = run(["team", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("list");
    expect(r.stdout).toContain("kill");
    expect(r.stdout).toContain("exec");
    expect(r.stdout).toContain("logs");
  });

  test("list renders rows from /api/orchestration", async () => {
    const dash = spawnFake({
      "/api/orchestration": () =>
        Response.json({
          orchestrations: [
            {
              name: "v2.7.36-cli",
              path: "/Users/op/code/subctl",
              attached: true,
              windows: 2,
              claude_account_dir: "/Users/op/.claude-dev",
              is_orchestrator: true,
              last_activity_seconds_ago: 12,
              last_event_type: "progress",
              last_event_text: "branch created",
            },
            {
              name: "v2.7.36-stuck",
              path: "/Users/op/code/subctl",
              attached: false,
              windows: 1,
              claude_account_dir: "/Users/op/.claude-dev",
              is_orchestrator: true,
              last_activity_seconds_ago: 3600,
              last_event_type: "blocked",
              last_event_text: "lint failing on foo.ts",
            },
          ],
        }),
    });
    try {
      const r = run(["team", "list"], { SUBCTL_SERVICE_PORT: String(dash.port) });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("v2.7.36-cli");
      expect(r.stdout).toContain("v2.7.36-stuck");
      expect(r.stdout).toContain("progress");
      expect(r.stdout).toContain("blocked");
      expect(r.stdout).toContain("branch created");
    } finally {
      dash.stop();
    }
  });

  test("list with zero orchestrations prints empty marker", async () => {
    const dash = spawnFake({
      "/api/orchestration": () => Response.json({ orchestrations: [] }),
    });
    try {
      const r = run(["team", "list"], { SUBCTL_SERVICE_PORT: String(dash.port) });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/no active orchestrator sessions/);
    } finally {
      dash.stop();
    }
  });

  test("kill POSTs /kill + archives inbox", async () => {
    let posted = false;
    const dash = spawnFake({
      "POST /api/orchestration/v2.7.36-cli/kill": () => {
        posted = true;
        return Response.json({ ok: true });
      },
    });
    const inboxDir = mkdtempSync(join(tmpdir(), "subctl-team-kill-"));
    writeFileSync(
      join(inboxDir, "v2.7.36-cli.jsonl"),
      JSON.stringify({ ts: "2026-05-13T11:00:00Z", type: "done", text: "ready" }) + "\n",
    );
    try {
      const r = run(["team", "kill", "v2.7.36-cli"], {
        SUBCTL_SERVICE_PORT: String(dash.port),
        SUBCTL_EVY_INBOX: inboxDir,
      });
      expect(r.code).toBe(0);
      expect(posted).toBe(true);
      expect(r.stdout + r.stderr).toMatch(/killed team/);
      // Original inbox file should be gone…
      const fs = require("node:fs");
      expect(fs.existsSync(join(inboxDir, "v2.7.36-cli.jsonl"))).toBe(false);
      // …and a .killed/ archive should exist with at least one file.
      expect(fs.existsSync(join(inboxDir, ".killed"))).toBe(true);
      const archived = fs.readdirSync(join(inboxDir, ".killed"));
      expect(archived.some((f: string) => f.startsWith("v2.7.36-cli."))).toBe(true);
    } finally {
      dash.stop();
      rmSync(inboxDir, { recursive: true, force: true });
    }
  });

  test("exec POSTs text to /msg", async () => {
    let body: unknown = null;
    const dash = spawnFake({
      "POST /api/orchestration/v2.7.36-cli/msg": async (req) => {
        body = await req.json();
        return Response.json({ ok: true });
      },
    });
    try {
      const r = run(["team", "exec", "v2.7.36-cli", "report", "progress"], {
        SUBCTL_SERVICE_PORT: String(dash.port),
      });
      expect(r.code).toBe(0);
      expect(body).toEqual({ text: "report progress" });
    } finally {
      dash.stop();
    }
  });

  test("exec without text → exit 1", () => {
    const r = run(["team", "exec", "v2.7.36-cli"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/usage: subctl team exec/);
  });

  test("logs tails an inbox JSONL", () => {
    const inboxDir = mkdtempSync(join(tmpdir(), "subctl-team-logs-"));
    writeFileSync(
      join(inboxDir, "v2.7.36-cli.jsonl"),
      [
        JSON.stringify({ ts: "2026-05-13T11:00:00Z", type: "progress", text: "branch up" }),
        JSON.stringify({ ts: "2026-05-13T11:05:00Z", type: "done", text: "PR open" }),
      ].join("\n") + "\n",
    );
    try {
      const r = run(["team", "logs", "v2.7.36-cli"], {
        SUBCTL_EVY_INBOX: inboxDir,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("PR open");
      expect(r.stdout).toContain("PROGRESS");
      expect(r.stdout).toContain("DONE");
    } finally {
      rmSync(inboxDir, { recursive: true, force: true });
    }
  });

  test("logs for missing inbox → exit 1", () => {
    const inboxDir = mkdtempSync(join(tmpdir(), "subctl-team-logs-empty-"));
    try {
      const r = run(["team", "logs", "nonexistent"], { SUBCTL_EVY_INBOX: inboxDir });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/no inbox/);
    } finally {
      rmSync(inboxDir, { recursive: true, force: true });
    }
  });
});

// ── v2.7.36 — config ────────────────────────────────────────────────────────
describe("subctl config (v2.7.36)", () => {
  let cfgDir: string;

  beforeAll(() => {
    cfgDir = mkdtempSync(join(tmpdir(), "subctl-cfg-"));
    // accounts.conf
    writeFileSync(
      join(cfgDir, "accounts.conf"),
      "# example\npersonal | claude | me@x.com | ~/.claude-personal | personal\n",
    );
    // notify.json contains a real-looking (but fake) Telegram bot token; must
    // be redacted. The fake token matches the redaction regex
    // /[0-9]{8,12}:[A-Za-z0-9_-]{30,}/ so the assertion is meaningful, but the
    // value is obviously not a real credential. NEVER paste real tokens here.
    writeFileSync(
      join(cfgDir, "notify.json"),
      JSON.stringify(
        {
          telegram_bot_token: "0000000000:FAKE_TEST_TOKEN_DO_NOT_USE_IN_PRODUCTION",
          telegram_chat_id: "1234567890",
        },
        null,
        2,
      ),
    );
    // master/providers.json — exercise key-based redaction (api_key field).
    mkdirSync(join(cfgDir, "evy"), { recursive: true });
    writeFileSync(
      join(cfgDir, "evy", "providers.json"),
      JSON.stringify(
        {
          models: { supervisor: { model: "gpt-4o", host: "https://api.openai.com/v1" } },
          api_key: "sk-abcdefghijklmno",
          secrets: { anthropic_token: "sk-ant-abc1234567890" },
        },
        null,
        2,
      ),
    );
    // config.toml — well-formed
    writeFileSync(join(cfgDir, "config.toml"), "[update]\nlast_run = \"now\"\n");
  });

  afterAll(() => {
    rmSync(cfgDir, { recursive: true, force: true });
  });

  test("--help lists show/edit/validate verbs", () => {
    const r = run(["config", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("show");
    expect(r.stdout).toContain("edit");
    expect(r.stdout).toContain("validate");
  });

  test("show <section> redacts JSON values whose key matches secret pattern", () => {
    const r = run(["config", "show", "providers"], { SUBCTL_CONFIG_DIR: cfgDir });
    expect(r.code).toBe(0);
    // Non-secret fields are kept.
    expect(r.stdout).toContain("gpt-4o");
    // sk-* values are stripped (both directly and via key-based redaction).
    expect(r.stdout).not.toContain("sk-abcdefghijklmno");
    expect(r.stdout).not.toContain("sk-ant-abc1234567890");
    // The "api_key" + "anthropic_token" keys must have been redacted via key-walk.
    expect(r.stdout).toMatch(/redacted/);
  });

  test("show notify redacts telegram bot token (textual)", () => {
    const r = run(["config", "show", "notify"], { SUBCTL_CONFIG_DIR: cfgDir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("0000000000:FAKE_TEST_TOKEN_DO_NOT_USE_IN_PRODUCTION");
  });

  test("show with no section iterates all known files", () => {
    const r = run(["config", "show"], { SUBCTL_CONFIG_DIR: cfgDir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("accounts");
    expect(r.stdout).toContain("notify");
    expect(r.stdout).toContain("providers");
  });

  test("show <unknown> → exit 1", () => {
    const r = run(["config", "show", "nonsense"], { SUBCTL_CONFIG_DIR: cfgDir });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown section/);
  });

  test("validate passes on well-formed JSON + text + toml", () => {
    const r = run(["config", "validate"], { SUBCTL_CONFIG_DIR: cfgDir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/valid JSON/);
    expect(r.stdout).toMatch(/text\/pipe-form/);
    expect(r.stdout).toMatch(/toml-shaped/);
  });

  test("validate fails on malformed JSON", () => {
    const broken = mkdtempSync(join(tmpdir(), "subctl-cfg-bad-"));
    writeFileSync(join(broken, "notify.json"), "{ this is not json");
    writeFileSync(join(broken, "accounts.conf"), "");
    try {
      const r = run(["config", "validate"], { SUBCTL_CONFIG_DIR: broken });
      expect(r.code).toBe(1);
      expect(r.stdout + r.stderr).toMatch(/invalid JSON/);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

// ── v2.7.36 — profile ──────────────────────────────────────────────────────
describe("subctl profile (v2.7.36)", () => {
  test("--help lists show/switch/list verbs", () => {
    const r = run(["profile", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("show");
    expect(r.stdout).toContain("switch");
    expect(r.stdout).toContain("list");
  });

  test("show renders active profile + supervisor", async () => {
    const dash = spawnFake({
      "/api/profile": () =>
        Response.json({
          ok: true,
          active: "chat",
          profiles: ["chat", "heavy"],
          detail: {
            chat: { supervisor: "google/gemma-4-31b", host: "http://localhost:1234/v1" },
            heavy: { supervisor: "qwen/qwen3.6-35b-a3b", host: "http://localhost:1234/v1" },
          },
        }),
    });
    try {
      const r = run(["profile", "show"], { SUBCTL_SERVICE_PORT: String(dash.port) });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/active.*chat/);
      expect(r.stdout).toContain("google/gemma-4-31b");
      expect(r.stdout).toContain("http://localhost:1234/v1");
    } finally {
      dash.stop();
    }
  });

  test("list renders both profiles with active marker", async () => {
    const dash = spawnFake({
      "/api/profile": () =>
        Response.json({
          ok: true,
          active: "heavy",
          profiles: ["chat", "heavy"],
          detail: {
            chat: { supervisor: "google/gemma-4-31b", host: "http://localhost:1234/v1" },
            heavy: { supervisor: "qwen/qwen3.6-35b-a3b", host: "http://localhost:1234/v1" },
          },
        }),
    });
    try {
      const r = run(["profile", "list"], { SUBCTL_SERVICE_PORT: String(dash.port) });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/\* heavy/);
      expect(r.stdout).toMatch(/  chat/);
      expect(r.stdout).toContain("qwen/qwen3.6-35b-a3b");
    } finally {
      dash.stop();
    }
  });

  test("switch POSTs profile name and reports new active", async () => {
    let body: unknown = null;
    const dash = spawnFake({
      "POST /api/profile": async (req) => {
        body = await req.json();
        return Response.json({ ok: true, active: "heavy", note: "takes effect on next prompt" });
      },
    });
    try {
      const r = run(["profile", "switch", "heavy"], { SUBCTL_SERVICE_PORT: String(dash.port) });
      expect(r.code).toBe(0);
      expect(body).toEqual({ profile: "heavy" });
      expect(r.stdout).toMatch(/active profile.*heavy/);
    } finally {
      dash.stop();
    }
  });

  test("switch without arg → exit 1", () => {
    const r = run(["profile", "switch"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/usage: subctl profile switch/);
  });
});
