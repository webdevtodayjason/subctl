// components/evy/backfill.ts
//
// v2.8.10 — operator-invoked memory backfill scripts.
//
// Three independent ingest paths from existing storage substrates into the
// new memory substrates the Memory Initiative landed:
//
//   evy-memory (~/.local/state/subctl/memory/evy.db, Tier 3) → Memori sidecar
//   claude-mem observations (localhost:37701 /api/observations) → Cognee
//   Obsidian vault (~/Documents/Obsidian Vault/Subctl/**/*.md)  → Cognee
//
// Nothing here runs at boot. Each backfill fires ONLY when the operator
// invokes the CLI verb (`subctl memory backfill ...`) or hits the master's
// HTTP endpoint (`POST /memory/backfill/...`). Re-running is idempotent:
// every write embeds a deterministic alphanumeric marker token and the
// script checks for prior ingest via recall before issuing the write.
//
// FTS5 note: SQLite's FTS5 tokenizer splits on punctuation, so a marker
// like `backfill:evy:<uuid>` would fragment and become unreliable as a
// dedupe key. We therefore strip non-alphanum characters and use the
// resulting single token both inside the persisted content AND as the
// recall query — guaranteeing a single match per source id.

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  capture as defaultMemoriCapture,
  recall as defaultMemoriRecall,
  health as defaultMemoriHealth,
} from "./memori-client";
import {
  remember as defaultCogneeRemember,
  recall as defaultCogneeRecall,
  health as defaultCogneeHealth,
} from "./cognee-client";
import { getMemoryDbPath, type MemoryEntry, type MemoryRole } from "./memory";

// ─── public types ─────────────────────────────────────────────────────────

export interface BackfillDetail {
  source_id: string;
  action: "written" | "skipped" | "errored";
  reason?: string;
}

export interface BackfillResult {
  ok: boolean;
  planned: number;
  written: number;
  skipped: number;
  errors: number;
  error?: string;
  details?: BackfillDetail[];
}

/** Loose shape — the claude-mem HTTP surface has varied across versions. */
export interface ClaudeMemObservation {
  id: string | number;
  content?: string;
  text?: string;
  summary?: string;
  ts?: string;
  created_at?: string;
  [key: string]: unknown;
}

// ─── injectable side-effect surface (for tests) ───────────────────────────

export interface BackfillDeps {
  memoriCapture: typeof defaultMemoriCapture;
  memoriRecall: typeof defaultMemoriRecall;
  memoriHealth: typeof defaultMemoriHealth;
  cogneeRemember: typeof defaultCogneeRemember;
  cogneeRecall: typeof defaultCogneeRecall;
  cogneeHealth: typeof defaultCogneeHealth;
  /** Read the entire evy-memory DB (no 200 cap — backfill needs everything). */
  readEvyEntries: (opts: { limit: number }) => MemoryEntry[];
  /** One page of claude-mem observations. */
  fetchClaudeMemPage: (opts: { limit: number; offset: number }) => Promise<{
    observations: ClaudeMemObservation[];
    total?: number;
  }>;
  /** Walk the Obsidian vault, return absolute *.md paths. */
  listObsidianFiles: (vaultPath: string) => Promise<string[]>;
  /** Read a single Obsidian markdown file. */
  readObsidianFile: (path: string) => Promise<string>;
  now: () => string;
}

const DEFAULT_VAULT_PATH = join(
  homedir(),
  "Documents",
  "Obsidian Vault",
  "Subctl",
);

const CLAUDE_MEM_BASE =
  process.env.CLAUDE_MEM_URL?.replace(/\/+$/, "") ?? "http://localhost:37701";
const CLAUDE_MEM_PAGE_SIZE = 500;
/** Safety cap so a runaway loop doesn't pull a million rows. 100 × 500 = 50k. */
const CLAUDE_MEM_MAX_PAGES = 100;

// ─── default impls ────────────────────────────────────────────────────────

function defaultReadEvyEntries(opts: { limit: number }): MemoryEntry[] {
  const path = getMemoryDbPath();
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    const limit = Math.max(1, Math.min(1_000_000, opts.limit));
    const rows = db
      .prepare(
        `SELECT id, ts, team_id, role, kind, content, metadata_json
         FROM entries
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      ts: string;
      team_id: string | null;
      role: string;
      kind: string;
      content: string;
      metadata_json: string | null;
    }>;
    return rows.map((r): MemoryEntry => {
      let metadata: Record<string, unknown> | undefined;
      if (r.metadata_json) {
        try {
          metadata = JSON.parse(r.metadata_json) as Record<string, unknown>;
        } catch {
          metadata = { _malformed: true };
        }
      }
      return {
        id: r.id,
        ts: r.ts,
        team_id: r.team_id,
        role: r.role as MemoryRole,
        kind: r.kind,
        content: r.content,
        metadata,
      };
    });
  } finally {
    db.close();
  }
}

async function defaultFetchClaudeMemPage(opts: {
  limit: number;
  offset: number;
}): Promise<{ observations: ClaudeMemObservation[]; total?: number }> {
  const url = `${CLAUDE_MEM_BASE}/api/observations?limit=${opts.limit}&offset=${opts.offset}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) {
    throw new Error(`claude-mem HTTP ${r.status} ${r.statusText}`);
  }
  const j = (await r.json()) as
    | { observations?: ClaudeMemObservation[]; total?: number }
    | ClaudeMemObservation[];
  if (Array.isArray(j)) return { observations: j };
  return { observations: j.observations ?? [], total: j.total };
}

async function defaultListObsidianFiles(vaultPath: string): Promise<string[]> {
  if (!existsSync(vaultPath)) return [];
  const out: string[] = [];
  const stack: string[] = [vaultPath];
  while (stack.length) {
    const dir = stack.pop()!;
    let listing: Awaited<ReturnType<typeof readdir>>;
    try {
      listing = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of listing) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md"))
        out.push(full);
    }
  }
  return out.sort();
}

async function defaultReadObsidianFile(path: string): Promise<string> {
  // Sync read is fine — vault files are small markdown, and the backfill
  // runs explicitly under operator control (not on a hot path).
  return readFileSync(path, "utf8");
}

const realDeps: BackfillDeps = {
  memoriCapture: defaultMemoriCapture,
  memoriRecall: defaultMemoriRecall,
  memoriHealth: defaultMemoriHealth,
  cogneeRemember: defaultCogneeRemember,
  cogneeRecall: defaultCogneeRecall,
  cogneeHealth: defaultCogneeHealth,
  readEvyEntries: defaultReadEvyEntries,
  fetchClaudeMemPage: defaultFetchClaudeMemPage,
  listObsidianFiles: defaultListObsidianFiles,
  readObsidianFile: defaultReadObsidianFile,
  now: () => new Date().toISOString(),
};

let deps: BackfillDeps = realDeps;

export function _setDepsForTesting(partial: Partial<BackfillDeps>): void {
  deps = { ...realDeps, ...partial };
}

export function _resetDepsForTesting(): void {
  deps = realDeps;
}

// ─── marker helpers ───────────────────────────────────────────────────────

/**
 * Build a deterministic FTS5-safe marker token. Stripping non-alphanum
 * keeps the token from fragmenting under the default FTS5 tokenizer so a
 * later `recall({query: marker})` reliably returns the prior ingest.
 *
 * Lowercased to dodge accidental case-mismatch (FTS5 in default unicode61
 * config is case-insensitive, but defensive lowercasing matches the rest
 * of memory.ts buildFts5Match).
 */
function markerToken(prefix: string, sourceId: string): string {
  const clean = String(sourceId).replace(/[^a-zA-Z0-9]/g, "");
  return `${prefix}${clean}`.toLowerCase();
}

// ─── backfill 1: evy-memory → Memori ──────────────────────────────────────

export async function backfillEvyMemoryToMemori(
  opts: { dryRun?: boolean; limit?: number; entity_id?: string } = {},
): Promise<BackfillResult> {
  const entity_id = (opts.entity_id ?? "operator").toLowerCase();
  const limit = opts.limit ?? 99_999;
  const dryRun = opts.dryRun ?? false;

  // Health first. Dry-run still probes — surfacing an unreachable sidecar
  // in dry mode is more useful than counting "planned" against a dead
  // target the operator will then watch fail in real mode.
  const h = await deps.memoriHealth();
  if (!h.reachable) {
    return {
      ok: false,
      planned: 0,
      written: 0,
      skipped: 0,
      errors: 0,
      error: `Memori unreachable at ${h.url}: ${h.error ?? "unknown"}`,
    };
  }

  let entries: MemoryEntry[];
  try {
    entries = deps.readEvyEntries({ limit });
  } catch (err) {
    return {
      ok: false,
      planned: 0,
      written: 0,
      skipped: 0,
      errors: 0,
      error: `failed to read evy.db: ${(err as Error).message}`,
    };
  }

  const details: BackfillDetail[] = [];
  let written = 0;
  let skipped = 0;
  let errors = 0;

  for (const e of entries) {
    const marker = markerToken("bfillevy", e.id);
    try {
      const existing = await deps.memoriRecall({
        entity_id,
        query: marker,
        top_k: 1,
      });
      if (existing.ok && existing.data.hits.length > 0) {
        skipped += 1;
        details.push({
          source_id: e.id,
          action: "skipped",
          reason: "already-ingested",
        });
        continue;
      }
      if (dryRun) {
        skipped += 1;
        details.push({
          source_id: e.id,
          action: "skipped",
          reason: "dry-run",
        });
        continue;
      }
      // Embed the marker inside the persisted text so the FTS index has it
      // alongside the original content. Role-aware placement: a 'user'
      // entry feeds user_text, everything else feeds assistant_text so we
      // don't misattribute. The marker is a single alphanum token so FTS
      // sees it cleanly regardless of which field it lands in.
      const tagged = `${marker} ${e.content}`;
      const isUser = e.role === "user";
      const cap = await deps.memoriCapture({
        entity_id,
        process_id: "subctl-backfill-evy",
        turn: {
          user_text: isUser ? tagged : undefined,
          assistant_text: isUser ? undefined : tagged,
        },
        metadata: {
          backfill_source: "evy-memory",
          backfill_source_id: e.id,
          backfill_marker: marker,
          original_kind: e.kind,
          original_role: e.role,
          original_team_id: e.team_id ?? null,
          original_ts: e.ts,
          ...(e.metadata ? { original_metadata: e.metadata } : {}),
        },
        ts: e.ts,
      });
      if (!cap.ok) {
        errors += 1;
        details.push({
          source_id: e.id,
          action: "errored",
          reason: cap.error,
        });
        continue;
      }
      written += 1;
      details.push({ source_id: e.id, action: "written" });
    } catch (err) {
      errors += 1;
      details.push({
        source_id: e.id,
        action: "errored",
        reason: (err as Error).message,
      });
    }
  }

  return {
    ok: true,
    planned: entries.length,
    written,
    skipped,
    errors,
    details,
  };
}

// ─── backfill 2: claude-mem → Cognee ──────────────────────────────────────

export async function backfillClaudeMemToCognee(
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<BackfillResult> {
  const dryRun = opts.dryRun ?? false;
  const totalCap = Math.max(1, opts.limit ?? 50_000);

  const h = await deps.cogneeHealth();
  if (!h.reachable) {
    return {
      ok: false,
      planned: 0,
      written: 0,
      skipped: 0,
      errors: 0,
      error: `Cognee unreachable at ${h.url}: ${h.error ?? "unknown"}`,
    };
  }

  const details: BackfillDetail[] = [];
  let written = 0;
  let skipped = 0;
  let errors = 0;
  let planned = 0;

  let offset = 0;
  let pageCount = 0;
  let exhausted = false;

  while (!exhausted && planned < totalCap && pageCount < CLAUDE_MEM_MAX_PAGES) {
    pageCount += 1;
    const pageSize = Math.min(CLAUDE_MEM_PAGE_SIZE, totalCap - planned);
    let page: { observations: ClaudeMemObservation[]; total?: number };
    try {
      page = await deps.fetchClaudeMemPage({ limit: pageSize, offset });
    } catch (err) {
      // Upstream gone mid-run — return partial result with a clean error.
      return {
        ok: false,
        planned,
        written,
        skipped,
        errors,
        details,
        error: `claude-mem fetch failed: ${(err as Error).message}`,
      };
    }
    const obs = page.observations ?? [];
    if (obs.length === 0) break;
    for (const o of obs) {
      planned += 1;
      const sourceId = String(o.id);
      const marker = markerToken("bfillclaude", sourceId);
      const text = String(o.content ?? o.text ?? o.summary ?? "");
      try {
        const existing = await deps.cogneeRecall({ query: marker, top_k: 1 });
        if (existing.ok && existing.data.hits.length > 0) {
          skipped += 1;
          details.push({
            source_id: sourceId,
            action: "skipped",
            reason: "already-ingested",
          });
          continue;
        }
        if (dryRun) {
          skipped += 1;
          details.push({
            source_id: sourceId,
            action: "skipped",
            reason: "dry-run",
          });
          continue;
        }
        const tagged = `${marker} ${text}`;
        const r = await deps.cogneeRemember({
          text: tagged,
          metadata: {
            source: "claude-mem",
            source_id: sourceId,
            backfill_marker: marker,
            ingested_at: deps.now(),
            ...(o.ts || o.created_at
              ? { original_ts: o.ts ?? o.created_at }
              : {}),
          },
        });
        if (!r.ok) {
          errors += 1;
          details.push({
            source_id: sourceId,
            action: "errored",
            reason: r.error,
          });
          continue;
        }
        written += 1;
        details.push({ source_id: sourceId, action: "written" });
      } catch (err) {
        errors += 1;
        details.push({
          source_id: sourceId,
          action: "errored",
          reason: (err as Error).message,
        });
      }
    }
    offset += obs.length;
    if (obs.length < pageSize) exhausted = true;
  }

  return {
    ok: true,
    planned,
    written,
    skipped,
    errors,
    details,
  };
}

// ─── backfill 3: Obsidian vault → Cognee ──────────────────────────────────

export async function backfillObsidianToCognee(
  opts: { dryRun?: boolean; vault_path?: string } = {},
): Promise<BackfillResult> {
  const dryRun = opts.dryRun ?? false;
  const vaultPath = opts.vault_path ?? DEFAULT_VAULT_PATH;

  const h = await deps.cogneeHealth();
  if (!h.reachable) {
    return {
      ok: false,
      planned: 0,
      written: 0,
      skipped: 0,
      errors: 0,
      error: `Cognee unreachable at ${h.url}: ${h.error ?? "unknown"}`,
    };
  }

  let files: string[];
  try {
    files = await deps.listObsidianFiles(vaultPath);
  } catch (err) {
    return {
      ok: false,
      planned: 0,
      written: 0,
      skipped: 0,
      errors: 0,
      error: `failed to walk vault ${vaultPath}: ${(err as Error).message}`,
    };
  }

  const details: BackfillDetail[] = [];
  let written = 0;
  let skipped = 0;
  let errors = 0;

  for (const filePath of files) {
    const sourceId = filePath;
    const marker = markerToken("bfillobs", filePath);
    try {
      const existing = await deps.cogneeRecall({ query: marker, top_k: 1 });
      if (existing.ok && existing.data.hits.length > 0) {
        skipped += 1;
        details.push({
          source_id: sourceId,
          action: "skipped",
          reason: "already-ingested",
        });
        continue;
      }
      if (dryRun) {
        skipped += 1;
        details.push({
          source_id: sourceId,
          action: "skipped",
          reason: "dry-run",
        });
        continue;
      }
      const content = await deps.readObsidianFile(filePath);
      const tagged = `${marker} ${content}`;
      const r = await deps.cogneeRemember({
        text: tagged,
        metadata: {
          source: "obsidian",
          source_id: sourceId,
          backfill_marker: marker,
          ingested_at: deps.now(),
          bytes: content.length,
        },
      });
      if (!r.ok) {
        errors += 1;
        details.push({
          source_id: sourceId,
          action: "errored",
          reason: r.error,
        });
        continue;
      }
      written += 1;
      details.push({ source_id: sourceId, action: "written" });
    } catch (err) {
      errors += 1;
      details.push({
        source_id: sourceId,
        action: "errored",
        reason: (err as Error).message,
      });
    }
  }

  return {
    ok: true,
    planned: files.length,
    written,
    skipped,
    errors,
    details,
  };
}
