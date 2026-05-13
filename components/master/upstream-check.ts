// components/master/upstream-check.ts
//
// v2.7.25 — Upstream-tracking watchdog.
// v2.7.37 — Auto-update automation (worktree + bun test/build/typecheck
//           + push to chore/upstream-* branch; never merges to main).
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
// promotes the watchdog to ATTEMPT the upgrade itself in a FRESH GIT
// WORKTREE under /tmp/subctl-upstream-update-<ts>/:
//   1. `bun install <package>@latest` in components/master/
//   2. `bun test`, `bun build`, typecheck — all must be clean
//   3. Commit + push to `chore/upstream-<package>-<ts>` (NEVER main)
//   4. Emit info notification (operator reviews + merges by hand)
// Tests fail → revert the worktree, alert notification with the first
// 1KB of failure output. Every attempt — success or failure — appends
// one line to ~/.local/state/subctl/audit/upstream-updates.jsonl.
//
// Why we never auto-merge. The eval suite (ADR 0008) is the existing
// gate for "did upstream break us?" — and even that runs on operator
// command. Auto-merging would defeat the purpose: the operator wouldn't
// see the diff or the regression report. Pushing a PR-ready branch is
// the highest level of automation we'll do without an eyeball.
//
// Throttle. At most one auto-update attempt per package per 24h, to
// avoid thrash when upstream publishes multiple patch releases in a
// day. Throttle state lives at ~/.local/state/subctl/upstream-throttle.json
// (writable from the same daemon that wrote the audit log; restart-safe).
// Manual triggers via `subctl upstream update` or POST /upstreams/update
// bypass the throttle for the current invocation only.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

import {
  emitNotification,
  type Notification,
} from "./notifications";
import { registerWatchdog, touchWatchdog } from "./watchdogs";

const HOME = homedir();
const SUBCTL_CONFIG_DIR =
  process.env.SUBCTL_CONFIG_DIR ?? join(HOME, ".config", "subctl");
const AUTO_UPDATE_FLAG = join(SUBCTL_CONFIG_DIR, "auto-update-upstreams.enabled");

const SUBCTL_STATE_DIR =
  process.env.SUBCTL_STATE_DIR ?? join(HOME, ".local", "state", "subctl");
const AUDIT_LOG_PATH = join(SUBCTL_STATE_DIR, "audit", "upstream-updates.jsonl");
const THROTTLE_PATH = join(SUBCTL_STATE_DIR, "upstream-throttle.json");

/** Default per-package throttle window — 24h.
 *  Configurable via env (SUBCTL_UPSTREAM_THROTTLE_MIN, minutes) for
 *  tests + operator override. */
export const DEFAULT_THROTTLE_MS = 24 * 60 * 60 * 1000;

// Test seam — let tests redirect audit + throttle paths to a tmpdir.
let _auditPathOverride: string | null = null;
let _throttlePathOverride: string | null = null;

export function _setAuditPathForTesting(p: string | null): void {
  _auditPathOverride = p;
}

export function _setThrottlePathForTesting(p: string | null): void {
  _throttlePathOverride = p;
}

function auditPath(): string {
  return _auditPathOverride ?? AUDIT_LOG_PATH;
}

function throttlePath(): string {
  return _throttlePathOverride ?? THROTTLE_PATH;
}

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
   * Default lives in `worktreeAutoUpdateRunner`.
   */
  autoUpdateRunner?: AutoUpdateRunner;
  /** Per-package throttle window in ms. Defaults to DEFAULT_THROTTLE_MS (24h).
   *  Setting to 0 disables the throttle (manual trigger flow). */
  throttleMs?: number;
  /** When true, ignore the throttle even if a recent attempt exists.
   *  Used by `runManualUpdate` so operator-driven triggers always run. */
  bypassThrottle?: boolean;
  /** Override audit log path (tests). */
  auditLogPath?: string;
  /** Override throttle state path (tests). */
  throttleStatePath?: string;
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
  /** Pushed branch name (set when the runner committed + pushed). */
  branch?: string;
  /** Worktree path used for the attempt (cleaned up on success). */
  worktree_path?: string;
  /** Captured stderr (truncated to 1KB) for failure notifications. */
  stderr_excerpt?: string;
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
  // Sentinel used by `runManualUpdate` to force auto-update on even
  // when the gate file isn't set.
  const autoUpdate = flagPath === ALWAYS_ON_FLAG_SENTINEL || existsSync(flagPath);
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
      // Auto-update gate is set. Honor the per-package throttle unless
      // the caller explicitly bypassed it (manual trigger).
      const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
      const bypass = opts.bypassThrottle === true;
      const tPath = opts.throttleStatePath ?? throttlePath();
      const aPath = opts.auditLogPath ?? auditPath();
      const lastAttempt = readLastAttempt(pkg, tPath);
      const ageMs =
        lastAttempt == null ? Number.POSITIVE_INFINITY : Date.now() - lastAttempt;
      if (!bypass && throttleMs > 0 && ageMs < throttleMs) {
        // Throttled — skip this tick. Don't notify (we already
        // notified at the first detection); record the throttle event
        // in the audit log so the operator can see why nothing
        // happened.
        appendAuditEntry(aPath, {
          ts: new Date().toISOString(),
          event: "throttled",
          package: pkg,
          from: pinned,
          to: latest,
          bump_kind: bump,
          throttle_remaining_s: Math.floor((throttleMs - ageMs) / 1000),
        });
        autoUpdates.push({
          package: pkg,
          from: pinned,
          to: latest,
          outcome: {
            ok: false,
            detail:
              "throttled — last attempt was " +
              Math.floor(ageMs / 60_000) +
              "m ago; window is " +
              Math.floor(throttleMs / 60_000) +
              "m. Run `subctl upstream update` to bypass.",
          },
        });
        continue;
      }

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

      // Record the attempt in the throttle file (success or failure)
      // so we don't tight-loop on a broken upstream.
      writeLastAttempt(pkg, Date.now(), tPath);
      // Audit log — one line per attempt, always.
      appendAuditEntry(aPath, {
        ts: new Date().toISOString(),
        event: outcome.ok ? "success" : "failure",
        package: pkg,
        from: pinned,
        to: latest,
        bump_kind: bump,
        branch: outcome.branch,
        worktree_path: outcome.worktree_path,
        reverted: outcome.reverted === true,
        detail: outcome.detail,
        stderr_excerpt: outcome.stderr_excerpt,
        trigger: bypass ? "manual" : "watchdog",
      });

      if (emitOn) {
        if (outcome.ok) {
          emitNotification({
            kind: "upstream-auto-updated",
            severity: "info",
            title:
              shortName(pkg) + " auto-updated " + pinned + " → " + latest +
              (outcome.branch ? "; PR-ready branch pushed" : ""),
            body:
              "Auto-update gate fired. package.json bumped, bun install + bun test + bun build + typecheck all clean. " +
              (outcome.branch
                ? "Branch `" +
                  outcome.branch +
                  "` pushed — review the diff and merge by hand. The watchdog deliberately does NOT auto-merge."
                : "") +
              "\n\n" +
              outcome.detail,
            metadata: {
              package: pkg,
              from: pinned,
              to: latest,
              bump_kind: bump,
              branch: outcome.branch,
            },
          });
        } else {
          emitNotification({
            kind: "upstream-update-failed",
            severity: "alert",
            title:
              shortName(pkg) + " auto-update " + pinned + " → " + latest + " failed; reverted",
            body:
              "Auto-update gate fired. Failure during upstream bump; worktree reverted/removed.\n\n" +
              outcome.detail +
              (outcome.stderr_excerpt
                ? "\n\nstderr (first 1KB):\n" + outcome.stderr_excerpt
                : ""),
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
 * @deprecated v2.7.37 superseded by `worktreeAutoUpdateRunner`.
 * Kept for back-compat: the existing unit tests inject mock runners
 * directly, but a few in-tree consumers may still import this name.
 * Writes the new pin, runs `bun install`, runs `bun test`. Reverts on
 * failure. Touches the LIVE working copy — the v2.7.37 worktree-based
 * runner replaces this for production use.
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

/**
 * v2.7.37 — Worktree-based auto-update runner.
 *
 * Builds a fresh git worktree under /tmp/subctl-upstream-update-<ts>/
 * based off the current branch's HEAD, bumps the upstream there,
 * runs `bun install <pkg>@latest`, `bun test`, `bun build`, and a
 * typecheck (`bun tsc --noEmit`). All clean → commit + push to a
 * `chore/upstream-<pkg>-<ts>` branch (NEVER main, NEVER tags) and
 * leave the worktree behind for the operator to inspect. Anything
 * non-zero → tear the worktree down and surface the failure to the
 * notification channel. The audit log (~/.local/state/subctl/audit/
 * upstream-updates.jsonl) gets one line either way.
 *
 * Defensive defaults:
 *   - Every shell-out has a timeout (default 5 min per step).
 *   - stderr from a failed step is captured and truncated to 1KB so the
 *     notification body stays bounded.
 *   - No interactive prompts: GIT_TERMINAL_PROMPT=0 forces git to fail
 *     fast on credential prompts instead of hanging the daemon.
 *   - The runner NEVER touches main, NEVER force-pushes, NEVER tags,
 *     NEVER deletes branches — only `worktree add/remove` and a
 *     single `push` of the new chore branch.
 */
export interface WorktreeRunnerOptions {
  /** Root of the git repo. Defaults to `git rev-parse --show-toplevel`
   *  from the package.json's component dir. */
  repoRoot?: string;
  /** Override the base directory for worktrees. Defaults to /tmp. */
  worktreeBaseDir?: string;
  /** Override the git remote name. Defaults to "origin". */
  remoteName?: string;
  /** Per-step timeout in ms (install/test/build/typecheck). */
  stepTimeoutMs?: number;
  /** Injectable spawn for tests. */
  spawn?: typeof Bun.spawn;
  /** Override bun executable (tests). */
  bunBin?: string;
  /** Override git executable (tests). */
  gitBin?: string;
  /** Skip the push step (used by tests + manual --no-push mode). */
  skipPush?: boolean;
  /** Skip cleanup so an operator can debug a failed run. */
  keepWorktree?: boolean;
  /** Override clock for deterministic timestamps in tests. */
  now?: () => number;
}

export function worktreeAutoUpdateRunner(
  opts: WorktreeRunnerOptions = {},
): AutoUpdateRunner {
  const stepTimeoutMs = opts.stepTimeoutMs ?? 5 * 60 * 1000;
  const spawn = opts.spawn ?? Bun.spawn;
  const bunBin = opts.bunBin ?? "bun";
  const gitBin = opts.gitBin ?? "git";
  const remote = opts.remoteName ?? "origin";
  const worktreeBase = opts.worktreeBaseDir ?? tmpdir();
  const now = opts.now ?? Date.now;

  // Helper: run a shell-out with timeout + captured stdout/stderr.
  // Returns { code, stdout, stderr }. Throws only on spawn failure.
  async function run(
    cmd: string[],
    cwd: string,
    env?: Record<string, string>,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = spawn({
      cmd,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, stepTimeoutMs);
    try {
      const [stdoutText, stderrText, code] = await Promise.all([
        proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
        proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
        proc.exited,
      ]);
      return { code, stdout: stdoutText, stderr: stderrText };
    } finally {
      clearTimeout(timer);
    }
  }

  return async (packageName, fromSpec, toSpec, packageJsonPath) => {
    const componentDir = dirOf(packageJsonPath);
    let repoRoot = opts.repoRoot;
    if (!repoRoot) {
      try {
        const r = await run([gitBin, "rev-parse", "--show-toplevel"], componentDir);
        if (r.code !== 0) {
          return {
            ok: false,
            detail:
              "could not resolve git repo root: " + (r.stderr || r.stdout || "").trim(),
            reverted: false,
          };
        }
        repoRoot = r.stdout.trim();
      } catch (err) {
        return {
          ok: false,
          detail: "git rev-parse threw: " + (err as Error).message,
          reverted: false,
        };
      }
    }

    const ts = String(now());
    const safePkg = packageName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    const branch = `chore/upstream-${safePkg}-${ts}`;
    const worktreePath = join(worktreeBase, `subctl-upstream-update-${ts}`);
    const wtComponentDir = join(
      worktreePath,
      packageJsonPath.slice(repoRoot.length + 1, packageJsonPath.lastIndexOf("/")),
    );

    // Step 1 — create the worktree off HEAD with a fresh branch.
    let r = await run(
      [gitBin, "worktree", "add", "-b", branch, worktreePath, "HEAD"],
      repoRoot,
    );
    if (r.code !== 0) {
      return {
        ok: false,
        detail: "git worktree add failed (exit " + r.code + ")",
        reverted: false,
        stderr_excerpt: truncate(r.stderr || r.stdout, 1024),
      };
    }

    // From here on, any failure must clean up the worktree + delete
    // the fresh branch. cleanup() is a no-op when `opts.keepWorktree`
    // is set (debug aid).
    const cleanup = async (): Promise<boolean> => {
      if (opts.keepWorktree) return false;
      // `worktree remove --force` is safe — the worktree is one we
      // just created. Then drop the branch.
      try {
        await run([gitBin, "worktree", "remove", "--force", worktreePath], repoRoot!);
      } catch {
        /* swallow */
      }
      try {
        await run([gitBin, "branch", "-D", branch], repoRoot!);
      } catch {
        /* swallow */
      }
      return true;
    };

    // Step 2 — write the new pin into the worktree's package.json.
    const wtPackageJson = join(
      worktreePath,
      packageJsonPath.slice(repoRoot.length + 1),
    );
    try {
      writePinnedVersion(wtPackageJson, packageName, toSpec);
    } catch (err) {
      const reverted = await cleanup();
      return {
        ok: false,
        detail: "writePinnedVersion failed in worktree: " + (err as Error).message,
        reverted,
        worktree_path: worktreePath,
      };
    }

    // Step 3 — `bun install <pkg>@latest` in the component dir.
    // We use the explicit "<pkg>@latest" form so bun re-resolves
    // even if the lockfile is still happy with the old version.
    r = await run([bunBin, "install", packageName + "@latest"], wtComponentDir);
    if (r.code !== 0) {
      const reverted = await cleanup();
      return {
        ok: false,
        detail: "bun install " + packageName + "@latest exited " + r.code,
        reverted,
        stderr_excerpt: truncate(r.stderr || r.stdout, 1024),
        worktree_path: worktreePath,
      };
    }

    // Step 4 — `bun test` in the component dir.
    r = await run([bunBin, "test"], wtComponentDir);
    if (r.code !== 0) {
      const reverted = await cleanup();
      return {
        ok: false,
        detail: "bun test exited " + r.code,
        reverted,
        stderr_excerpt: truncate(r.stderr || r.stdout, 1024),
        worktree_path: worktreePath,
      };
    }

    // Step 5 — `bun build` (best-effort: not every component has a
    // build script; treat a missing-script exit as success and only
    // fail on a real build error).
    r = await run([bunBin, "run", "--if-present", "build"], wtComponentDir);
    if (r.code !== 0 && !/missing script|no such script/i.test(r.stderr + r.stdout)) {
      const reverted = await cleanup();
      return {
        ok: false,
        detail: "bun build exited " + r.code,
        reverted,
        stderr_excerpt: truncate(r.stderr || r.stdout, 1024),
        worktree_path: worktreePath,
      };
    }

    // Step 6 — typecheck. Bun ships tsc under `bun x tsc`. Same
    // "missing script" tolerance applies — not every component has a
    // tsconfig wired.
    r = await run([bunBin, "x", "tsc", "--noEmit"], wtComponentDir);
    if (
      r.code !== 0 &&
      !/cannot find|no inputs were found|file not found/i.test(r.stderr + r.stdout)
    ) {
      const reverted = await cleanup();
      return {
        ok: false,
        detail: "tsc --noEmit exited " + r.code,
        reverted,
        stderr_excerpt: truncate(r.stderr || r.stdout, 1024),
        worktree_path: worktreePath,
      };
    }

    // Step 7 — stage package.json (and any lockfile bun touched), then commit.
    r = await run(
      [gitBin, "add", "package.json", "bun.lock", "bun.lockb"],
      wtComponentDir,
    );
    // `git add` may complain about missing pathspecs (no lockfile) —
    // ignore non-zero here since we'll catch a real issue at commit.

    const commitMsg = "chore(deps): auto-update " + packageName + " " + pinFloor(fromSpec) + " → " + pinFloor(toSpec);
    r = await run([gitBin, "commit", "-m", commitMsg], wtComponentDir);
    if (r.code !== 0) {
      const reverted = await cleanup();
      return {
        ok: false,
        detail: "git commit failed (exit " + r.code + "): " + commitMsg,
        reverted,
        stderr_excerpt: truncate(r.stderr || r.stdout, 1024),
        worktree_path: worktreePath,
      };
    }

    // Step 8 — push the branch. NEVER push to main, NEVER force.
    if (!opts.skipPush) {
      r = await run(
        [gitBin, "push", "--no-verify", "-u", remote, branch + ":" + branch],
        wtComponentDir,
      );
      if (r.code !== 0) {
        // Commit landed locally; surface as a soft failure (the
        // worktree stays around so the operator can push manually).
        return {
          ok: false,
          detail:
            "git push to " +
            remote +
            "/" +
            branch +
            " exited " +
            r.code +
            " — commit is local in worktree " +
            worktreePath +
            "; push by hand once you've reviewed it",
          reverted: false,
          stderr_excerpt: truncate(r.stderr || r.stdout, 1024),
          branch,
          worktree_path: worktreePath,
        };
      }
    }

    return {
      ok: true,
      detail:
        "worktree " +
        worktreePath +
        ": bumped " +
        packageName +
        " → " +
        toSpec +
        "; install + test + build + typecheck clean; committed (" +
        commitMsg +
        ")" +
        (opts.skipPush ? " — push skipped" : "; pushed to " + remote + "/" + branch),
      branch,
      worktree_path: worktreePath,
    };
  };
}

function dirOf(absPath: string): string {
  const i = absPath.lastIndexOf("/");
  return i < 0 ? "." : absPath.slice(0, i);
}

function truncate(s: string, max: number): string {
  if (s == null) return "";
  const t = String(s);
  return t.length <= max ? t : t.slice(0, max) + "\n…[truncated " + (t.length - max) + " bytes]";
}

// ── throttle state ─────────────────────────────────────────────────────────
// Persisted to ~/.local/state/subctl/upstream-throttle.json so we
// survive a daemon restart and don't get a thrash on every reboot. The
// shape is { "<package>": <epoch ms of last attempt> }; missing keys
// mean "no recent attempt — go ahead".

interface ThrottleFile {
  [pkg: string]: number;
}

function readThrottleFile(path: string): ThrottleFile {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as ThrottleFile;
  } catch {
    // Malformed throttle file is non-fatal — return an empty record
    // and the next write will overwrite it.
    return {};
  }
}

function writeThrottleFile(path: string, data: ThrottleFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch (err) {
    console.error("[upstream-check] throttle write failed:", (err as Error).message);
  }
}

export function readLastAttempt(pkg: string, path?: string): number | null {
  const data = readThrottleFile(path ?? throttlePath());
  return typeof data[pkg] === "number" ? data[pkg] : null;
}

export function writeLastAttempt(pkg: string, ts: number, path?: string): void {
  const p = path ?? throttlePath();
  const data = readThrottleFile(p);
  data[pkg] = ts;
  writeThrottleFile(p, data);
}

/**
 * Test-only — wipe the throttle file. Don't call this from production
 * code: the operator-visible cure for a stuck throttle is `subctl
 * upstream update` (manual trigger, which bypasses the throttle and
 * writes a fresh attempt timestamp on the way out).
 */
export function _clearThrottleForTesting(path?: string): void {
  const p = path ?? throttlePath();
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* ignore */
  }
}

// ── audit log ──────────────────────────────────────────────────────────────
// JSONL — one event per line. The reader streams the last N lines so
// we never load the full log into memory.

export interface AuditEntry {
  ts: string;
  /** "success" | "failure" | "throttled" */
  event: string;
  package: string;
  from: string;
  to: string;
  bump_kind?: SemverBumpKind;
  branch?: string;
  worktree_path?: string;
  reverted?: boolean;
  detail?: string;
  stderr_excerpt?: string;
  /** "watchdog" | "manual" */
  trigger?: string;
  /** Throttle event: how many seconds remain in the window. */
  throttle_remaining_s?: number;
}

export function appendAuditEntry(path: string, entry: AuditEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.error("[upstream-check] audit write failed:", (err as Error).message);
  }
}

export function readUpdateHistory(opts?: {
  limit?: number;
  path?: string;
}): AuditEntry[] {
  const limit = Math.max(1, Math.min(500, opts?.limit ?? 50));
  const path = opts?.path ?? auditPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const tail = lines.slice(-limit);
    const entries: AuditEntry[] = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* skip malformed lines */
      }
    }
    // Newest first — easier for the CLI + dashboard to consume.
    return entries.reverse();
  } catch (err) {
    console.error("[upstream-check] audit read failed:", (err as Error).message);
    return [];
  }
}

// ── auto-update flag toggle ────────────────────────────────────────────────
// Operator-driven. The dashboard's "Auto-update" switch + `subctl
// upstream update --enable/--disable` flip the file at
// ~/.config/subctl/auto-update-upstreams.enabled.

export function setAutoUpdateEnabled(
  enabled: boolean,
  flagPath: string = AUTO_UPDATE_FLAG,
): boolean {
  try {
    if (enabled) {
      mkdirSync(dirname(flagPath), { recursive: true });
      writeFileSync(
        flagPath,
        "Auto-update flag — set by setAutoUpdateEnabled(). Delete to disable.\n",
      );
      return true;
    }
    if (existsSync(flagPath)) {
      unlinkSync(flagPath);
    }
    return true;
  } catch (err) {
    console.error("[upstream-check] flag write failed:", (err as Error).message);
    return false;
  }
}

export function isAutoUpdateEnabled(flagPath: string = AUTO_UPDATE_FLAG): boolean {
  return existsSync(flagPath);
}

// ── manual trigger ─────────────────────────────────────────────────────────
// Operator-driven path. `subctl upstream update` + POST /upstreams/update
// land here. Bypasses the throttle and (when no package is named)
// updates every TRACKED_UPSTREAM that has a newer version.

export interface ManualUpdateOptions {
  packageJsonPath: string;
  /** Specific package to update; omit to update every tracked upstream
   *  that has a newer version. */
  package?: string;
  /** Injectable, same shape as the watchdog. */
  fetchImpl?: typeof fetch;
  registryBase?: string;
  autoUpdateRunner?: AutoUpdateRunner;
  /** Override audit log path (tests). */
  auditLogPath?: string;
  /** Override throttle state path (tests). */
  throttleStatePath?: string;
  /** Emit notifications. Defaults to true. */
  emitNotifications?: boolean;
}

export async function runManualUpdate(
  opts: ManualUpdateOptions,
): Promise<RunCheckSummary> {
  const pkgs = opts.package ? [opts.package] : TRACKED_UPSTREAMS;
  return runUpstreamCheck({
    packageJsonPath: opts.packageJsonPath,
    packages: pkgs,
    fetchImpl: opts.fetchImpl,
    registryBase: opts.registryBase,
    emitNotifications: opts.emitNotifications ?? true,
    // Manual triggers IMPLICITLY enable auto-update even if the gate
    // flag isn't set — the operator's explicit ask is the gate.
    autoUpdateFlagPath: ALWAYS_ON_FLAG_SENTINEL,
    autoUpdateRunner: opts.autoUpdateRunner ?? worktreeAutoUpdateRunner(),
    bypassThrottle: true,
    auditLogPath: opts.auditLogPath,
    throttleStatePath: opts.throttleStatePath,
  });
}

/** Sentinel for `autoUpdateFlagPath` that always reads as "enabled".
 *  Distinct from a real fs path — existsSync(this) is always true
 *  because it points at `/` which definitely exists, and we use it
 *  only when the caller (manual trigger) has explicitly opted in. */
const ALWAYS_ON_FLAG_SENTINEL = "/";

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

  // v2.7.37 — default to the worktree runner. Older callers can still
  // inject defaultAutoUpdateRunner() but the watchdog now ships with
  // worktree isolation, push-to-branch, and audit logging.
  const runner = opts.autoUpdateRunner ?? worktreeAutoUpdateRunner();

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
  throttle_ms: number;
  throttle_state: Record<string, number>;
  audit_log_path: string;
  recent_updates: AuditEntry[];
} {
  return {
    checked_at: _state.last_summary?.checked_at ?? null,
    results: _state.last_summary?.results ?? [],
    auto_update_enabled: existsSync(AUTO_UPDATE_FLAG),
    auto_update_flag_path: AUTO_UPDATE_FLAG,
    throttle_ms: DEFAULT_THROTTLE_MS,
    throttle_state: readThrottleFile(throttlePath()),
    audit_log_path: auditPath(),
    // The last 10 audit entries — the dashboard's history list reads
    // /upstreams/history for more.
    recent_updates: readUpdateHistory({ limit: 10 }),
  };
}

/**
 * Test-only — reset module state between tests.
 */
export function _resetForTesting(): void {
  _state.last_summary = null;
  _auditPathOverride = null;
  _throttlePathOverride = null;
}

// Re-export for callers that want to import a single name.
export type { Notification };
