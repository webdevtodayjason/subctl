// components/evy/__tests__/plan-approvals.test.ts
//
// v2.7.29 — plan-approval queue.
//
// Pins:
//   1. record → list → approve → status flips, returned record reflects
//      decided_at + decided_by.
//   2. record → list → reject with feedback → status flips, feedback
//      survives.
//   3. expireOldRequests removes pending past threshold; pending-but-fresh
//      entries are untouched; idempotent on re-call.
//   4. Concurrent approve attempts: second call throws ApprovalError /
//      not-pending, the queue ends in a single "approved" state, and the
//      caller can recover the existing record.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  recordApprovalRequest,
  listPending,
  listDecided,
  getApproval,
  approveRequest,
  rejectRequest,
  expireOldRequests,
  setLogPathForTesting,
  _resetForTesting,
  ApprovalError,
} from "../plan-approvals";

let _tmp: string;

beforeEach(() => {
  _tmp = mkdtempSync(join(tmpdir(), "plan-approvals-"));
  setLogPathForTesting(join(_tmp, "log.jsonl"));
});

afterEach(() => {
  setLogPathForTesting(null);
  _resetForTesting();
  try {
    rmSync(_tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("recordApprovalRequest / listPending / getApproval", () => {
  test("record + list round-trip exposes the entry as pending", () => {
    const a = recordApprovalRequest({
      request_id: "req-1",
      worker_name: "profiles-impl",
      team_id: "claude-profiles",
      plan_summary: "Refactor profile loader",
      plan_body: "1. Move config\n2. Add tests",
    });
    expect(a.status).toBe("pending");
    expect(a.id.length).toBeGreaterThan(0);
    expect(a.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const pending = listPending();
    expect(pending.length).toBe(1);
    expect(pending[0]!.id).toBe(a.id);
    expect(pending[0]!.plan_summary).toBe("Refactor profile loader");
    expect(getApproval(a.id)?.request_id).toBe("req-1");
  });

  test("plan_summary >120 chars is truncated with ellipsis", () => {
    const long = "x".repeat(200);
    const a = recordApprovalRequest({
      request_id: "r",
      worker_name: "w",
      team_id: "t",
      plan_summary: long,
      plan_body: "",
    });
    expect(a.plan_summary.length).toBeLessThanOrEqual(120);
    expect(a.plan_summary.endsWith("…")).toBe(true);
  });

  test("empty plan_summary defaults to '(no summary)'", () => {
    const a = recordApprovalRequest({
      request_id: "r",
      worker_name: "w",
      team_id: "t",
      plan_summary: "   ",
      plan_body: "",
    });
    expect(a.plan_summary).toBe("(no summary)");
  });
});

describe("approveRequest / rejectRequest", () => {
  test("approve flips status, populates decided_*, leaves feedback undefined", () => {
    const a = recordApprovalRequest({
      request_id: "r",
      worker_name: "w",
      team_id: "t",
      plan_summary: "ok",
      plan_body: "",
    });
    const after = approveRequest(a.id);
    expect(after.status).toBe("approved");
    expect(after.decided_by).toBe("operator");
    expect(after.decided_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(after.feedback).toBeUndefined();
    expect(listPending()).toHaveLength(0);
    expect(listDecided()).toHaveLength(1);
    expect(listDecided()[0]!.status).toBe("approved");
  });

  test("reject flips status and persists feedback", () => {
    const a = recordApprovalRequest({
      request_id: "r",
      worker_name: "w",
      team_id: "t",
      plan_summary: "ok",
      plan_body: "",
    });
    const after = rejectRequest(a.id, "needs error handling");
    expect(after.status).toBe("rejected");
    expect(after.feedback).toBe("needs error handling");
    expect(after.decided_by).toBe("operator");
    expect(listPending()).toHaveLength(0);
    expect(listDecided()[0]!.feedback).toBe("needs error handling");
  });

  test("unknown id throws not-found", () => {
    let caught: unknown;
    try {
      approveRequest("does-not-exist");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApprovalError);
    expect((caught as ApprovalError).code).toBe("not-found");
  });
});

describe("expireOldRequests", () => {
  test("flips pending entries past threshold to expired with feedback", () => {
    const old = recordApprovalRequest({
      request_id: "old",
      worker_name: "w",
      team_id: "t",
      plan_summary: "stale",
      plan_body: "",
      // 70 min ago — past the default 60 min threshold.
      created_at: new Date(Date.now() - 70 * 60_000).toISOString(),
    });
    const fresh = recordApprovalRequest({
      request_id: "fresh",
      worker_name: "w",
      team_id: "t",
      plan_summary: "still ok",
      plan_body: "",
    });
    expect(expireOldRequests(60)).toBe(1);
    const oldAfter = getApproval(old.id);
    expect(oldAfter?.status).toBe("expired");
    expect(oldAfter?.decided_by).toBe("auto-timeout");
    expect(oldAfter?.feedback).toBe("auto-expired");
    const freshAfter = getApproval(fresh.id);
    expect(freshAfter?.status).toBe("pending");
    // Second call is a no-op for the same threshold.
    expect(expireOldRequests(60)).toBe(0);
  });
});

describe("concurrent approve / reject races", () => {
  test("second concurrent approve throws not-pending; queue holds single approved state", () => {
    const a = recordApprovalRequest({
      request_id: "r",
      worker_name: "w",
      team_id: "t",
      plan_summary: "concurrent",
      plan_body: "",
    });
    const first = approveRequest(a.id);
    expect(first.status).toBe("approved");
    let caught: unknown;
    try {
      approveRequest(a.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApprovalError);
    expect((caught as ApprovalError).code).toBe("not-pending");
    // Queue still holds exactly one (approved) record under this id.
    expect(getApproval(a.id)?.status).toBe("approved");
    expect(listDecided()).toHaveLength(1);
  });

  test("approve-after-reject also rejects with not-pending", () => {
    const a = recordApprovalRequest({
      request_id: "r",
      worker_name: "w",
      team_id: "t",
      plan_summary: "concurrent",
      plan_body: "",
    });
    rejectRequest(a.id, "no");
    let caught: unknown;
    try {
      approveRequest(a.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApprovalError);
    expect((caught as ApprovalError).code).toBe("not-pending");
    expect(getApproval(a.id)?.status).toBe("rejected");
  });
});

describe("persistence", () => {
  test("queue replays from the JSONL log on next load", () => {
    const a = recordApprovalRequest({
      request_id: "r",
      worker_name: "persistent-worker",
      team_id: "t",
      plan_summary: "survives restart",
      plan_body: "body",
    });
    approveRequest(a.id);
    // Force a fresh load from the same on-disk log.
    const path = (
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../plan-approvals") as typeof import("../plan-approvals")
    ).getLogPath();
    _resetForTesting();
    setLogPathForTesting(path);
    const after = getApproval(a.id);
    expect(after?.status).toBe("approved");
    expect(after?.worker_name).toBe("persistent-worker");
  });
});
