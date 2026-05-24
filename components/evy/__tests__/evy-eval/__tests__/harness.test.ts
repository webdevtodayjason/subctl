// components/master/__tests__/evy-eval/__tests__/harness.test.ts
//
// Tests for the harness layer: session driver (stubbed in pr24),
// baseline hashing, score logging, run summary.
//
// Strategy:
//   - Pin SUBCTL_CONFIG_DIR to a per-test tmpdir so reads of
//     providers.json and writes to eval-scores.jsonl don't touch the
//     operator's real state.
//   - For the baseline-hash determinism tests we just call the
//     functions twice and assert equal output — the inputs (SKILL.md,
//     evy.toml, providers.json) all route through the test tmpdir,
//     so we can stage them deterministically.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _harnessForTesting,
  computeFullBaselineHash,
  computePartialBaselineHash,
  getBaselineComponents,
  getEvyModelId,
  getEvyTemperature,
  getJudgeModelId,
  logEvalScore,
  runEvySession,
  summarizeRunResults,
} from "../harness";
import type { EvalScoreLogEntry } from "../types";

// ─── env save/restore ──────────────────────────────────────────────────────

let savedConfigDir: string | undefined;
let tmp: string;

beforeEach(() => {
  savedConfigDir = process.env.SUBCTL_CONFIG_DIR;
  tmp = mkdtempSync(join(tmpdir(), "evy-eval-harness-"));
  process.env.SUBCTL_CONFIG_DIR = tmp;
  // Pre-stage a providers.json with a known supervisor model so
  // getEvyModelId returns a deterministic value.
  mkdirSync(join(tmp, "master"), { recursive: true });
  writeFileSync(
    join(tmp, "master", "providers.json"),
    JSON.stringify({
      models: { supervisor: { provider: "test-prov", model: "test-model" } },
    }),
  );
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.SUBCTL_CONFIG_DIR;
  else process.env.SUBCTL_CONFIG_DIR = savedConfigDir;

  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ─── runEvySession (stub) ──────────────────────────────────────────────────

describe("runEvySession (stub)", () => {
  test("empty operator turns → empty turns array, metadata populated", async () => {
    const session = await runEvySession([]);
    expect(session.turns).toEqual([]);
    expect(session.evyModelId).toBe("test-prov:test-model");
    expect(session.evyTemperature).toBe(0.2);
    expect(typeof session.baselineHash).toBe("string");
    expect(session.baselineHash).toHaveLength(16);
    expect(session.baselineComponents).toBeDefined();
  });

  test("one operator turn → operator + evy stub pair", async () => {
    const session = await runEvySession(["hi"]);
    expect(session.turns).toHaveLength(2);
    expect(session.turns[0]).toEqual({ role: "operator", content: "hi" });
    expect(session.turns[1].role).toBe("evy");
    expect(session.turns[1].content).toBe(
      _harnessForTesting.EVY_STUB_PLACEHOLDER,
    );
  });

  test("three operator turns → alternating 6-turn transcript", async () => {
    const session = await runEvySession(["a", "b", "c"]);
    expect(session.turns.map((t) => t.role)).toEqual([
      "operator",
      "evy",
      "operator",
      "evy",
      "operator",
      "evy",
    ]);
  });
});

// ─── Baseline hashing ──────────────────────────────────────────────────────

describe("computePartialBaselineHash", () => {
  test("returns a 16-char hex string", () => {
    const hash = computePartialBaselineHash();
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("matches across two calls with identical inputs", () => {
    const a = computePartialBaselineHash();
    const b = computePartialBaselineHash();
    expect(a).toBe(b);
  });

  test("differs when providers.json supervisor model changes", () => {
    const a = computePartialBaselineHash();
    writeFileSync(
      join(tmp, "master", "providers.json"),
      JSON.stringify({
        models: { supervisor: { provider: "test-prov", model: "DIFFERENT" } },
      }),
    );
    const b = computePartialBaselineHash();
    expect(a).not.toBe(b);
  });
});

describe("computeFullBaselineHash", () => {
  test("differs when the judge prompt differs", () => {
    const a = computeFullBaselineHash("prompt one");
    const b = computeFullBaselineHash("prompt two");
    expect(a).not.toBe(b);
  });

  test("same prompt → same hash (deterministic)", () => {
    const a = computeFullBaselineHash("the same prompt");
    const b = computeFullBaselineHash("the same prompt");
    expect(a).toBe(b);
  });
});

describe("getBaselineComponents", () => {
  test("returns all 5 named fields", () => {
    const c = getBaselineComponents("some judge prompt");
    expect(Object.keys(c).sort()).toEqual([
      "evy_model_id",
      "evy_toml",
      "judge_model_id",
      "judge_prompt",
      "skill_md",
    ]);
    expect(c.evy_model_id).toBe("test-prov:test-model");
    expect(c.judge_model_id).toBe("claude-sonnet-4-5-20250929");
    expect(c.judge_prompt).toMatch(/^[0-9a-f]{16}$/);
    expect(c.skill_md).toMatch(/^[0-9a-f]{16}$/);
    expect(c.evy_toml).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ─── Helper accessors ──────────────────────────────────────────────────────

describe("getEvyModelId", () => {
  test("reads providers.json models.supervisor", () => {
    expect(getEvyModelId()).toBe("test-prov:test-model");
  });

  test("returns 'unknown:unknown' when providers.json missing", () => {
    rmSync(join(tmp, "master", "providers.json"));
    expect(getEvyModelId()).toBe("unknown:unknown");
  });

  test("returns 'unknown:unknown' on malformed providers.json", () => {
    writeFileSync(join(tmp, "master", "providers.json"), "not json");
    expect(getEvyModelId()).toBe("unknown:unknown");
  });
});

describe("getEvyTemperature / getJudgeModelId", () => {
  test("evy temperature is 0.2 (operator recommendation)", () => {
    expect(getEvyTemperature()).toBe(0.2);
  });

  test("judge model id is pinned Sonnet", () => {
    expect(getJudgeModelId()).toBe("claude-sonnet-4-5-20250929");
  });
});

// ─── logEvalScore ──────────────────────────────────────────────────────────

describe("logEvalScore", () => {
  function sampleEntry(overrides?: Partial<EvalScoreLogEntry>): EvalScoreLogEntry {
    return {
      ts: "2026-05-12T00:00:00.000Z",
      test_id: "1.2",
      result: "pass",
      baselineHash: "abcdef0123456789",
      baselineComponents: getBaselineComponents("some prompt"),
      evyModelId: "test-prov:test-model",
      responseExcerpt: "Routing now.",
      ...overrides,
    };
  }

  test("creates the parent directory on first call", () => {
    const path = join(tmp, "master", "state", "eval-scores.jsonl");
    expect(existsSync(path)).toBe(false);
    logEvalScore(sampleEntry());
    expect(existsSync(path)).toBe(true);
  });

  test("appends one JSON line per call", () => {
    logEvalScore(sampleEntry({ test_id: "1.1" }));
    logEvalScore(sampleEntry({ test_id: "1.2" }));
    logEvalScore(sampleEntry({ test_id: "1.3" }));

    const path = join(tmp, "master", "state", "eval-scores.jsonl");
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      const parsed = JSON.parse(l) as EvalScoreLogEntry;
      expect(parsed.test_id).toMatch(/^1\.[123]$/);
    }
  });

  test("survives empty optional fields", () => {
    // No fastFailHit, no judgeResult — should still write a valid line.
    logEvalScore(sampleEntry({ result: "regex-only-pass" }));
    const path = join(tmp, "master", "state", "eval-scores.jsonl");
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw.trim()) as EvalScoreLogEntry;
    expect(parsed.result).toBe("regex-only-pass");
    expect(parsed.fastFailHit).toBeUndefined();
    expect(parsed.judgeResult).toBeUndefined();
  });
});

// ─── summarizeRunResults ───────────────────────────────────────────────────

describe("summarizeRunResults", () => {
  function entry(result: EvalScoreLogEntry["result"]): EvalScoreLogEntry {
    return {
      ts: "2026-05-12T00:00:00.000Z",
      test_id: "1.1",
      result,
      baselineHash: "abcdef0123456789",
      baselineComponents: getBaselineComponents("p"),
      evyModelId: "test-prov:test-model",
      responseExcerpt: "...",
    };
  }

  test("empty entries → all zeros", () => {
    expect(summarizeRunResults([])).toEqual({
      total: 0,
      pass: 0,
      fail: 0,
      regex_only_pass: 0,
      full_pass: 0,
    });
  });

  test("counts mixed results correctly", () => {
    const entries: EvalScoreLogEntry[] = [
      entry("pass"),
      entry("pass"),
      entry("fail"),
      entry("regex-only-pass"),
      entry("regex-only-pass"),
      entry("regex-only-pass"),
    ];
    const s = summarizeRunResults(entries);
    expect(s.total).toBe(6);
    expect(s.pass).toBe(5); // 2 full + 3 regex-only
    expect(s.fail).toBe(1);
    expect(s.full_pass).toBe(2);
    expect(s.regex_only_pass).toBe(3);
  });

  test("full_pass + regex_only_pass == pass (invariant)", () => {
    const entries: EvalScoreLogEntry[] = [
      entry("pass"),
      entry("regex-only-pass"),
      entry("regex-only-pass"),
      entry("fail"),
    ];
    const s = summarizeRunResults(entries);
    expect(s.full_pass + s.regex_only_pass).toBe(s.pass);
    expect(s.pass + s.fail).toBe(s.total);
  });
});
