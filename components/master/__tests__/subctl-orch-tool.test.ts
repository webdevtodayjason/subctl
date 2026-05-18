// components/master/__tests__/subctl-orch-tool.test.ts
//
// Regression coverage for the 2026-05-18 template-spawn 500 incident.
//
// Before the fix, subctlOrchTools.spawn_template threw `subctl
// /api/orchestration/spawn → HTTP 500` with no body content — Evy saw
// only the status code, gave up on the template path, and fell back
// to raw spawn(). After the fix, the dashboard's structured
// {error, error_kind} body bubbles up into the supervisor-visible
// exception so the model can recover or escalate intelligently.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { subctlOrchTools } from "../tools/subctl-orch";

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const realFetch = globalThis.fetch;

function withFetch(mock: FetchMock, fn: () => Promise<void>) {
  // @ts-expect-error overriding for the test
  globalThis.fetch = mock as unknown as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = realFetch;
  });
}

describe("subctlOrchTools.spawn_template error surfacing", () => {
  test("propagates dashboard error body (template_not_found)", async () => {
    await withFetch(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: " ✗ team template not found: /tmp/code-review.json",
            error_kind: "template_not_found",
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
      async () => {
        let caught: Error | null = null;
        try {
          await subctlOrchTools.spawn_template.invoke({
            template: "code-review",
            account: "claude-jason",
            project: "/Users/sem/code/subctl",
          });
        } catch (err) {
          caught = err as Error;
        }
        expect(caught).not.toBeNull();
        const msg = caught!.message;
        expect(msg).toContain("HTTP 404");
        expect(msg).toContain("template_not_found");
        expect(msg).toContain("team template not found");
      },
    );
  });

  test("falls back to raw text when body is not JSON", async () => {
    await withFetch(
      async () =>
        new Response("internal server error\n", {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }),
      async () => {
        let caught: Error | null = null;
        try {
          await subctlOrchTools.spawn_template.invoke({
            template: "code-review",
            account: "claude-jason",
            project: "/Users/sem/code/subctl",
          });
        } catch (err) {
          caught = err as Error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.message).toContain("HTTP 500");
        expect(caught!.message).toContain("internal server error");
      },
    );
  });

  test("does not throw on 200 success", async () => {
    await withFetch(
      async () =>
        new Response(
          JSON.stringify({ ok: true, session_name: "claude-test", spawned: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      async () => {
        // Stub HOME so seedInboxOnSpawn writes into a tmpdir, not the real
        // operator inbox.
        const tmp = await import("node:fs/promises");
        const path = await import("node:path");
        const os = await import("node:os");
        const sandbox = await tmp.mkdtemp(path.join(os.tmpdir(), "subctl-orch-tool-"));
        const prevCfg = process.env.SUBCTL_CONFIG_DIR;
        process.env.SUBCTL_CONFIG_DIR = sandbox;
        try {
          const result = (await subctlOrchTools.spawn_template.invoke({
            template: "code-review",
            account: "claude-jason",
            project: "/Users/sem/code/subctl",
          })) as { ok?: boolean; session_name?: string };
          expect(result.ok).toBe(true);
          expect(result.session_name).toBe("claude-test");
        } finally {
          if (prevCfg === undefined) delete process.env.SUBCTL_CONFIG_DIR;
          else process.env.SUBCTL_CONFIG_DIR = prevCfg;
          await tmp.rm(sandbox, { recursive: true, force: true });
        }
      },
    );
  });
});
