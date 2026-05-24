// components/evy/openai-codex-auth.ts
//
// v2.8.7 — OAuth (ChatGPT Pro subscription) credential plumbing for the
// `openai-codex` pi-ai provider.
//
// Why this file exists. The `openai-codex-responses` transport inside pi-ai
// expects `options.apiKey` to be the OAuth access_token (a JWT) issued by
// `https://auth.openai.com/oauth/token` and stored on disk by the official
// Codex CLI at `<CODEX_HOME>/auth.json`. Subctl's accounts.conf points the
// `openai-codex` provider at one of the operator's Codex profile dirs (e.g.
// `~/.codex-jason`). Master's pre-v2.8.7 `getApiKeyForProvider` returned
// `undefined` for `openai-codex` → pi-ai threw `"No API key for provider:
// openai-codex"` BEFORE pushing the stream `start` event → the agent loop
// emitted `agent_end` ~immediately → operator saw a 23ms `last_token` with no
// `first_token` and an empty assistant turn.
//
// What this file does (Path C — minimal, no refresh).
//   - `resolveActiveCodexConfigDir()` reads ~/.config/subctl/accounts.conf and
//     returns the first `openai-codex` row's `config_dir` (or `~/.codex` if
//     no row is configured). The accounts.conf pipe format is the same one
//     `lib/core.sh` parses — re-implemented here in TS to avoid shelling out
//     from a long-lived daemon.
//   - `readCodexAuth(configDir)` reads `<configDir>/auth.json` and validates
//     the shape pi-ai expects.
//   - `getCodexAccessToken()` ties them together and returns the JWT
//     access_token (NOT id_token — id_token has the wrong audience and would
//     401 against `https://chatgpt.com/backend-api`). If the token is past
//     `exp`, we log loudly and return undefined so pi-ai surfaces a
//     recognizable "no API key" error instead of pi-ai's Codex backend
//     emitting a generic 401 with no body.
//
// What this file deliberately does NOT do.
//   - OAuth refresh. The token rotates ~every 10 days; refresh-on-near-expiry
//     and refresh-on-401 are tracked as a follow-up. When the operator
//     re-runs `codex login` (or `subctl accounts use openai-jason`) the
//     auth.json is rewritten in-place and the next chat turn picks it up.
//   - Multi-account routing. The first accounts.conf row wins. Routing
//     between `openai-jason` and `openai-titanium` per turn is a separate
//     feature.
//   - Writing back to auth.json. Strictly read-only here. Anything that
//     mutates auth.json must do atomic write + chmod 0600.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteAuthFile,
  isAccessTokenExpiring,
  refreshCodexTokens,
  REFRESH_SKEW_SECONDS,
} from "./codex-oauth.ts";

const ACCOUNTS_CONF_DEFAULT = join(homedir(), ".config", "subctl", "accounts.conf");
const FALLBACK_CODEX_HOME = join(homedir(), ".codex");

// In-flight refresh tracker. Module-scope so multiple chat turns within
// the 5-min skew window don't each kick a refresh. Keyed by configDir
// (absolute path) so distinct accounts each get their own slot.
const _inFlightRefresh: Map<string, Promise<void>> = new Map();

// Pi-ai parses this JWT claim path to extract the chatgpt_account_id needed
// for the `chatgpt-account-id` header. We mirror it here for the expiry log
// only — we don't need the account_id ourselves, pi-ai does the decode.
const JWT_CLAIM_AUTH = "https://api.openai.com/auth";

// ---------------------------------------------------------------------------
// accounts.conf
// ---------------------------------------------------------------------------

export interface AccountRow {
  alias: string;
  provider: string;
  email: string;
  configDir: string;
  description: string;
}

/** Expand a leading `~` to $HOME. Mirrors `lib/core.sh`'s expansion. */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Parse a `key | value | …` pipe-delimited row. Returns null on malformed. */
function parseAccountRow(line: string): AccountRow | null {
  const stripped = line.replace(/^\s+|\s+$/g, "");
  if (!stripped || stripped.startsWith("#")) return null;
  const fields = stripped.split("|").map((s) => s.trim());
  if (fields.length < 4) return null;
  const [alias, provider, email, configDir, ...rest] = fields;
  if (!alias || !provider || !configDir) return null;
  return {
    alias,
    provider,
    email: email ?? "",
    configDir: expandTilde(configDir),
    description: rest.join(" | "),
  };
}

/** Parse the whole accounts.conf. Honors $SUBCTL_ACCOUNTS_CONF for tests. */
export function loadAccountsConf(path?: string): AccountRow[] {
  const target = path ?? process.env.SUBCTL_ACCOUNTS_CONF ?? ACCOUNTS_CONF_DEFAULT;
  if (!existsSync(target)) return [];
  let text: string;
  try {
    text = readFileSync(target, "utf8");
  } catch (err) {
    console.error(
      `[codex-auth] accounts.conf read failed at ${target}: ${(err as Error).message}`,
    );
    return [];
  }
  const rows: AccountRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const row = parseAccountRow(line);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Pick the active codex config_dir.
 *
 * Strategy: first accounts.conf row with provider === "openai-codex" wins.
 * If accounts.conf has no openai-codex row, fall back to `~/.codex` (the
 * Codex CLI's default per-user dir). Returns null only if neither path
 * resolves to a directory that exists. Logs the choice so the operator
 * can see in evy.log which profile is being used.
 */
export function resolveActiveCodexConfigDir(): string | null {
  const rows = loadAccountsConf();
  const match = rows.find((r) => r.provider === "openai-codex");
  if (match) return match.configDir;
  if (existsSync(FALLBACK_CODEX_HOME)) return FALLBACK_CODEX_HOME;
  return null;
}

// ---------------------------------------------------------------------------
// auth.json
// ---------------------------------------------------------------------------

export interface CodexTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

export interface CodexAuthJson {
  OPENAI_API_KEY?: string | null;
  tokens?: CodexTokens;
  last_refresh?: string;
}

/**
 * Read and JSON.parse `<configDir>/auth.json`. Returns null if the file is
 * missing, unreadable, or invalid JSON. Never throws.
 */
export function readCodexAuth(configDir: string): CodexAuthJson | null {
  const path = join(configDir, "auth.json");
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    console.error(
      `[codex-auth] auth.json read failed at ${path}: ${(err as Error).message}`,
    );
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as CodexAuthJson;
    }
    return null;
  } catch (err) {
    console.error(
      `[codex-auth] auth.json parse failed at ${path}: ${(err as Error).message}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// JWT inspection (for expiry + diagnostics only)
// ---------------------------------------------------------------------------

interface DecodedJwt {
  exp?: number;
  iat?: number;
  aud?: string | string[];
  chatgptAccountId?: string;
}

function decodeJwtPayload(token: string): DecodedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payloadB64 = parts[1];
  try {
    // base64url → base64
    const b64 = payloadB64!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const obj = JSON.parse(json) as Record<string, unknown>;
    const auth =
      (obj[JWT_CLAIM_AUTH] && typeof obj[JWT_CLAIM_AUTH] === "object")
        ? (obj[JWT_CLAIM_AUTH] as Record<string, unknown>)
        : undefined;
    return {
      exp: typeof obj.exp === "number" ? obj.exp : undefined,
      iat: typeof obj.iat === "number" ? obj.iat : undefined,
      aud: typeof obj.aud === "string" || Array.isArray(obj.aud)
        ? (obj.aud as string | string[])
        : undefined,
      chatgptAccountId:
        typeof auth?.chatgpt_account_id === "string"
          ? (auth.chatgpt_account_id as string)
          : undefined,
    };
  } catch {
    return null;
  }
}

/** Exposed for tests. */
export function _decodeJwtPayloadForTesting(token: string): DecodedJwt | null {
  return decodeJwtPayload(token);
}

// ---------------------------------------------------------------------------
// Main resolver — what server.ts wires into pi-agent-core's `getApiKey`.
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /** Override config_dir resolution for tests. */
  configDir?: string;
  /** Pretend `now` is this epoch-seconds (for tests). */
  now?: number;
}

/**
 * Resolve the OAuth access_token to hand pi-ai for the next codex API call.
 *
 * Returns undefined (NOT a sentinel string) when:
 *   - no openai-codex account is configured AND ~/.codex/auth.json is missing
 *   - auth.json is missing / malformed / has no tokens.access_token
 *   - the access_token JWT is past its `exp` claim
 *
 * Logs loudly in every failure branch so evy.log shows WHY the chat turn
 * is about to fail before pi-ai itself throws.
 */
export function getCodexAccessToken(opts: ResolveOptions = {}): string | undefined {
  const configDir = opts.configDir ?? resolveActiveCodexConfigDir();
  if (!configDir) {
    console.error(
      "[codex-auth] no openai-codex account configured in accounts.conf and " +
        "~/.codex/auth.json does not exist — chat turn will fail until the " +
        "operator runs `codex login` and registers an account",
    );
    return undefined;
  }
  const auth = readCodexAuth(configDir);
  if (!auth) {
    console.error(
      `[codex-auth] auth.json missing or unreadable in ${configDir} — ` +
        "operator may need to re-run `codex login` for this profile",
    );
    return undefined;
  }
  const token = auth.tokens?.access_token;
  if (!token) {
    console.error(
      `[codex-auth] auth.json in ${configDir} has no tokens.access_token — ` +
        "the file may be from an older Codex CLI; re-run `codex login`",
    );
    return undefined;
  }
  const payload = decodeJwtPayload(token);
  if (!payload) {
    // Pi-ai's `extractAccountId` will throw on the same input; surface the
    // diagnostic in evy.log so the operator doesn't see a generic
    // pi-ai error.
    console.error(
      `[codex-auth] tokens.access_token in ${configDir} is not a valid JWT — ` +
        "auth.json may be corrupted; re-run `codex login`",
    );
    return undefined;
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp <= now) {
    // v2.8.9 — Token is already past exp. We can't use it for THIS turn
    // (pi-ai's getApiKey is sync), but if we have a refresh_token, kick a
    // background refresh anyway so the operator's NEXT chat turn picks up
    // a freshly-minted token without them having to re-run any login flow.
    const refreshToken = auth.tokens?.refresh_token;
    if (refreshToken && !_inFlightRefresh.has(configDir)) {
      const cd = configDir;
      console.error(
        `[codex-auth] tokens.access_token in ${cd} is EXPIRED ` +
          `(exp=${payload.exp}, now=${now}) — kicking background refresh; ` +
          "current turn fails, retry your next message after a few seconds.",
      );
      const job = (async () => {
        try {
          const fresh = await refreshCodexTokens(refreshToken);
          const path = join(cd, "auth.json");
          const current = readCodexAuth(cd) ?? ({} as CodexAuthJson);
          const updated: CodexAuthJson = {
            ...current,
            tokens: {
              ...(current.tokens ?? {}),
              access_token: fresh.access_token,
              refresh_token: fresh.refresh_token,
            },
            last_refresh: new Date().toISOString(),
          };
          atomicWriteAuthFile(path, updated);
          console.error(`[codex-auth] post-expiry refresh succeeded for ${cd}`);
        } catch (err) {
          console.error(
            `[codex-auth] post-expiry refresh FAILED for ${cd}: ${(err as Error).message} — ` +
              "operator must re-run `subctl auth openai-codex <alias>` (or `codex login` on a configured profile)",
          );
        } finally {
          _inFlightRefresh.delete(cd);
        }
      })();
      _inFlightRefresh.set(configDir, job);
    } else {
      console.error(
        `[codex-auth] tokens.access_token in ${configDir} is EXPIRED ` +
          `(exp=${payload.exp}, now=${now}) and ${refreshToken ? "refresh is already in flight" : "no refresh_token in auth.json"} — ` +
          "chat turn will fail until operator runs login.",
      );
    }
    return undefined;
  }
  // v2.8.9 — Background refresh-on-near-expiry. When the access_token is
  // within REFRESH_SKEW_SECONDS of exp AND we have a refresh_token AND no
  // refresh is already in flight for this configDir, kick off a refresh in
  // the background. Return the still-valid current token for THIS turn;
  // next turn picks up the rotated token off disk.
  //
  // Synchronous-return contract is intentional: pi-agent-core's getApiKey
  // hook is sync, so we can't await the refresh inline. The 5-min skew
  // (REFRESH_SKEW_SECONDS) gives the background fetch a comfortable window
  // to land before the operator's current token actually expires.
  if (
    typeof payload.exp === "number" &&
    payload.exp - now < REFRESH_SKEW_SECONDS &&
    auth.tokens?.refresh_token &&
    !_inFlightRefresh.has(configDir)
  ) {
    const refreshToken = auth.tokens.refresh_token;
    const cd = configDir;
    console.error(
      `[codex-auth] token in ${cd} expires in ${payload.exp - now}s — ` +
        "kicking background refresh (current turn uses still-valid token)",
    );
    const job = (async () => {
      try {
        const fresh = await refreshCodexTokens(refreshToken);
        // Read-modify-write the auth.json. Re-read in case another process
        // touched it (unlikely but cheap).
        const path = join(cd, "auth.json");
        const current = readCodexAuth(cd) ?? ({} as CodexAuthJson);
        const updated: CodexAuthJson = {
          ...current,
          tokens: {
            ...(current.tokens ?? {}),
            access_token: fresh.access_token,
            refresh_token: fresh.refresh_token,
          },
          last_refresh: new Date().toISOString(),
        };
        atomicWriteAuthFile(path, updated);
        console.error(
          `[codex-auth] refresh succeeded for ${cd} — next turn uses new token`,
        );
      } catch (err) {
        console.error(
          `[codex-auth] background refresh FAILED for ${cd}: ${(err as Error).message} — ` +
            "current token still valid until exp; operator may need to re-run login if it actually expires",
        );
      } finally {
        _inFlightRefresh.delete(cd);
      }
    })();
    _inFlightRefresh.set(configDir, job);
  }
  console.error(
    `[codex-auth] using access_token from ${configDir} ` +
      `(account=${payload.chatgptAccountId ?? "?"}, ` +
      `exp_in_s=${typeof payload.exp === "number" ? payload.exp - now : "?"})`,
  );
  return token;
}
