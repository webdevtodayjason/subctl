// dashboard/lib/audit-api.ts
//
// PR 11 (v2.7.0): pure request handlers for the dashboard's policy-audit
// surface. Lives in its own module so it's exercise-able by bun:test without
// booting the whole HTTP server.
//
// Surface (per pack 09 §6):
//   GET /api/audit/<team_id>?tail=N&since=DURATION&decision=allow|deny&filter=RULE_PATH
//   GET /api/audit/<team_id>/stream                  ← SSE; built in server.ts (uses file watcher)
//   GET /api/audit/aggregate?since=DURATION&top=N    ← cross-team grouping for the Policy tab
//   GET /api/policy/list?project_root=<dir>          ← `subctl policy list --json` for the Policy tab
//   GET /api/policy/teams                            ← per-team mode/preset/allowlist_sha (live)
//
// Path resolution honors SUBCTL_STATE_DIR per components/master/tools/policy/audit.ts
// and snapshot.ts conventions.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AuditEntry, Mode } from "../../lib/policy/types";

// ---------------------------------------------------------------------------
// Path resolution — must match audit.ts + snapshot.ts. Resolved per-call (not
// cached) so SUBCTL_STATE_DIR can be flipped per test run.
// ---------------------------------------------------------------------------

export function resolveStateDir(): string {
  const override = process.env.SUBCTL_STATE_DIR;
  return override ?? join(homedir(), ".local", "state", "subctl");
}

export function getAuditDir(): string {
  return join(resolveStateDir(), "audit");
}

export function getTeamsDir(): string {
  return join(resolveStateDir(), "teams");
}

export function getAuditPath(teamId: string): string {
  return join(getAuditDir(), `${teamId}.jsonl`);
}

export function getSnapshotPath(teamId: string): string {
  return join(getTeamsDir(), teamId, "policy.snapshot.toml");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const TEAM_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isValidTeamId(teamId: string): boolean {
  return TEAM_ID_RE.test(teamId) && teamId.length > 0 && teamId.length <= 128;
}

/**
 * Parse a duration like "1h", "30m", "10s", "200ms". Returns the duration in
 * milliseconds, or null if the input is malformed. Empty/null → null.
 */
export function parseSinceDuration(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2]!.toLowerCase();
  switch (unit) {
    case "ms": return n;
    case "s":  return n * 1000;
    case "m":  return n * 60 * 1000;
    case "h":  return n * 60 * 60 * 1000;
    case "d":  return n * 24 * 60 * 60 * 1000;
    default:   return null;
  }
}

// ---------------------------------------------------------------------------
// JSONL reader — robust to torn lines, missing files
// ---------------------------------------------------------------------------

/**
 * Read a team's audit JSONL, optionally also reading the rotated `.1/.2/.3`
 * generations if we need more entries than fit in the active log. Returns
 * entries in file order (chronological) — the caller reverses for "most-recent
 * first". Malformed lines are skipped silently per pack 09 §4 — a torn final
 * line from a crashed worker shouldn't break a tail.
 *
 * `maxScan` is a soft cap on how many entries we'll read across all rotations
 * combined; we stop early once we have enough. This is the only reason we
 * touch rotated files at all — if `tail=1000` and the active log only has 200
 * entries, we'll need to look at `.1`.
 */
export function readAuditEntries(teamId: string, maxScan: number): AuditEntry[] {
  const entries: AuditEntry[] = [];
  const active = getAuditPath(teamId);

  // Walk in newest-first file order (active, then .1, .2, .3), but inside each
  // file we still read in chronological order. The caller takes a tail slice
  // off the concatenated result, so we want chronological-across-files: oldest
  // first means we should walk .3 → .2 → .1 → active. But that re-reads the
  // older logs for what's usually just a small tail. Practical shortcut: read
  // active first (the common path; usually has plenty), only descend into
  // rotations when active is light. Newer files get pushed first; we sort by
  // ts after parse.
  const files = [active, `${active}.1`, `${active}.2`, `${active}.3`];

  for (const path of files) {
    if (entries.length >= maxScan) break;
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as AuditEntry;
        if (typeof obj.ts !== "string" || typeof obj.team_id !== "string") continue;
        entries.push(obj);
      } catch {
        // Torn line — skip.
      }
    }
  }

  // Sort by ts (lexicographic works for ISO 8601), oldest → newest.
  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return entries;
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

export interface AuditQuery {
  tail: number;          // capped 1..1000
  sinceMs: number | null;
  decision: "allow" | "deny" | null;
  filter: string | null; // case-insensitive substring on rule_path or rule
  eventType: AuditEntry["event_type"] | null;
}

export function parseQuery(search: URLSearchParams): AuditQuery {
  const tailRaw = Number(search.get("tail") ?? "100");
  const tail = Math.max(1, Math.min(1000, Number.isFinite(tailRaw) ? Math.floor(tailRaw) : 100));
  const sinceMs = parseSinceDuration(search.get("since"));
  const decRaw = search.get("decision");
  const decision = decRaw === "allow" || decRaw === "deny" ? decRaw : null;
  const filter = search.get("filter")?.toLowerCase() || null;
  const evRaw = search.get("event_type");
  const eventType =
    evRaw === "check" || evRaw === "header" || evRaw === "verifier_correction"
      ? evRaw
      : null;
  return { tail, sinceMs, decision, filter, eventType };
}

export function applyFilter(entries: AuditEntry[], q: AuditQuery, nowMs: number): AuditEntry[] {
  const cutoffMs = q.sinceMs == null ? null : nowMs - q.sinceMs;
  const filterLc = q.filter;
  const out: AuditEntry[] = [];
  for (const e of entries) {
    if (q.decision && e.decision !== q.decision) continue;
    if (q.eventType && e.event_type !== q.eventType) continue;
    if (cutoffMs != null) {
      const t = Date.parse(e.ts);
      if (!Number.isFinite(t) || t < cutoffMs) continue;
    }
    if (filterLc) {
      const rp = (e.rule_path ?? "").toLowerCase();
      const r = (e.rule ?? "").toLowerCase();
      const cmd = (e.command ?? "").toLowerCase();
      if (!rp.includes(filterLc) && !r.includes(filterLc) && !cmd.includes(filterLc)) continue;
    }
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handler — pure function returning a `Response`. server.ts calls this.
// ---------------------------------------------------------------------------

export interface AuditApiResult {
  ok: true;
  team_id: string;
  count: number;
  total: number;
  entries: AuditEntry[];
}

/**
 * GET /api/audit/<team_id>
 *
 * Returns { ok: true, entries: [...], count, total } with `count` being the
 * number of entries returned (≤ tail) and `total` being the number that
 * matched the filter (so the UI can say "showing 50 of 137").
 */
export function handleAuditList(teamId: string, search: URLSearchParams): Response {
  if (!isValidTeamId(teamId)) {
    return Response.json({ ok: false, error: "invalid team_id" }, { status: 400 });
  }
  const q = parseQuery(search);
  // Read enough to satisfy the tail after filtering. We scan up to 5×tail by
  // default — for typical filters that's enough to find `tail` matches; in
  // the worst case (extremely sparse denials in a huge log) we'd want a more
  // aggressive scan. This is a deliberate trade-off for response speed; the
  // dashboard's "Load more" affordance can scroll further back.
  const scanCap = Math.max(q.tail * 5, 500);
  const all = readAuditEntries(teamId, scanCap);
  const filtered = applyFilter(all, q, Date.now());
  // Most-recent-first, capped at tail.
  const tail = filtered.slice(-q.tail).reverse();
  const body: AuditApiResult = {
    ok: true,
    team_id: teamId,
    count: tail.length,
    total: filtered.length,
    entries: tail,
  };
  return Response.json(body);
}

// ---------------------------------------------------------------------------
// Aggregate — for the Policy tab section 3 ("recent denials grouped by rule").
// ---------------------------------------------------------------------------

export interface AggregateBucket {
  rule_path: string;
  rule: string;
  count: number;
  last_ts: string;
  teams: string[];
}

export interface AggregateResult {
  ok: true;
  since: string;
  top: AggregateBucket[];
  verifier_corrections: AuditEntry[];
  teams_scanned: number;
}

/**
 * GET /api/audit/aggregate?since=24h&top=10
 *
 * Walks every team's active audit log, filters to denials within `since`,
 * groups by `rule_path`, returns the top-N by count. Also returns the most
 * recent verifier_correction entries (for the timeline section).
 */
export function handleAuditAggregate(search: URLSearchParams): Response {
  const sinceStr = search.get("since") ?? "24h";
  const sinceMs = parseSinceDuration(sinceStr) ?? 24 * 60 * 60 * 1000;
  const topRaw = Number(search.get("top") ?? "10");
  const top = Math.max(1, Math.min(50, Number.isFinite(topRaw) ? Math.floor(topRaw) : 10));
  const cutoffMs = Date.now() - sinceMs;

  const auditDir = getAuditDir();
  const teams: string[] = [];
  try {
    if (existsSync(auditDir)) {
      for (const f of readdirSync(auditDir)) {
        if (!f.endsWith(".jsonl")) continue;
        teams.push(f.slice(0, -".jsonl".length));
      }
    }
  } catch {
    // dir missing or unreadable — return empty aggregate
  }

  const buckets = new Map<string, AggregateBucket>();
  const verifierCorrections: AuditEntry[] = [];

  for (const teamId of teams) {
    if (!isValidTeamId(teamId)) continue;
    const entries = readAuditEntries(teamId, 2000);
    for (const e of entries) {
      const t = Date.parse(e.ts);
      if (!Number.isFinite(t) || t < cutoffMs) continue;
      if (e.event_type === "verifier_correction") {
        verifierCorrections.push(e);
        continue;
      }
      if (e.decision !== "deny") continue;
      const key = e.rule_path ?? "(default-deny)";
      const existing = buckets.get(key);
      if (existing) {
        existing.count += 1;
        if (e.ts > existing.last_ts) existing.last_ts = e.ts;
        if (!existing.teams.includes(e.team_id)) existing.teams.push(e.team_id);
      } else {
        buckets.set(key, {
          rule_path: key,
          rule: e.rule ?? "(default-deny)",
          count: 1,
          last_ts: e.ts,
          teams: [e.team_id],
        });
      }
    }
  }

  const ranked = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, top);
  verifierCorrections.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  const body: AggregateResult = {
    ok: true,
    since: sinceStr,
    top: ranked,
    verifier_corrections: verifierCorrections.slice(0, 50),
    teams_scanned: teams.length,
  };
  return Response.json(body);
}

// ---------------------------------------------------------------------------
// Per-team mode/preset — drives the Policy tab section 1 table.
// ---------------------------------------------------------------------------

export interface TeamPolicyRow {
  team_id: string;
  mode: Mode | null;
  preset: string | null;
  allowlist_sha: string | null;
  spawned_at: string | null;
  project_root: string | null;
  source_paths: string[];
  snapshot_path: string;
  has_snapshot: boolean;
}

/**
 * Read the snapshot file's header without parsing the full TOML body. We only
 * need the comment-prefixed metadata at the top. Cheap enough to do per-team
 * on every request — typical user has 1-3 teams.
 *
 * Returns null if the snapshot is missing or unreadable. Throws nothing.
 */
function readTeamSnapshotHeader(teamId: string): TeamPolicyRow {
  const snapshotPath = getSnapshotPath(teamId);
  const blank: TeamPolicyRow = {
    team_id: teamId,
    mode: null,
    preset: null,
    allowlist_sha: null,
    spawned_at: null,
    project_root: null,
    source_paths: [],
    snapshot_path: snapshotPath,
    has_snapshot: false,
  };
  if (!existsSync(snapshotPath)) return blank;

  let raw: string;
  try {
    raw = readFileSync(snapshotPath, "utf8");
  } catch {
    return blank;
  }

  // Strip comment markers off the header lines and look for our keys + preset
  // (which is in the body, but the body is also TOML — we can just regex the
  // first occurrence of `preset = "..."`).
  const headerLines: string[] = [];
  let inSourcePathsArray = false;
  const bodyLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      const content = trimmed.replace(/^#\s?/, "");
      headerLines.push(content);
      if (content.includes("source_paths")) inSourcePathsArray = true;
    } else if (inSourcePathsArray && trimmed === "") {
      inSourcePathsArray = false;
    } else {
      bodyLines.push(line);
    }
  }

  const find = (re: RegExp) => {
    for (const ln of headerLines) {
      const m = ln.match(re);
      if (m) return m[1];
    }
    return null;
  };

  const mode = find(/^mode\s*=\s*"([^"]+)"/) as Mode | null;
  const allowlistSha = find(/^allowlist_sha\s*=\s*"([^"]+)"/);
  const spawnedAt = find(/^spawned_at\s*=\s*"([^"]+)"/);
  // v2.7.9: snapshots now record `# project_root = "<abs path>"`. Prefer it
  // when present; fall back to the source_paths-derived heuristic below for
  // back-compat with v2.7.8 snapshots.
  const headerProjectRoot = find(/^project_root\s*=\s*"([^"]+)"/);

  // source_paths — multi-line in header. Extract every quoted string between
  // `source_paths = [` and a closing `]`.
  const sourcePaths: string[] = [];
  {
    let collecting = false;
    for (const ln of headerLines) {
      if (ln.match(/^source_paths\s*=\s*\[/)) { collecting = true; continue; }
      if (!collecting) continue;
      if (ln.trim() === "]") break;
      const m = ln.match(/"([^"]+)"/);
      if (m) sourcePaths.push(m[1]);
    }
  }

  // Body — find preset. The body is TOML but we only need the top-level
  // `preset = "node"`. A naive regex on the first non-comment line that
  // matches is good enough.
  let preset: string | null = null;
  for (const ln of bodyLines) {
    const m = ln.match(/^preset\s*=\s*"([^"]+)"/);
    if (m) { preset = m[1]!; break; }
  }

  // Derive project_root. v2.7.9+: the snapshot header records it directly.
  // v2.7.8 and earlier: fall back to the first source path that ends in
  // `/.subctl/policy.toml`. That fallback fails for projects with no project
  // policy file (which is the common case post-v2.7.8 generic-preset floor),
  // which is exactly why we added the explicit header field.
  let projectRoot: string | null = headerProjectRoot;
  if (!projectRoot) {
    for (const sp of sourcePaths) {
      if (sp.endsWith("/.subctl/policy.toml")) {
        projectRoot = sp.slice(0, -"/.subctl/policy.toml".length);
        break;
      }
    }
  }

  return {
    team_id: teamId,
    mode,
    preset,
    allowlist_sha: allowlistSha,
    spawned_at: spawnedAt,
    project_root: projectRoot,
    source_paths: sourcePaths,
    snapshot_path: snapshotPath,
    has_snapshot: true,
  };
}

export interface TeamsListResult {
  ok: true;
  teams: TeamPolicyRow[];
}

/**
 * GET /api/policy/teams
 *
 * Lists every team that has a snapshot under <state>/teams/<team_id>/. For
 * each one we extract mode/preset/allowlist_sha from the snapshot header so
 * the Policy tab can render the live mode table without shelling out.
 */
export function handlePolicyTeams(): Response {
  const teamsDir = getTeamsDir();
  const rows: TeamPolicyRow[] = [];
  try {
    if (existsSync(teamsDir)) {
      for (const e of readdirSync(teamsDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (!isValidTeamId(e.name)) continue;
        rows.push(readTeamSnapshotHeader(e.name));
      }
    }
  } catch {
    // Empty or unreadable — return what we have so far (probably nothing).
  }

  // Most-recently-spawned first; entries with no spawned_at fall to the bottom.
  rows.sort((a, b) => {
    if (a.spawned_at && b.spawned_at) return a.spawned_at < b.spawned_at ? 1 : -1;
    if (a.spawned_at) return -1;
    if (b.spawned_at) return 1;
    return a.team_id < b.team_id ? -1 : 1;
  });

  const result: TeamsListResult = { ok: true, teams: rows };
  return Response.json(result);
}

// ---------------------------------------------------------------------------
// "Suggest allowlist addition" TOML snippet generator
// ---------------------------------------------------------------------------

/**
 * Given a denied audit entry, generate a TOML snippet the operator can paste
 * into `<project>/.subctl/policy.toml` to allow the command in future. The
 * heuristic is conservative: we widen by the head-of-command only (the binary
 * name + its first positional), and we don't unset any deny_always patterns —
 * the operator does that explicitly if they really mean to.
 *
 * Examples:
 *   command "git push --force-with-lease origin main"
 *     → adds `mode.gated.allow_pattern` with command="git", args=["push --force-with-lease ..."]
 *
 *   command "rm -rf /tmp/foo" with rule_path "...deny_always.substrings"
 *     → cannot be silently allow-patterned; we emit a comment block instead
 *       advising the operator to relax the deny_always entry.
 */
export function suggestAllowlistAdditionToml(entry: AuditEntry): string {
  if (entry.decision !== "deny") {
    return `# Entry was already allowed — no addition needed.\n`;
  }
  const cmd = (entry.command ?? "").trim();
  if (!cmd) {
    return `# No command captured on this entry; cannot generate a TOML snippet.\n`;
  }
  const parts = cmd.split(/\s+/);
  const head = parts[0]!;
  const rest = parts.slice(1).join(" ");

  // Deny-substring or deny-regex denials are NOT widenable via allow_pattern.
  // The allow_pattern lookup happens after deny_always in the policy check —
  // we'd be lying to the operator if we said "paste this and you're good."
  // Generate a comment block instead.
  if (entry.rule_path && entry.rule_path.includes("deny_always")) {
    return [
      `# This denial fired on a deny_always rule:`,
      `#   rule_path = ${JSON.stringify(entry.rule_path)}`,
      `#   rule      = ${JSON.stringify(entry.rule ?? "")}`,
      `#`,
      `# deny_always wins over allow_pattern (per pack 05 §3). To permit:`,
      `#   1. Edit the deny_always.substrings or deny_always.regex list to`,
      `#      remove the matching entry, OR`,
      `#   2. Override at the project layer with an empty list, which`,
      `#      effectively disables that family of denials for this project:`,
      `#`,
      `#      [mode.gated.deny_always]`,
      `#      substrings = []`,
      `#`,
      `# (We do NOT generate option 2 automatically — it's a deliberate act.)`,
      ``,
    ].join("\n");
  }

  // Default path: append an allow_pattern entry for the head-of-command.
  return [
    `# Suggested addition to <project>/.subctl/policy.toml`,
    `# Generated from a denial at ${entry.ts} (rule_path=${JSON.stringify(entry.rule_path ?? "")}).`,
    `# Review carefully before applying — widening the gate is permanent.`,
    ``,
    `[[mode.gated.allow_pattern]]`,
    `command = ${JSON.stringify(head)}`,
    `args = [${rest ? JSON.stringify(rest) : `# any`}]`,
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// SSE tail helper — server.ts builds the ReadableStream; we provide the
// "find new lines since byte offset N" primitive used by its ticker.
// ---------------------------------------------------------------------------

/**
 * Read bytes from `path` starting at `fromBytes`, parse the resulting JSONL,
 * return both the parsed entries and the new byte size. Malformed lines are
 * skipped. Tail-friendly: if `fromBytes` exceeds the file's current size
 * (truncation/rotation), we return `{ entries: [], size: currentSize,
 * truncated: true }` so the caller can re-snapshot.
 */
export function readNewAuditEntries(
  path: string,
  fromBytes: number,
): { entries: AuditEntry[]; size: number; truncated: boolean } {
  if (!existsSync(path)) {
    return { entries: [], size: 0, truncated: false };
  }
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { entries: [], size: 0, truncated: false };
  }
  if (size < fromBytes) {
    return { entries: [], size, truncated: true };
  }
  if (size === fromBytes) {
    return { entries: [], size, truncated: false };
  }
  let raw: string;
  try {
    // For SSE tailing we re-read the whole file when small; the rotation
    // boundary is 50 MB so this is bounded. Fancier byte-range reads can come
    // later if benchmarking complains.
    raw = readFileSync(path, "utf8");
  } catch {
    return { entries: [], size, truncated: false };
  }
  // Take only the new tail by byte offset.
  const newBytes = Buffer.byteLength(raw, "utf8") === size ? raw.slice(fromBytes) : raw;
  const entries: AuditEntry[] = [];
  for (const line of newBytes.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as AuditEntry;
      if (typeof obj.ts !== "string") continue;
      entries.push(obj);
    } catch { /* torn line */ }
  }
  return { entries, size, truncated: false };
}
