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

// v2.7.32 — read the canonical VERSION on every test run so this suite
// doesn't break on the next bump. Prior versions hardcoded "2.7.28";
// the operator hit it as soon as v2.7.32 landed.
const CURRENT_VERSION = readFileSync(join(REPO_ROOT, "VERSION"), "utf8").trim();

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
      SUBCTL_MASTER_PORT: env.SUBCTL_MASTER_PORT ?? "1",
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

  test("`subctl --help` lists v2.7.28 subcommands", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    // The five new verbs all appear in the help block.
    expect(r.stdout).toContain("subctl status");
    expect(r.stdout).toContain("subctl logs");
    expect(r.stdout).toContain("subctl deploy");
    expect(r.stdout).toContain("subctl notif");
    expect(r.stdout).toContain("subctl memory");
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
        SUBCTL_MASTER_PORT: String(master.port),
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
        SUBCTL_MASTER_PORT: String(master.port),
        SUBCTL_SERVICE_PORT: String(dash.port),
      });
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.ok).toBe(true);
      expect(doc.cli_version).toBe(CURRENT_VERSION);
      // Master + dashboard versions still hardcoded — they're the
      // FAKE daemon's response in this test fixture, not the CLI's
      // self-report. Pinned to 2.7.28 because that's what the fake
      // emits above.
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
    writeFileSync(join(logRoot, "master.log"), "master line 1\nmaster line 2\n");
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

  test("--master only prints master.log (no dashboard content)", () => {
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
