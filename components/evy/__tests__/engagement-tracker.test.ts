// components/evy/__tests__/engagement-tracker.test.ts
//
// v3.1.0 — Kernel Fitness Phase 1.
//
// Pins:
//   1. recordSurfaceEmitted writes a JSONL line at the canonical path.
//   2. recordEngagement writes a follow-on entry under the same surface_id.
//   3. runTimeoutSweeper writes `ignored` for surfaces older than 24h
//      with no outcome, and is idempotent on re-run.
//   4. setLedgerPathForTesting confines writes to the override; production
//      path stays untouched.
//   5. makeSurfaceId is deterministic for identical inputs.
//
// The load-bearing negative-criterion test lives in a sibling file
// (`engagement-ledger-isolation.test.ts`) so its failures speak for
// themselves at the suite-listing level.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _resetForTesting,
  getLedgerPath,
  hashPayload,
  makeSurfaceId,
  recordEngagement,
  recordSurfaceEmitted,
  runTimeoutSweeper,
  setLedgerPathForTesting,
} from "../engagement-tracker";
import type { LedgerEntry } from "../engagement-types";

let tmpDir: string;
let ledgerPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subctl-engagement-"));
  ledgerPath = join(tmpDir, "engagement-ledger.jsonl");
  setLedgerPathForTesting(ledgerPath);
});

afterEach(() => {
  _resetForTesting();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function readLedger(): LedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];
  const raw = readFileSync(ledgerPath, "utf8");
  const out: LedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    out.push(JSON.parse(t) as LedgerEntry);
  }
  return out;
}

describe("engagement-tracker", () => {
  test("recordSurfaceEmitted writes a single ledger line", () => {
    recordSurfaceEmitted("abcd0123ef456789", "chat_response", hashPayload("hello"));
    const entries = readLedger();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.type).toBe("surface_emitted");
    if (e.type !== "surface_emitted") throw new Error("type narrowing");
    expect(e.surface_id).toBe("abcd0123ef456789");
    expect(e.surface_type).toBe("chat_response");
    expect(e.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof e.ts).toBe("string");
    // ISO-8601 sanity.
    expect(Number.isFinite(Date.parse(e.ts))).toBe(true);
  });

  test("recordEngagement appends a follow-on entry under the same surface_id", () => {
    recordSurfaceEmitted("sid-acted-0001", "chat_response", hashPayload("q"));
    recordEngagement("sid-acted-0001", "acted", "dashboard_click", 1234);
    const entries = readLedger();
    expect(entries).toHaveLength(2);
    const second = entries[1];
    expect(second.type).toBe("engagement");
    if (second.type !== "engagement") throw new Error("type narrowing");
    expect(second.surface_id).toBe("sid-acted-0001");
    expect(second.outcome).toBe("acted");
    expect(second.source).toBe("dashboard_click");
    expect(second.latency_ms).toBe(1234);
  });

  test("recordEngagement omits latency_ms when not provided", () => {
    recordSurfaceEmitted("sid-no-lat", "telegram_message", hashPayload("x"));
    recordEngagement("sid-no-lat", "acked", "telegram_reply");
    const entries = readLedger();
    const second = entries[1];
    if (second.type !== "engagement") throw new Error("type narrowing");
    expect(second.latency_ms).toBeUndefined();
  });

  test("runTimeoutSweeper writes ignored for surfaces older than 24h with no outcome", async () => {
    // Plant a 30-hour-old surface_emitted line by hand so we don't have to
    // mock Date.now(): the ts inside the entry is what the sweeper reads.
    const oldTs = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const fs = await import("node:fs");
    const oldEntry: LedgerEntry = {
      type: "surface_emitted",
      ts: oldTs,
      surface_id: "sid-stale-001",
      surface_type: "chat_response",
      payload_hash: hashPayload("stale"),
    };
    fs.mkdirSync(join(tmpDir), { recursive: true });
    fs.appendFileSync(ledgerPath, JSON.stringify(oldEntry) + "\n");

    // Plant a fresh surface that MUST NOT get swept.
    recordSurfaceEmitted("sid-fresh-001", "chat_response", hashPayload("fresh"));

    const r1 = await runTimeoutSweeper();
    expect(r1.swept).toBe(1);
    expect(r1.inspected).toBe(2);

    const entries = readLedger();
    const ignoredEntries = entries.filter(
      (e) => e.type === "engagement" && e.outcome === "ignored",
    );
    expect(ignoredEntries).toHaveLength(1);
    const ig = ignoredEntries[0];
    if (ig.type !== "engagement") throw new Error("type narrowing");
    expect(ig.surface_id).toBe("sid-stale-001");
    expect(ig.source).toBe("timeout_sweep");
    expect(typeof ig.latency_ms).toBe("number");
    expect(ig.latency_ms).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  test("runTimeoutSweeper is idempotent — second run sweeps nothing new", async () => {
    const oldTs = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const fs = await import("node:fs");
    const oldEntry: LedgerEntry = {
      type: "surface_emitted",
      ts: oldTs,
      surface_id: "sid-twice-001",
      surface_type: "telegram_message",
      payload_hash: hashPayload("y"),
    };
    fs.appendFileSync(ledgerPath, JSON.stringify(oldEntry) + "\n");

    const r1 = await runTimeoutSweeper();
    expect(r1.swept).toBe(1);
    const r2 = await runTimeoutSweeper();
    expect(r2.swept).toBe(0);

    // Exactly one ignored entry total.
    const entries = readLedger();
    const ignoredCount = entries.filter(
      (e) => e.type === "engagement" && e.outcome === "ignored",
    ).length;
    expect(ignoredCount).toBe(1);
  });

  test("runTimeoutSweeper handles empty ledger gracefully", async () => {
    const r = await runTimeoutSweeper();
    expect(r.swept).toBe(0);
    expect(r.inspected).toBe(0);
  });

  test("runTimeoutSweeper skips surfaces that already have an outcome", async () => {
    const oldTs = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const fs = await import("node:fs");
    const oldEmit: LedgerEntry = {
      type: "surface_emitted",
      ts: oldTs,
      surface_id: "sid-already-acted",
      surface_type: "plan_approval_request",
      payload_hash: hashPayload("plan"),
    };
    const oldAck: LedgerEntry = {
      type: "engagement",
      ts: new Date(Date.now() - 29 * 60 * 60 * 1000).toISOString(),
      surface_id: "sid-already-acted",
      outcome: "acted",
      source: "plan_approval_decision",
    };
    fs.appendFileSync(
      ledgerPath,
      JSON.stringify(oldEmit) + "\n" + JSON.stringify(oldAck) + "\n",
    );
    const r = await runTimeoutSweeper();
    expect(r.swept).toBe(0);
  });

  test("setLedgerPathForTesting confines writes to the override", () => {
    // The default path lives under SUBCTL_CONFIG_DIR / homedir — verifying
    // by inspection rather than touching the real filesystem.
    expect(getLedgerPath()).toBe(ledgerPath);
    recordSurfaceEmitted("scoped-sid", "chat_response", hashPayload("z"));
    expect(existsSync(ledgerPath)).toBe(true);

    // Reset and check the default path no longer matches the tmp dir.
    setLedgerPathForTesting(null);
    expect(getLedgerPath()).not.toBe(ledgerPath);
    expect(getLedgerPath()).toMatch(/engagement-ledger\.jsonl$/);
  });

  test("makeSurfaceId is deterministic from identical inputs", () => {
    const ts = "2026-05-24T12:00:00.000Z";
    const a = makeSurfaceId("chat_response", "hello world", ts);
    const b = makeSurfaceId("chat_response", "hello world", ts);
    const c = makeSurfaceId("chat_response", "hello WORLD", ts);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  test("makeSurfaceId differs by surface_type", () => {
    const ts = "2026-05-24T12:00:00.000Z";
    const a = makeSurfaceId("chat_response", "same payload", ts);
    const b = makeSurfaceId("telegram_message", "same payload", ts);
    expect(a).not.toBe(b);
  });

  test("hashPayload returns full 64-char sha256 hex", () => {
    const h = hashPayload("hello, world");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPayload("hello, world")).toBe(h);
    expect(hashPayload("HELLO, world")).not.toBe(h);
  });
});
