// components/master/upstream-check.ts
//
// v2.7.25 — Upstream-tracking watchdog.
//
// Background. ADR 0015 (v2.7.24) made @earendil-works/pi-ai and
// @earendil-works/pi-agent-core first-class upstreams under an
// "always-latest" policy: every minor/patch subctl release must refresh
// both packages to the most-recent published version. The `^` pin in
// components/master/package.json gets us close, but `bun install` only
// re-resolves when something asks it to. Drift accumulates silently
// between releases — exactly the failure mode ADR 0015 calls out under
// "Negative consequences."
//
// This module closes that gap. Every 6 hours it asks npm for the
// `dist-tags.latest` of both packages, compares against what's pinned
// in components/master/package.json, and emits a notification when a
// newer version is available. The operator decides whether to upgrade.
//
// Manual-mode-by-default is on purpose. The default behavior is a
// notification only — operator reviews, updates, commits manually.
// Setting the gate file ~/.config/subctl/auto-update-upstreams.enabled
// promotes the watchdog to ATTEMPT the upgrade itself: bump the
// package.json pin, run `bun install`, run `bun test`. Tests pass →
// success notification. Tests fail → revert + alert notification.
// Either way the watchdog does NOT auto-commit or auto-push — the
// operator must do that consciously after seeing the notification.
//
// Why no auto-commit. The eval suite (ADR 0008) is the existing gate
// for "did upstream break us?" — and even that runs on operator
// command. Pushing an automated commit would defeat the purpose: the
// operator wouldn't see the diff or the regression report.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  emitNotification,
  type Notification,
} from "./notifications";
import { registerWatchdog, touchWatchdog } from "./watchdogs";

const HOME = homedir();
const SUBCTL_CONFIG_DIR =
  process.env.SUBCTL_CONFIG_DIR ?? join(HOME, ".config", "subctl");
const AUTO_UPDATE_FLAG = join(SUBCTL_CONFIG_DIR, "auto-update-upstreams.enabled");

// The two upstreams ADR 0015 declared first-class. Add to this list if
// pi-mono splits another module into its own npm package.
export const TRACKED_UPSTREAMS = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
] as const;
export type TrackedUpstream = (typeof TRACKED_UPSTREAMS)[number];

const NPM_REGISTRY_BASE = "https://registry.npmjs.org";

/** Default tick interval — 6h. Matches the spec's "doesn't need to be
 *  more aggressive; this is housekeeping not an alerting path."
 *  Configurable via env (SUBCTL_UPSTREAM_CHECK_INTERVAL_MIN, minutes)
 *  for tests + manual override. */
export const DEFAULT_TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpstreamCheckResult {
  package: string;
  pinned: string;
  latest: string;
  /** "patch" | "minor" | "major" | "same" — how big a bump is needed. */
  bump_kind: SemverBumpKind;
  /** True when latest > pinned (any of patch/minor/major). */
  has_update: boolean;
  /** ISO ts when this entry was last refreshed. null on the very first call
   *  before a result lands. */
  checked_at: string;
  /** Set when the fetch failed — caller logs but does not throw. */
  error?: string;
}

export type SemverBumpKind = "same" | "patch" | "minor" | "major" | "unknown";

/** Parse a semver `x.y.z` (or `^x.y.z`) string into numeric parts. */
export function parseSemver(
  version: string,
): { major: number; minor: number; patch: number } | null {
  if (!version) return null;
  // Strip leading `^`, `~`, `=`, `v` and any pre-release/build suffix.
  const stripped = String(version).replace(/^[\^~=v]+/, "");
  const core = stripped.split(/[-+]/)[0] ?? "";
  const m = core.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return {
    major: Number.parseInt(m[1]!, 10),
    minor: Number.parseInt(m[2]!, 10),
    patch: Number.parseInt(m[3]!, 10),
  };
}

/**
 * Classify the bump from `pinned` → `latest`. Returns "same" when
 * they're equal, "major"/"minor"/"patch" when latest is newer, "unknown"
 * when either side fails to parse. Older latest (rare — npm
 * unpublished, manual override) is treated as "same" so we don't
 * downgrade-spam.
 */
export function classifyBump(pinned: string, latest: string): SemverBumpKind {
  const p = parseSemver(pinned);
  const l = parseSemver(latest);
  if (!p || !l) return "unknown";
  if (p.major === l.major && p.minor === l.minor && p.patch === l.patch) {
    return "same";
  }
  if (l.major !== p.major) return l.major > p.major ? "major" : "same";
  if (l.minor !== p.minor) return l.minor > p.minor ? "minor" : "same";
  if (l.patch !== p.patch) return l.patch > p.patch ? "patch" : "same";
  return "same";
}

/**
 * Strip the `^` / `~` operator from a package.json version specifier so
 * the comparison runs against the floor version. We deliberately
 * compare against the FLOOR, not the resolved version — `bun install`
 * may have resolved to something newer, but the spec is "is the pinned
 * floor stale?". A pin of `^0.74.0` against npm latest `0.75.0` is a
 * real signal even if the lockfile already pulled `0.75.0`.
 */
export function pinFloor(spec: string): string {
  return String(spec || "").replace(/^[\^~=]+/, "").trim();
}

interface PackageJsonDeps {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/**
 * Read the master component's package.json and return the pinned
 * version specifier for one tracked upstream. Throws on missing file;
 * returns "" if the package isn't listed.
 */
export function readPinnedVersion(
  packageJsonPath: string,
  packageName: string,
): string {
  const raw = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as PackageJsonDeps;
  return (
    parsed.dependencies?.[packageName] ??
    parsed.devDependencies?.[packageName] ??
    parsed.peerDependencies?.[packageName] ??
    ""
  );
}

/**
 * Write a new pinned version back into package.json, preserving the
 * `^` prefix if the original carried one. Only touches the specific
 * key — the rest of the file is untouched, including formatting (we
 * round-trip through JSON.stringify with 2-space indent because that
 * matches the existing file). Throws if the package isn't present in
 * any dep section.
 */
export function writePinnedVersion(
  packageJsonPath: string,
  packageName: string,
  newSpec: string,
): void {
  const raw = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as PackageJsonDeps;
  let bucket: keyof PackageJsonDeps | null = null;
  if (parsed.dependencies?.[packageName] != null) bucket = "dependencies";
  else if (parsed.devDependencies?.[packageName] != null) bucket = "devDependencies";
  else if (parsed.peerDependencies?.[packageName] != null) bucket = "peerDependencies";
  if (!bucket) {
    throw new Error(`package ${packageName} not present in any deps section of ${packageJsonPath}`);
  }
  (parsed[bucket] as Record<string, string>)[packageName] = newSpec;
  writeFileSync(packageJsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
}

/**
 * Fetch the registered `dist-tags.latest` for one package from npm.
 * Uses a short timeout so a slow registry doesn't stall the watchdog.
 * Returns the version string or throws — the caller handles failure
 * (emits a warn notification at most once per kind of failure).
 */
export interface FetchLatestOptions {
  /** Override registry base, used by tests. */
  registryBase?: string;
  /** Timeout for the fetch in ms; defaults to 6000. */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export async function fetchLatestVersion(
  packageName: string,
  opts: FetchLatestOptions = {},
): Promise<string> {
  const base = opts.registryBase ?? NPM_REGISTRY_BASE;
  // npm's registry accepts scoped names as `/@scope/name` directly —
  // we don't url-encode the `/` separator. Plain unscoped packages
  // are just `/name`.
  const url = `${base}/${packageName}`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 6000);
  try {
    const r = await fetchImpl(url, { signal: ac.signal });
    if (!r.ok) {
      throw new Error(`registry HTTP ${r.status}`);
    }
    const j = (await r.json()) as { "dist-tags"?: { latest?: string } };
    const latest = j?.["dist-tags"]?.latest;
    if (!latest || typeof latest !== "string") {
      throw new Error("dist-tags.latest missing from registry response");
    }
    return latest;
  } finally {
    clearTimeout(t);
  }
}

export interface RunCheckOptions {
  /** Absolute path to components/master/package.json. */
  packageJsonPath: string;
  /** Packages to check. Defaults to TRACKED_UPSTREAMS. */
  packages?: ReadonlyArray<string>;
  /** Registry base override (tests). */
  registryBase?: string;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Emit a notification for each newer version. Defaults to true. */
  emitNotifications?: boolean;
  /** Path to the auto-update gate flag file. Defaults to the standard
   *  ~/.config/subctl/auto-update-upstreams.enabled location. */
  autoUpdateFlagPath?: string;
  /**
   * If the auto-update gate is set, runner that runs `bun install` then
   * `bun test`. Injectable for tests so we don't actually shell out.
   * Default implementation lives in runDefaultAutoUpdateSteps.
   */
  autoUpdateRunner?: AutoUpdateRunner;
}

export type AutoUpdateRunner = (
  packageName: string,
  fromSpec: string,
  toSpec: string,
  packageJsonPath: string,
) => Promise<AutoUpdateOutcome>;

export interface AutoUpdateOutcome {
  ok: boolean;
  /** Human-readable detail; goes into the notification body. */
  detail: string;
  /** Set to true when the runner reverted package.json on failure. */
  reverted?: boolean;
}

export interface RunCheckSummary {
  checked_at: string;
  results: UpstreamCheckResult[];
  /** When the auto-update gate fired, one entry per attempted package. */
  auto_update?: Array<{
    package: string;
    from: string;
    to: string;
    outcome: AutoUpdateOutcome;
  }>;
}

/**
 * Run one tick of the upstream check. Pure (notification emission is
 * the only side effect, and that's gated by emitNotifications=true).
 * The watchdog wrapper around this calls it on a setInterval; tests
 * call it directly with mocked fetch.
 */
export async function runUpstreamCheck(
  opts: RunCheckOptions,
): Promise<RunCheckSummary> {
  const pkgs = opts.packages ?? TRACKED_UPSTREAMS;
  const emitOn = opts.emitNotifications ?? true;
  const flagPath = opts.autoUpdateFlagPath ?? AUTO_UPDATE_FLAG;
  const autoUpdate = existsSync(flagPath);
  const checkedAt = new Date().toISOString();
  const results: UpstreamCheckResult[] = [];
  const autoUpdates: NonNullable<RunCheckSummary["auto_update"]> = [];

  for (const pkg of pkgs) {
    let pinnedSpec = "";
    try {
      pinnedSpec = readPinnedVersion(opts.packageJsonPath, pkg);
    } catch (err) {
      results.push({
        package: pkg,
        pinned: "",
        latest: "",
        bump_kind: "unknown",
        has_update: false,
        checked_at: checkedAt,
        error: `read package.json failed: ${(err as Error).message}`,
      });
      continue;
    }
    if (!pinnedSpec) {
      results.push({
        package: pkg,
        pinned: "",
        latest: "",
        bump_kind: "unknown",
        has_update: false,
        checked_at: checkedAt,
        error: "package not pinned in master/package.json",
      });
      continue;
    }
    const pinned = pinFloor(pinnedSpec);
    let latest = "";
    try {
      latest = await fetchLatestVersion(pkg, {
        registryBase: opts.registryBase,
        fetchImpl: opts.fetchImpl,
      });
    } catch (err) {
      results.push({
        package: pkg,
        pinned,
        latest: "",
        bump_kind: "unknown",
        has_update: false,
        checked_at: checkedAt,
        error: `registry fetch failed: ${(err as Error).message}`,
      });
      continue;
    }
    const bump = classifyBump(pinned, latest);
    const hasUpdate = bump === "patch" || bump === "minor" || bump === "major";
    results.push({
      package: pkg,
      pinned,
      latest,
      bump_kind: bump,
      has_update: hasUpdate,
      checked_at: checkedAt,
    });

    if (!hasUpdate) continue;

    if (emitOn && !autoUpdate) {
      // Manual mode (default) — notification only.
      const sev = bump === "major" ? "warn" : "info";
      emitNotification({
        kind: "upstream-available",
        severity: sev,
        title: shortName(pkg) + " " + pinned + " → " + latest + " available",
        body:
          "npm registry reports a newer release for " +
          pkg +
          ". This is a " +
          bump +
          " bump.\n\nUpdate path:\n  1. bump components/master/package.json\n  2. cd components/master && bun install\n  3. bun test\n  4. commit + push\n\nThe auto-update gate file at " +
          flagPath +
          " can run steps 1–3 unattended (without commit + push) the next time this watchdog ticks.",
        metadata: { package: pkg, from: pinned, to: latest, bump_kind: bump },
      });
    }

    if (autoUpdate && opts.autoUpdateRunner) {
      // Auto-update gate is set. Run the upgrade attempt.
      const newSpec = preserveCaret(pinnedSpec, latest);
      let outcome: AutoUpdateOutcome;
      try {
        outcome = await opts.autoUpdateRunner(
          pkg,
          pinnedSpec,
          newSpec,
          opts.packageJsonPath,
        );
      } catch (err) {
        outcome = {
          ok: false,
          detail: "auto-update runner threw: " + (err as Error).message,
          reverted: false,
        };
      }
      autoUpdates.push({ package: pkg, from: pinned, to: latest, outcome });
      if (emitOn) {
        if (outcome.ok) {
          emitNotification({
            kind: "upstream-auto-updated",
            severity: "info",
            title:
              shortName(pkg) + " auto-updated " + pinned + " → " + latest + " (tests passing)",
            body:
              "Auto-update gate fired. package.json updated, bun install + bun test both succeeded.\n\n" +
              outcome.detail +
              "\n\nReview the diff and commit + push manually — the watchdog deliberately does NOT auto-commit.",
            metadata: {
              package: pkg,
              from: pinned,
              to: latest,
              bump_kind: bump,
            },
          });
        } else {
          emitNotification({
            kind: "upstream-update-failed",
            severity: "alert",
            title:
              shortName(pkg) + " auto-update " + pinned + " → " + latest + " failed tests; reverted",
            body:
              "Auto-update gate fired. Tests failed after the upstream bump; package.json was reverted to " +
              pinned +
              ".\n\n" +
              outcome.detail,
            metadata: {
              package: pkg,
              from: pinned,
              to: latest,
              bump_kind: bump,
              reverted: outcome.reverted === true,
            },
          });
        }
      }
    }
  }

  return {
    checked_at: checkedAt,
    results,
    auto_update: autoUpdates.length > 0 ? autoUpdates : undefined,
  };
}

/**
 * Default auto-update runner. Writes the new pin, runs `bun install`,
 * runs `bun test`. Reverts on failure. Stays close to what the
 * operator would do by hand. Lives outside runUpstreamCheck so tests
 * can inject a mock that doesn't shell out.
 */
export function defaultAutoUpdateRunner(opts?: {
  cwd?: string;
  testCmd?: string[];
  installCmd?: string[];
  spawn?: typeof Bun.spawn;
}): AutoUpdateRunner {
  const installCmd = opts?.installCmd ?? ["bun", "install"];
  const testCmd = opts?.testCmd ?? ["bun", "test"];
  const spawn = opts?.spawn ?? Bun.spawn;
  return async (packageName, fromSpec, toSpec, packageJsonPath) => {
    const cwd = opts?.cwd ?? dirOf(packageJsonPath);
    // 1. Update package.json
    try {
      writePinnedVersion(packageJsonPath, packageName, toSpec);
    } catch (err) {
      return {
        ok: false,
        detail: "writePinnedVersion failed: " + (err as Error).message,
        reverted: false,
      };
    }
    const revert = () => {
      try {
        writePinnedVersion(packageJsonPath, packageName, fromSpec);
        return true;
      } catch {
        return false;
      }
    };
    // 2. bun install
    try {
      const proc = spawn({ cmd: installCmd, cwd, stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) {
        const reverted = revert();
        return {
          ok: false,
          detail: "bun install exited " + code,
          reverted,
        };
      }
    } catch (err) {
      const reverted = revert();
      return {
        ok: false,
        detail: "bun install spawn failed: " + (err as Error).message,
        reverted,
      };
    }
    // 3. bun test
    try {
      const proc = spawn({ cmd: testCmd, cwd, stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) {
        const reverted = revert();
        return {
          ok: false,
          detail: "bun test exited " + code,
          reverted,
        };
      }
    } catch (err) {
      const reverted = revert();
      return {
        ok: false,
        detail: "bun test spawn failed: " + (err as Error).message,
        reverted,
      };
    }
    return {
      ok: true,
      detail:
        "wrote " +
        packageName +
        " = " +
        toSpec +
        " into " +
        packageJsonPath +
        "; bun install + bun test both succeeded",
    };
  };
}

function dirOf(absPath: string): string {
  const i = absPath.lastIndexOf("/");
  return i < 0 ? "." : absPath.slice(0, i);
}

function shortName(pkg: string): string {
  // Drop the leading scope so notification titles stay readable:
  //   "@earendil-works/pi-ai" → "pi-ai"
  const slash = pkg.indexOf("/");
  return slash < 0 ? pkg : pkg.slice(slash + 1);
}

/**
 * Build the new package.json spec, preserving the operator's `^` /
 * `~` decision: `^0.74.0` → `^0.75.0`, `0.74.0` → `0.75.0`.
 */
export function preserveCaret(originalSpec: string, newVersion: string): string {
  const prefixMatch = String(originalSpec || "").match(/^([\^~=]+)/);
  const prefix = prefixMatch ? prefixMatch[1]! : "";
  return prefix + newVersion;
}

/**
 * State shared with `/api/upstreams` and the `/upstreams` Telegram
 * command. The watchdog updates `last_summary` on every tick; readers
 * see a single point-in-time snapshot.
 */
interface UpstreamCheckState {
  last_summary: RunCheckSummary | null;
}
const _state: UpstreamCheckState = { last_summary: null };

export function getLastUpstreamCheckSummary(): RunCheckSummary | null {
  return _state.last_summary;
}

/**
 * Start the watchdog. Registers under "upstream-check" with kind
 * "upstream-check", fires once at boot+20s (so the dashboard's
 * /api/upstreams shows real data on the first visit), then every
 * intervalMs after that. Returns a `{ stop, runNow }` handle —
 * `runNow` is what `/upstreams check` (Telegram) and the dashboard's
 * "Check now" button call.
 */
export interface StartUpstreamWatchdogOptions {
  packageJsonPath: string;
  /** Override the 6h default (ms). */
  intervalMs?: number;
  /** Used by tests to skip the boot-early-fire. */
  skipEarlyFire?: boolean;
  /** Override registry base (tests). */
  registryBase?: string;
  /** Inject a fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Inject an auto-update runner (tests). */
  autoUpdateRunner?: AutoUpdateRunner;
  /** Override the auto-update flag location (tests). */
  autoUpdateFlagPath?: string;
}

export interface UpstreamWatchdogHandle {
  stop: () => void;
  /** Trigger one tick immediately. Awaitable so the dashboard's
   *  "Check now" button can report when the tick finishes. */
  runNow: () => Promise<RunCheckSummary>;
}

export function startUpstreamWatchdog(
  opts: StartUpstreamWatchdogOptions,
): UpstreamWatchdogHandle {
  const intervalMs = opts.intervalMs ?? envIntervalMs() ?? DEFAULT_TICK_INTERVAL_MS;
  let stopped = false;

  const runner = opts.autoUpdateRunner ?? defaultAutoUpdateRunner();

  const runOne = async (): Promise<RunCheckSummary> => {
    touchWatchdog("upstream-check");
    try {
      const summary = await runUpstreamCheck({
        packageJsonPath: opts.packageJsonPath,
        registryBase: opts.registryBase,
        fetchImpl: opts.fetchImpl,
        autoUpdateRunner: runner,
        autoUpdateFlagPath: opts.autoUpdateFlagPath,
      });
      _state.last_summary = summary;
      return summary;
    } catch (err) {
      // Don't tight-loop on a thrown tick — surface as a warn
      // notification so the operator notices but the daemon keeps
      // running. Mirrors auto-compact-error handling.
      emitNotification({
        kind: "upstream-check-error",
        severity: "warn",
        title: "upstream-check tick threw",
        body: "runUpstreamCheck threw: " + (err as Error).message,
      });
      const summary: RunCheckSummary = {
        checked_at: new Date().toISOString(),
        results: [],
      };
      _state.last_summary = summary;
      return summary;
    }
  };

  const interval = setInterval(() => {
    if (stopped) return;
    void runOne();
  }, intervalMs);

  registerWatchdog({
    id: "upstream-check",
    kind: "upstream-check",
    kill: () => {
      stopped = true;
      clearInterval(interval);
    },
  });

  if (!opts.skipEarlyFire) {
    // Boot-early fire so /api/upstreams + /upstreams Telegram return
    // real data on the first dashboard visit / first command without
    // waiting 6h. Mirrors auto-compact's setTimeout(…, 15_000).
    setTimeout(() => {
      if (!stopped) void runOne();
    }, 20_000);
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
    runNow: runOne,
  };
}

function envIntervalMs(): number | null {
  const raw = process.env.SUBCTL_UPSTREAM_CHECK_INTERVAL_MIN;
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return n * 60 * 1000;
  return null;
}

/**
 * Convenience: shape the summary for the master HTTP route and the
 * Telegram command. Returns a stable object whether or not the
 * watchdog has ticked yet.
 */
export function describeUpstreamState(): {
  checked_at: string | null;
  results: UpstreamCheckResult[];
  auto_update_enabled: boolean;
  auto_update_flag_path: string;
} {
  return {
    checked_at: _state.last_summary?.checked_at ?? null,
    results: _state.last_summary?.results ?? [],
    auto_update_enabled: existsSync(AUTO_UPDATE_FLAG),
    auto_update_flag_path: AUTO_UPDATE_FLAG,
  };
}

/**
 * Test-only — reset module state between tests.
 */
export function _resetForTesting(): void {
  _state.last_summary = null;
}

// Re-export for callers that want to import a single name.
export type { Notification };
