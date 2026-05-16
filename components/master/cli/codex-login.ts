#!/usr/bin/env bun
// components/master/cli/codex-login.ts
//
// CLI entry point for `subctl auth openai-codex <alias>`. Runs the
// device-code OAuth flow in-process (no dependency on the external
// `codex` CLI), prints the verification URL + user code to stdout for
// the operator to enter at https://auth.openai.com/codex/device, polls
// the auth backend, and writes the resulting tokens atomically to
// <configDir>/auth.json (mode 0o600).
//
// Designed to be invoked from providers/openai-codex/auth.sh:
//   bun run components/master/cli/codex-login.ts <alias> <configDir> [<email>]
//
// Exit codes:
//   0  success — auth.json written
//   1  unexpected error (network, server, etc.) — message on stderr
//   2  usage error — wrong args
//   3  operator cancelled (SIGINT during polling)

import {
  completeCodexLogin,
  type DeviceCodePrompt,
} from "../codex-oauth.ts";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

function usageDie(): never {
  console.error("usage: bun run codex-login.ts <alias> <configDir> [<email>]");
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

  // SIGINT handler so Ctrl-C during the 15-min poll wait gives a clean exit.
  let cancelled = false;
  const onSigint = (): void => {
    cancelled = true;
    console.error("\n[codex-login] cancelled by operator");
    process.exit(3);
  };
  process.on("SIGINT", onSigint);

  console.error(`[codex-login] alias=${alias} configDir=${configDir}`);

  try {
    const result = await completeCodexLogin({
      alias,
      configDir,
      email: email || undefined,
      onVerification: (prompt: DeviceCodePrompt) => {
        // ANSI colour: cyan-ish to make the URL + code stand out.
        const ESC = "\x1b[";
        const BOLD = `${ESC}1m`;
        const CYAN = `${ESC}96m`;
        const RESET = `${ESC}0m`;
        console.log("");
        console.log("To finish signing in:");
        console.log("");
        console.log(`  1. Open this URL in your browser:`);
        console.log(`     ${BOLD}${CYAN}${prompt.verificationUrl}${RESET}`);
        console.log("");
        console.log(`  2. Enter this code:`);
        console.log(`     ${BOLD}${CYAN}${prompt.userCode}${RESET}`);
        console.log("");
        console.log(
          `Waiting for sign-in… (this prompt expires in ${Math.floor(prompt.expiresInMs / 60_000)} min — press Ctrl-C to cancel)`,
        );
      },
      onProgress: (message: string) => {
        console.error(`[codex-login] ${message}`);
      },
    });

    if (cancelled) return;

    console.log("");
    console.log(`✓ signed in. tokens written to ${result.authPath} (mode 0o600)`);
    console.log(
      `  expires at ${new Date(result.expires_at_ms).toISOString()} — ` +
        "subctl master refreshes automatically when the token is near expiry.",
    );
    if (result.chatgpt_account_id) {
      console.log(`  chatgpt account: ${result.chatgpt_account_id}`);
    }
  } catch (err) {
    console.error(`[codex-login] FAILED: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    process.off("SIGINT", onSigint);
  }
}

void main();
