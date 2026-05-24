// components/evy/__tests__/mcp-auth.test.ts
//
// MCP-Expose (#24, wave 1) — auth rejection + acceptance matrix.
//
// What we pin here:
//   1. Missing Authorization header → 401 missing_authorization
//   2. Non-Bearer scheme           → 401 invalid_authorization_scheme
//   3. Wrong bearer token          → 401 invalid_token
//   4. Missing X-Caller-Id         → 400 missing_caller_id
//   5. Malformed X-Caller-Id       → 400 invalid_caller_id
//   6. Valid bearer + caller_id    → ok: true, caller_id verbatim
//   7. parseBearer tolerates case + extra whitespace
//   8. validateCallerId enforces the allowed character envelope
//   9. Live handle: invalid auth surfaces as a JSON body with the
//      machine-readable error code (not the raw expected token).
//
// The pure functions (authenticateRequest / parseBearer / validateCallerId)
// are exercised directly. The end-to-end handle behaviour is hit via
// `startMcpServer` + a synthesized Request — no socket binding required.

import { describe, expect, test } from "bun:test";

import {
  authenticateRequest,
  parseBearer,
  validateCallerId,
  HEADERS,
} from "../mcp/auth";
import { startMcpServer } from "../mcp";

const TOKEN = "test-bearer-token-very-secret";

function reqWith(headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:8788/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
}

describe("parseBearer", () => {
  test("extracts the token from a well-formed header", () => {
    expect(parseBearer("Bearer abc")).toBe("abc");
  });
  test("tolerates extra whitespace", () => {
    expect(parseBearer("  Bearer   xyz123  ")).toBe("xyz123");
  });
  test("is case-insensitive on the scheme", () => {
    expect(parseBearer("bearer foo")).toBe("foo");
    expect(parseBearer("BEARER foo")).toBe("foo");
  });
  test("returns null on missing / empty / wrong-scheme inputs", () => {
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer("Bearer ")).toBeNull();
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer("Token abc")).toBeNull();
  });
});

describe("validateCallerId", () => {
  test("accepts plain alnum + the allowed separators", () => {
    expect(validateCallerId("claude-desktop")).toBe("claude-desktop");
    expect(validateCallerId("orch-claude-code-abc123")).toBe(
      "orch-claude-code-abc123",
    );
    expect(validateCallerId("argentos.v2.7")).toBe("argentos.v2.7");
    expect(validateCallerId("scope:tool_name_v3")).toBe("scope:tool_name_v3");
  });
  test("rejects empty / null / undefined", () => {
    expect(validateCallerId(null)).toBeNull();
    expect(validateCallerId(undefined)).toBeNull();
    expect(validateCallerId("")).toBeNull();
  });
  test("rejects forbidden characters (spaces, quotes, control bytes)", () => {
    expect(validateCallerId("has space")).toBeNull();
    expect(validateCallerId('quote"')).toBeNull();
    expect(validateCallerId("ctrl")).toBeNull();
    expect(validateCallerId("slash/bad")).toBeNull();
  });
  test("rejects values longer than 128 chars", () => {
    expect(validateCallerId("a".repeat(128))).toBe("a".repeat(128));
    expect(validateCallerId("a".repeat(129))).toBeNull();
  });
});

describe("authenticateRequest", () => {
  test("happy path returns the caller_id verbatim", () => {
    const r = authenticateRequest(
      reqWith({
        [HEADERS.bearer]: `Bearer ${TOKEN}`,
        [HEADERS.callerId]: "claude-desktop",
      }),
      { expectedToken: TOKEN },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.caller_id).toBe("claude-desktop");
  });

  test("missing Authorization → 401 missing_authorization", () => {
    const r = authenticateRequest(
      reqWith({ [HEADERS.callerId]: "claude-desktop" }),
      { expectedToken: TOKEN },
    );
    expect(r).toEqual({
      ok: false,
      status: 401,
      error: "missing_authorization",
    });
  });

  test("non-Bearer scheme → 401 invalid_authorization_scheme", () => {
    const r = authenticateRequest(
      reqWith({
        [HEADERS.bearer]: "Basic ZGVtbzpkZW1v",
        [HEADERS.callerId]: "claude-desktop",
      }),
      { expectedToken: TOKEN },
    );
    expect(r).toEqual({
      ok: false,
      status: 401,
      error: "invalid_authorization_scheme",
    });
  });

  test("wrong token → 401 invalid_token", () => {
    const r = authenticateRequest(
      reqWith({
        [HEADERS.bearer]: "Bearer not-the-right-token",
        [HEADERS.callerId]: "claude-desktop",
      }),
      { expectedToken: TOKEN },
    );
    expect(r).toEqual({ ok: false, status: 401, error: "invalid_token" });
  });

  test("missing X-Caller-Id → 400 missing_caller_id", () => {
    const r = authenticateRequest(
      reqWith({ [HEADERS.bearer]: `Bearer ${TOKEN}` }),
      { expectedToken: TOKEN },
    );
    expect(r).toEqual({ ok: false, status: 400, error: "missing_caller_id" });
  });

  test("malformed X-Caller-Id → 400 invalid_caller_id", () => {
    const r = authenticateRequest(
      reqWith({
        [HEADERS.bearer]: `Bearer ${TOKEN}`,
        [HEADERS.callerId]: "has space",
      }),
      { expectedToken: TOKEN },
    );
    expect(r).toEqual({ ok: false, status: 400, error: "invalid_caller_id" });
  });

  test("token check is constant-time-style: same-length wrong token still 401", () => {
    // The point is "doesn't crash + still 401", not measuring timing.
    const wrong = TOKEN.replace(/./g, "x");
    expect(wrong).toHaveLength(TOKEN.length);
    const r = authenticateRequest(
      reqWith({
        [HEADERS.bearer]: `Bearer ${wrong}`,
        [HEADERS.callerId]: "claude-desktop",
      }),
      { expectedToken: TOKEN },
    );
    expect(r).toEqual({ ok: false, status: 401, error: "invalid_token" });
  });
});

describe("startMcpServer — disabled path", () => {
  test("returns null when token is missing/empty/whitespace", async () => {
    for (const t of [undefined, null, "", "   "] as const) {
      const h = await startMcpServer({
        expectedToken: t,
        serverInfo: { name: "subctl-master", version: "0.0.0-test" },
        log: () => {},
      });
      expect(h).toBeNull();
    }
  });

  test("logs the disabled reason exactly once", async () => {
    const lines: string[] = [];
    const h = await startMcpServer({
      expectedToken: null,
      serverInfo: { name: "subctl-master", version: "0.0.0-test" },
      log: (l) => lines.push(l),
    });
    expect(h).toBeNull();
    expect(lines).toEqual(["disabled — no subctl_mcp_token secret"]);
  });
});

describe("startMcpServer — auth integration via handle()", () => {
  test("rejects missing auth with 401 + JSON body", async () => {
    const h = await startMcpServer({
      expectedToken: TOKEN,
      serverInfo: { name: "subctl-master", version: "0.0.0-test" },
      log: () => {},
    });
    expect(h).not.toBeNull();
    if (!h) throw new Error("expected handle");
    try {
      const res = await h.handle(
        new Request("http://127.0.0.1:8788/mcp", { method: "POST" }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body).toEqual({ ok: false, error: "missing_authorization" });
    } finally {
      await h.stop();
    }
  });

  test("rejects missing caller_id with 400", async () => {
    const h = await startMcpServer({
      expectedToken: TOKEN,
      serverInfo: { name: "subctl-master", version: "0.0.0-test" },
      log: () => {},
    });
    if (!h) throw new Error("expected handle");
    try {
      const res = await h.handle(
        new Request("http://127.0.0.1:8788/mcp", {
          method: "POST",
          headers: { [HEADERS.bearer]: `Bearer ${TOKEN}` },
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.error).toBe("missing_caller_id");
    } finally {
      await h.stop();
    }
  });

  test("rejects wrong bearer with 401 invalid_token", async () => {
    const h = await startMcpServer({
      expectedToken: TOKEN,
      serverInfo: { name: "subctl-master", version: "0.0.0-test" },
      log: () => {},
    });
    if (!h) throw new Error("expected handle");
    try {
      const res = await h.handle(
        new Request("http://127.0.0.1:8788/mcp", {
          method: "POST",
          headers: {
            [HEADERS.bearer]: "Bearer nope",
            [HEADERS.callerId]: "claude-desktop",
          },
        }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.error).toBe("invalid_token");
    } finally {
      await h.stop();
    }
  });

  test("auth error response does NOT leak the expected token", async () => {
    const h = await startMcpServer({
      expectedToken: TOKEN,
      serverInfo: { name: "subctl-master", version: "0.0.0-test" },
      log: () => {},
    });
    if (!h) throw new Error("expected handle");
    try {
      const res = await h.handle(
        new Request("http://127.0.0.1:8788/mcp", {
          method: "POST",
          headers: {
            [HEADERS.bearer]: "Bearer wrong",
            [HEADERS.callerId]: "claude-desktop",
          },
        }),
      );
      const text = await res.text();
      expect(text).not.toContain(TOKEN);
    } finally {
      await h.stop();
    }
  });

  test("paths outside /.well-known/mcp and /mcp 404", async () => {
    const h = await startMcpServer({
      expectedToken: TOKEN,
      serverInfo: { name: "subctl-master", version: "0.0.0-test" },
      log: () => {},
    });
    if (!h) throw new Error("expected handle");
    try {
      const res = await h.handle(
        new Request("http://127.0.0.1:8788/other"),
      );
      expect(res.status).toBe(404);
    } finally {
      await h.stop();
    }
  });
});
