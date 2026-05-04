// dashboard/lib/cost.ts — token aggregation + API-rate cost calculation.
//
// Walks each account's <cfg_dir>/projects/*/<sid>.jsonl and sums tokens per
// model per time window from the `usage` blocks Claude Code records. Applies
// list-price API rates from config/pricing.json to estimate what the same
// usage would cost outside the subscription, then computes savings.
//
// Used by both dashboard/server.ts (imports directly) and bin/subctl
// `cost` subcommand (invokes via `bun run`).

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const REPO_ROOT = join(import.meta.dir, "..", "..");

// ---------- pricing ----------

interface ModelRate {
  input: number;        // $/M tokens
  output: number;       // $/M tokens
  cacheRead: number;    // $/M tokens
  cacheWrite: number;   // $/M tokens
}

interface PricingTable {
  models: Record<string, ModelRate>;
  subscription_usd_monthly: Record<string, number>;
}

let _pricingCache: PricingTable | null = null;

export function loadPricing(): PricingTable {
  if (_pricingCache) return _pricingCache;
  const path = process.env.SUBCTL_PRICING_FILE
    ?? join(REPO_ROOT, "config", "pricing.json");
  try {
    const raw = readFileSync(path, "utf8");
    const j = JSON.parse(raw);
    _pricingCache = {
      models: j.models ?? {},
      subscription_usd_monthly: j.subscription_usd_monthly ?? {},
    };
  } catch {
    _pricingCache = { models: {}, subscription_usd_monthly: {} };
  }
  return _pricingCache;
}

function rateFor(model: string, pricing: PricingTable): ModelRate | null {
  if (!model) return null;
  // Exact match preferred.
  if (pricing.models[model]) return pricing.models[model]!;
  // Try suffix-prefix variants like "claude-opus-4-7-20251201".
  for (const k of Object.keys(pricing.models)) {
    if (model.startsWith(k)) return pricing.models[k]!;
  }
  return null;
}

// ---------- aggregation ----------

export interface TokenTotals {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface ModelBreakdown extends TokenTotals {
  model: string;
  cost_usd: number;
  turns: number;
}

export interface AccountCostSummary {
  alias: string;
  cfg_dir: string;
  window_label: string;     // "today" | "week" | "month" | "all"
  window_start_ms: number;  // epoch ms; -1 = all time
  by_model: ModelBreakdown[];
  total_tokens: TokenTotals;
  total_cost_usd: number;       // API list price for tokens used this window
  total_turns: number;
  subscription_usd: number;     // what the user pays per month
  // Savings: api_cost - subscription_usd, scaled if window != month.
  savings_usd: number;          // for "month" window only; null otherwise
  scanned_files: number;
}

function listSessionJsonls(cfgDir: string): string[] {
  const projects = join(cfgDir, "projects");
  if (!existsSync(projects)) return [];
  const out: string[] = [];
  try {
    for (const project of readdirSync(projects)) {
      const pdir = join(projects, project);
      let st;
      try { st = statSync(pdir); } catch { continue; }
      if (!st.isDirectory()) continue;
      try {
        for (const f of readdirSync(pdir)) {
          if (f.endsWith(".jsonl")) out.push(join(pdir, f));
        }
      } catch { /* skip unreadable project */ }
    }
  } catch { /* skip */ }
  return out;
}

const WINDOWS: Record<string, number> = {
  today: 24 * 60 * 60 * 1000,
  week:  7  * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

function windowStartMs(label: string, now: number): number {
  if (label === "all") return -1;
  return now - (WINDOWS[label] ?? WINDOWS.month!);
}

// Aggregate tokens for one cfg_dir within a window.
// Walks every jsonl line. Skips files whose mtime predates window_start (fast-path
// for old transcripts). Tolerates malformed lines silently.
export function aggregateAccount(opts: {
  alias: string;
  cfgDir: string;
  window: string;
  now: number;
  pricing: PricingTable;
  subscriptionUsd: number;
}): AccountCostSummary {
  const { alias, cfgDir, window, now, pricing, subscriptionUsd } = opts;
  const wstart = windowStartMs(window, now);
  const byModel = new Map<string, ModelBreakdown>();
  let scanned = 0;

  for (const file of listSessionJsonls(cfgDir)) {
    let st;
    try { st = statSync(file); } catch { continue; }
    if (wstart !== -1 && st.mtimeMs < wstart) continue; // fast skip
    scanned += 1;
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || !t.includes('"usage"')) continue;
      let obj: any;
      try { obj = JSON.parse(t); } catch { continue; }
      const tsStr: string | undefined = obj?.timestamp;
      if (wstart !== -1 && tsStr) {
        const ts = Date.parse(tsStr);
        if (Number.isFinite(ts) && ts < wstart) continue;
      }
      const usage = obj?.message?.usage ?? obj?.usage ?? null;
      if (!usage) continue;
      const model: string = obj?.message?.model ?? obj?.model ?? "unknown";
      const inp  = Number(usage.input_tokens ?? 0);
      const out  = Number(usage.output_tokens ?? 0);
      const cr   = Number(usage.cache_read_input_tokens ?? 0);
      const cw   = Number(usage.cache_creation_input_tokens ?? 0);
      if (inp + out + cr + cw <= 0) continue;
      let entry = byModel.get(model);
      if (!entry) {
        entry = { model, input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0, turns: 0 };
        byModel.set(model, entry);
      }
      entry.input      += inp;
      entry.output     += out;
      entry.cache_read += cr;
      entry.cache_write += cw;
      entry.turns      += 1;
    }
  }

  // Apply pricing.
  let totalCost = 0;
  for (const entry of byModel.values()) {
    const rate = rateFor(entry.model, pricing);
    if (!rate) continue;
    const cost =
        entry.input      * rate.input      / 1_000_000
      + entry.output     * rate.output     / 1_000_000
      + entry.cache_read * rate.cacheRead  / 1_000_000
      + entry.cache_write * rate.cacheWrite / 1_000_000;
    entry.cost_usd = Number(cost.toFixed(4));
    totalCost += cost;
  }

  const breakdown = Array.from(byModel.values())
    .sort((a, b) => b.cost_usd - a.cost_usd);

  const totalTokens: TokenTotals = breakdown.reduce(
    (acc, m) => ({
      input: acc.input + m.input,
      output: acc.output + m.output,
      cache_read: acc.cache_read + m.cache_read,
      cache_write: acc.cache_write + m.cache_write,
    }),
    { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  );

  const totalTurns = breakdown.reduce((acc, m) => acc + m.turns, 0);
  const savings = window === "month" ? totalCost - subscriptionUsd : 0;

  return {
    alias,
    cfg_dir: cfgDir,
    window_label: window,
    window_start_ms: wstart,
    by_model: breakdown,
    total_tokens: totalTokens,
    total_cost_usd: Number(totalCost.toFixed(4)),
    total_turns: totalTurns,
    subscription_usd: subscriptionUsd,
    savings_usd: Number(savings.toFixed(4)),
    scanned_files: scanned,
  };
}

// ---------- multi-account walker ----------

export interface AccountInput {
  alias: string;
  provider: string;
  cfg_dir: string;
}

const ACCOUNTS_CONF = process.env.SUBCTL_ACCOUNTS_CONF
  ?? join(process.env.XDG_CONFIG_HOME ?? join(HOME, ".config"), "subctl", "accounts.conf");

export function readAccountsConf(): AccountInput[] {
  if (!existsSync(ACCOUNTS_CONF)) return [];
  let raw: string;
  try { raw = readFileSync(ACCOUNTS_CONF, "utf8"); } catch { return []; }
  const out: AccountInput[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split("|").map(s => s.trim());
    if (parts.length < 4) continue;
    const [alias, provider, , cfg_dir] = parts;
    if (!alias || !provider || !cfg_dir) continue;
    out.push({ alias, provider, cfg_dir: cfg_dir.replace(/^~/, HOME) });
  }
  return out;
}

export function aggregateAll(window: string, now: number): AccountCostSummary[] {
  const pricing = loadPricing();
  const accounts = readAccountsConf();
  const claudeAccounts = accounts.filter(a => a.provider === "claude");
  const result = claudeAccounts.map(a => aggregateAccount({
    alias: a.alias,
    cfgDir: a.cfg_dir,
    window,
    now,
    pricing,
    subscriptionUsd: pricing.subscription_usd_monthly[a.provider] ?? 200,
  }));

  // Include the default ~/.claude config dir as an unattributed bucket if
  // it has any usage and isn't already a configured account. Sessions that
  // ran via bare `claude` (no CLAUDE_CONFIG_DIR) write there, so power
  // users with mixed history would otherwise see zeros across the board.
  const defaultDir = join(HOME, ".claude");
  const alreadyAccount = claudeAccounts.some(a => a.cfg_dir === defaultDir);
  if (!alreadyAccount && existsSync(join(defaultDir, "projects"))) {
    const def = aggregateAccount({
      alias: "default (~/.claude)",
      cfgDir: defaultDir,
      window,
      now,
      pricing,
      subscriptionUsd: 0,
    });
    if (def.total_turns > 0) result.unshift(def);
  }
  return result;
}

// ---------- CLI entry ----------
//
// Invoked by `bin/subctl cost [alias|all|--json] [--window today|week|month|all]`.
// Prints either a text table or raw JSON.

function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n);
  return sign + "$" + v.toFixed(2);
}

function printTable(rows: AccountCostSummary[]) {
  const w = rows[0]?.window_label ?? "month";
  console.log(`\nCost analysis (${w}, list-price API equivalent)\n`);
  const header = `${"ALIAS".padEnd(20)} ${"INPUT".padStart(8)} ${"OUTPUT".padStart(8)} ${"CACHE-R".padStart(8)} ${"CACHE-W".padStart(8)} ${"TURNS".padStart(7)} ${"API$".padStart(10)} ${"SUB$".padStart(8)} ${"SAVINGS".padStart(10)}`;
  console.log(header);
  console.log("─".repeat(header.length));
  let totalApi = 0, totalSub = 0;
  for (const r of rows) {
    const t = r.total_tokens;
    console.log(
      `${r.alias.padEnd(20)} ` +
      `${fmtTokens(t.input).padStart(8)} ` +
      `${fmtTokens(t.output).padStart(8)} ` +
      `${fmtTokens(t.cache_read).padStart(8)} ` +
      `${fmtTokens(t.cache_write).padStart(8)} ` +
      `${String(r.total_turns).padStart(7)} ` +
      `${fmtUsd(r.total_cost_usd).padStart(10)} ` +
      `${fmtUsd(r.subscription_usd).padStart(8)} ` +
      `${(w === "month" ? fmtUsd(r.savings_usd) : "—").padStart(10)}`
    );
    totalApi += r.total_cost_usd;
    totalSub += r.subscription_usd;
  }
  if (rows.length > 1) {
    console.log("─".repeat(header.length));
    console.log(
      `${"TOTAL".padEnd(20)} ${"".padStart(8)} ${"".padStart(8)} ${"".padStart(8)} ${"".padStart(8)} ${"".padStart(7)} ` +
      `${fmtUsd(totalApi).padStart(10)} ${fmtUsd(totalSub).padStart(8)} ` +
      `${(w === "month" ? fmtUsd(totalApi - totalSub) : "—").padStart(10)}`
    );
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  let target = "all";
  let window = "month";
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") asJson = true;
    else if (a === "--window") window = args[++i] ?? "month";
    else if (!a.startsWith("--")) target = a;
  }
  const now = Date.now();
  const all = aggregateAll(window, now);
  const filtered = (target === "all" || target === "")
    ? all
    : all.filter(r => r.alias === target || r.alias === `claude-${target}`);
  if (asJson) {
    console.log(JSON.stringify(filtered, null, 2));
  } else {
    if (filtered.length === 0) {
      console.error(`no matching accounts (target=${target})`);
      process.exit(1);
    }
    printTable(filtered);
    console.log();
  }
}
