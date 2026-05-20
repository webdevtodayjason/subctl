#!/usr/bin/env bun
// components/master/cli/xai-oauth-login.ts
//
// CLI entry point for `subctl auth xai-oauth <alias>`. Runs the
// PKCE-loopback OAuth flow in-process (no dependency on any external
// xAI CLI), prints the authorize URL for the operator to open in their
// browser, waits for the local callback, exchanges the code for tokens,
// and writes the resulting auth.json atomically (mode 0o600).
//
// Designed to be invoked from providers/xai-oauth/auth.sh:
//   bun run components/master/cli/xai-oauth-login.ts <alias> <configDir> [<email>]
//
// `configDir` here is the same accounts.conf field codex uses — the
// directory that will hold `auth.json`. Passed in by the dispatcher so
// the operator can have multi-tenant subctl installations even though
// xAI itself only ships one SuperGrok seat per user today.
//
// Exit codes:
//   0  success — auth.json written
//   1  unexpected error (network, xAI auth failure, etc.) — message on stderr
//   2  usage error — wrong args
//   3  operator cancelled (SIGINT during the wait for browser callback)

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  completeXaiOauthLogin,
  XAI_OAUTH_DOCS_URL,
} from "../xai-oauth.ts";

function usageDie(): never {
  console.error("usage: bun run xai-oauth-login.ts <alias> <configDir> [<email>]");
  process.exit(2);
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

async function main(): Promise<void> {
  const [aliasArg, configDirArg, emailArg] = process.argv.slice(2);
  if (!aliasArg || !configDirArg) usageDie();
  const alias = aliasArg.trim();
  const configDir = expandTilde(configDirArg.trim());
  const email = (emailArg ?? "").trim();

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  const authJsonPath = join(configDir, "auth.json");

  // SIGINT handler so Ctrl-C during the browser wait gives a clean exit.
  let cancelled = false;
  const onSigint = (): void => {
    cancelled = true;
    console.error("\n[xai-oauth-login] cancelled by operator");
    process.exit(3);
  };
  process.on("SIGINT", onSigint);

  console.error(`[xai-oauth-login] alias=${alias} configDir=${configDir}`);
  if (email) console.error(`[xai-oauth-login] email=${email}`);

  try {
    const result = await completeXaiOauthLogin({
      authJsonPath,
      alias,
      onAuthorizeUrl: async ({ authorizeUrl, redirectUri }) => {
        // ANSI colour: cyan-ish so the URL stands out.
        const ESC = "\x1b[";
        const BOLD = `${ESC}1m`;
        const CYAN = `${ESC}96m`;
        const DIM = `${ESC}2m`;
        const RESET = `${ESC}0m`;
        console.log("");
        console.log("To finish signing in to xAI Grok (SuperGrok):");
        console.log("");
        console.log("  1. Open this URL in your browser:");
        console.log(`     ${BOLD}${CYAN}${authorizeUrl}${RESET}`);
        console.log("");
        console.log("  2. Approve the consent screen at accounts.x.ai.");
        console.log("");
        console.log(`  Waiting for callback on ${DIM}${redirectUri}${RESET}`);
        console.log(`  Docs: ${DIM}${XAI_OAUTH_DOCS_URL}${RESET}`);
        console.log("  Press Ctrl-C to cancel.");
      },
    });

    if (cancelled) return;

    console.log("");
    console.log(`✓ signed in. tokens written to ${result.authPath} (mode 0o600)`);
    console.log(`  base_url: ${result.base_url}`);
    console.log(
      `  last_refresh: ${result.last_refresh} — subctl master refreshes ` +
        "automatically when the JWT is near expiry.",
    );
  } catch (err) {
    console.error(`[xai-oauth-login] FAILED: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    process.off("SIGINT", onSigint);
  }
}

if (import.meta.main) {
  void main();
}
