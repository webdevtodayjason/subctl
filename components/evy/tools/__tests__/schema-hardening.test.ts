// components/evy/tools/__tests__/schema-hardening.test.ts
//
// Schema-hardening tests for v2.7.15. Three tools gained required
// confirmation/provenance fields that the runtime enforces in the
// invoke() body so an absent or invalid value fails CLEANLY rather
// than letting a destructive / un-attributable call through:
//
//   - memory_remember: requires `source_type` (enum)
//   - memory_forget:   requires `confirmation: true`
//   - subctl_orch_kill: requires `confirmation: true` + `reason` (≥10 chars)
//
// These tests exercise the tool's invoke() directly (no daemon
// running). They confirm: (a) missing fields are rejected with a
// useful error, (b) wrong-type/short fields are rejected, (c) valid
// calls proceed to the underlying action.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tier1MemoryTools } from "../tier1-memory";
import { subctlOrchTools } from "../subctl-orch";

// ─── env save/restore ──────────────────────────────────────────────────────

let savedConfigDir: string | undefined;
let savedApiBase: string | undefined;
let savedMemoryPathEnv: string | undefined;
let tmp: string;

beforeEach(() => {
  // tier1-memory.ts hardcodes ~/.config/subctl/evy/memory.md at module
  // load time (it reads homedir() once). To get test isolation we cannot
  // re-route via env, but we CAN poke the actual file directly through
  // memory_remember + memory_forget — they read + write the same path,
  // so the test set self-cancels. Each test cleans up after itself.
  savedConfigDir = process.env.SUBCTL_CONFIG_DIR;
  savedMemoryPathEnv = process.env.SUBCTL_MEMORY_LIMIT;
  savedApiBase = process.env.SUBCTL_API;
  tmp = mkdtempSync(join(tmpdir(), "schema-harden-"));
  // Point the orchestration tools' apiPost at a URL that won't accept
  // — we expect the validation guards to refuse BEFORE the network call,
  // so the test never reaches the fetch.
  process.env.SUBCTL_API = "http://127.0.0.1:1"; // closed port
});

afterEach(() => {
  if (savedConfigDir === undefined) {
    delete process.env.SUBCTL_CONFIG_DIR;
  } else {
    process.env.SUBCTL_CONFIG_DIR = savedConfigDir;
  }
  if (savedMemoryPathEnv === undefined) {
    delete process.env.SUBCTL_MEMORY_LIMIT;
  } else {
    process.env.SUBCTL_MEMORY_LIMIT = savedMemoryPathEnv;
  }
  if (savedApiBase === undefined) {
    delete process.env.SUBCTL_API;
  } else {
    process.env.SUBCTL_API = savedApiBase;
  }
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

// ─── memory_remember.source_type ──────────────────────────────────────────

describe("memory_remember — source_type required", () => {
  test("schema declares source_type as required", () => {
    const schema = tier1MemoryTools.memory_remember.schema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toContain("source_type");
    expect(schema.properties.source_type).toBeDefined();
  });

  test("rejects when source_type is missing", async () => {
    const result = (await tier1MemoryTools.memory_remember.invoke({
      text: "Test fact about something durable.",
    } as { text: string; source_type?: string })) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("source_type");
  });

  test("rejects when source_type is not in the enum", async () => {
    const result = (await tier1MemoryTools.memory_remember.invoke({
      text: "Another fact.",
      source_type: "guessing-wildly",
    })) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("source_type");
  });

  test("accepts a valid source_type", async () => {
    // The base homedir's memory.md may already contain entries; we just
    // check this call doesn't reject on schema grounds. It may fail on
    // char-limit if memory.md is large, in which case we still get a
    // structured response with ok:false but a DIFFERENT error message
    // (about the char limit, not about source_type).
    const result = (await tier1MemoryTools.memory_remember.invoke({
      text:
        "[schema-test] this entry was added by the v2.7.15 schema-hardening test and should be removable.",
      source_type: "self-inferred",
    })) as { ok: boolean; error?: string; appended_index?: number };
    if (result.ok) {
      // Clean up — find and remove the entry we just appended.
      if (typeof result.appended_index === "number") {
        await tier1MemoryTools.memory_forget.invoke({
          index: result.appended_index,
          confirmation: true,
        });
      }
    } else {
      // Acceptable: char-limit overflow. Just make sure the error is not
      // about source_type — the schema guard passed.
      expect(result.error ?? "").not.toContain("source_type");
    }
  });
});

// ─── memory_forget.confirmation ───────────────────────────────────────────

describe("memory_forget — confirmation required", () => {
  test("schema declares confirmation as required", () => {
    const schema = tier1MemoryTools.memory_forget.schema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toContain("confirmation");
    expect(schema.properties.confirmation).toBeDefined();
  });

  test("rejects when confirmation is missing", async () => {
    const result = (await tier1MemoryTools.memory_forget.invoke({
      index: 0,
    } as { index: number; confirmation?: boolean })) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("confirmation: true");
  });

  test("rejects when confirmation is false", async () => {
    const result = (await tier1MemoryTools.memory_forget.invoke({
      index: 0,
      confirmation: false,
    })) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("confirmation: true");
  });

  test("rejects when confirmation is a string (truthy but not true)", async () => {
    const result = (await tier1MemoryTools.memory_forget.invoke({
      index: 0,
      // @ts-expect-error — schema is `boolean`; this test confirms the
      // runtime check is on === true, not on truthy.
      confirmation: "yes",
    })) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("confirmation: true");
  });
});

// ─── subctl_orch_kill.confirmation + reason ───────────────────────────────

describe("subctl_orch_kill — confirmation + reason required", () => {
  test("schema declares confirmation and reason as required", () => {
    const schema = subctlOrchTools.kill.schema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toContain("confirmation");
    expect(schema.required).toContain("reason");
    expect(schema.properties.confirmation).toBeDefined();
    expect(schema.properties.reason).toBeDefined();
  });

  test("rejects when confirmation is missing", async () => {
    const result = (await subctlOrchTools.kill.invoke({
      name: "test-team",
      reason: "long enough reason string here",
    } as { name: string; confirmation?: boolean; reason?: string })) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("confirmation: true");
  });

  test("rejects when confirmation is not literally true", async () => {
    const result = (await subctlOrchTools.kill.invoke({
      name: "test-team",
      // @ts-expect-error — testing runtime guard against truthy non-true.
      confirmation: 1,
      reason: "long enough reason string here",
    })) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("confirmation: true");
  });

  test("rejects when reason is missing", async () => {
    const result = (await subctlOrchTools.kill.invoke({
      name: "test-team",
      confirmation: true,
    } as { name: string; confirmation: boolean; reason?: string })) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toMatch(/reason/);
  });

  test("rejects when reason is shorter than 10 chars", async () => {
    const result = (await subctlOrchTools.kill.invoke({
      name: "test-team",
      confirmation: true,
      reason: "short",
    })) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("10 chars");
  });

  test("rejects when reason is whitespace-only", async () => {
    const result = (await subctlOrchTools.kill.invoke({
      name: "test-team",
      confirmation: true,
      reason: "          ",
    })) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("10 chars");
  });

  test("passes guards on valid call (then errors on network at fetch — confirms guards passed)", async () => {
    // The guards pass, then apiPost tries to hit SUBCTL_API which is
    // pointed at a closed port. We expect a network-level throw, NOT a
    // structured {ok:false, error: "confirmation: true"} response.
    let threw = false;
    let structuredErrorAboutGuards = false;
    try {
      const result = (await subctlOrchTools.kill.invoke({
        name: "test-team",
        confirmation: true,
        reason: "schema-hardening test — guards must pass before network call",
      })) as { ok?: boolean; error?: string };
      if (result.ok === false && (result.error ?? "").includes("confirmation")) {
        structuredErrorAboutGuards = true;
      }
    } catch {
      threw = true;
    }
    // EITHER a fetch error was thrown (closed port) OR we got a structured
    // response that does NOT mention the guards. Both prove the guards passed.
    expect(threw || !structuredErrorAboutGuards).toBe(true);
  });
});
