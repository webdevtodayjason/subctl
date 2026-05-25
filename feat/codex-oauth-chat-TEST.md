# `feat/codex-oauth-chat` — Live Test Recipes

**Operator-facing.** Run these AFTER the operator has paused their chat-tab
session. Each recipe stages the test, validates the assertions, and reverts
to the prior known-good lmstudio/qwen state.

There are **two independent tests** on this branch:

1. **Codex OAuth chat dispatch** — verifies the new
   `components/master/openai-codex-auth.ts` plumbing.
2. **Supervisor-pick override sync** — verifies that the chat-tab dropdown
   apply now writes both providers.json AND profiles.json, so the pick
   survives a master restart.

Test 1 currently **needs operator action first** (re-auth — see
`feat/codex-oauth-chat-next-steps.md` for the exact `codex login`
command). Test 2 is independently runnable today.

---

## Pre-test snapshot (skip if you trust the current state)

```bash
# Capture the current "known-good" state before touching anything.
cp ~/.config/subctl/master/providers.json /tmp/preTest-providers.json
cp ~/.config/subctl/profiles.json          /tmp/preTest-profiles.json
echo "snapshot saved to /tmp/preTest-{providers,profiles}.json"
```

Restore recipe (used at the bottom of each test):

```bash
cp /tmp/preTest-providers.json ~/.config/subctl/master/providers.json
cp /tmp/preTest-profiles.json  ~/.config/subctl/profiles.json
launchctl kickstart -k gui/$UID/com.subctl.master
sleep 4 && curl -sS http://127.0.0.1:8788/health | jq -r '.ok, .active_profile'
```

---

## Test 1 — Codex OAuth chat dispatch (requires operator re-auth first)

**Precondition (operator):** Re-auth the `openai-jason` profile because both
tokens at `/Users/you/.codex-jason/auth.json` are server-invalidated (see
`next-steps.md`):

```bash
CODEX_HOME=/Users/you/.codex-jason codex login
# Verify
jq '.tokens | { has_at: (.access_token != null),
                has_rt: (.refresh_token != null) }' \
  /Users/you/.codex-jason/auth.json
```

**Stage configs.**

```bash
cat > /tmp/codex-test-providers.json <<'EOF'
{
  "models": {
    "router": { "provider": "mlx", "model": "lmstudio-community/gemma-4-E4B-it-MLX-4bit", "host": "http://localhost:8080" },
    "supervisor": { "provider": "openai-codex", "model": "gpt-5.5", "auth": "oauth" },
    "reviewer": { "provider": "lmstudio", "model": "qwen/qwen3.6-27b" },
    "embeddings": { "provider": "mlx", "model": "mlx-community/nomicai-modernbert-embed-base-bf16", "host": "http://localhost:8080" }
  },
  "escalate": { "provider": "openai-codex", "model": "gpt-5.2", "auth": "oauth" },
  "fallback": { "provider": "anthropic", "model": "claude-sonnet-4-6", "auth": "max-subscription" },
  "routing_policy": { "default": "supervisor", "code_review": "reviewer", "search_memory": "embeddings", "irreversible_decision": "escalate", "multi_repo_planning": "escalate" },
  "memory_budget_gb": { "target": 50, "ceiling": 80 }
}
EOF
cat > /tmp/codex-test-profiles.json <<'EOF'
{ "active": "chat",
  "profiles": {
    "chat":  { "supervisor": "gpt-5.5", "host": "https://chatgpt.com/backend-api" },
    "heavy": { "supervisor": "qwen/qwen3.6-35b-a3b", "host": "http://localhost:1234/v1" }
  }
}
EOF
cp ~/.config/subctl/master/providers.json ~/.config/subctl/master/providers.json.preTest
cp ~/.config/subctl/profiles.json          ~/.config/subctl/profiles.json.preTest
cp /tmp/codex-test-providers.json ~/.config/subctl/master/providers.json
cp /tmp/codex-test-profiles.json  ~/.config/subctl/profiles.json
launchctl kickstart -k gui/$UID/com.subctl.master
sleep 5
curl -sS http://127.0.0.1:8788/health | jq -r '.ok, .version, .active_profile'
# Expected: true / 2.8.6 / chat
```

**Run.**

```bash
TURN_RESP=$(curl -sS -X POST http://127.0.0.1:8787/api/master/chat \
  -H 'Content-Type: application/json' \
  -d '{"text":"Reply with exactly: CODEX-WORKING and nothing else."}')
echo "POST response: $TURN_RESP"
sleep 25
```

**Assertions.**

```bash
# A1. codex-auth resolver fired and decoded a token from /Users/you/.codex-jason.
grep '\[codex-auth\]' ~/Library/Logs/subctl/master.log | tail -3
# Expected: a line like:
#   [codex-auth] using access_token from /Users/you/.codex-jason (account=210e4eee-..., exp_in_s=NNNNN)

# A2. Latency log shows BOTH first_token AND last_token at reasonable cloud
# timings (>500ms, <60000ms). first_token MUST be present — that was the
# missing signal pre-fix.
grep '\[latency\] turn=.*stage=' ~/Library/Logs/subctl/master.log | tail -10
# Expected (one turn):
#   stage=process_start ms=0
#   stage=compose_prompt_done ms=NN
#   stage=llm_call_start ms=NN
#   stage=first_token ms=NNN     ← KEY: must be present
#   stage=last_token  ms=NNN
#   stage=turn_complete ms=NNN

# A3. Transcript last assistant message has text content with "CODEX-WORKING"
# and stopReason="stop" (NOT "error").
curl -sS 'http://127.0.0.1:8788/transcript?limit=2' \
  | jq '.messages[-1] | { role, stopReason, errorMessage, text: (.content[]? | select(.type=="text") | .text) }'
# Expected:
#   { "role": "assistant", "stopReason": "stop", "text": "CODEX-WORKING" }
```

**Pass criteria (all three must hold):**
- A1: codex-auth log line present (proves my resolver fired)
- A2: `first_token` stage present at reasonable timing (proves pi-ai
  produced text deltas, not just an error event)
- A3: assistant content contains "CODEX-WORKING" and stopReason="stop"

**Revert (regardless of pass/fail):**

```bash
cp ~/.config/subctl/master/providers.json.preTest ~/.config/subctl/master/providers.json
cp ~/.config/subctl/profiles.json.preTest          ~/.config/subctl/profiles.json
rm -f  ~/.config/subctl/master/providers.json.preTest ~/.config/subctl/profiles.json.preTest
launchctl kickstart -k gui/$UID/com.subctl.master
sleep 4
curl -sS http://127.0.0.1:8788/health | jq -r '.ok, .active_profile'
```

---

## Test 2 — Supervisor-pick override sync (NO precondition; runnable today)

This test validates the scope-addendum fix without needing Codex credentials.
It exercises the dashboard's `POST /api/master/supervisor` write of
profiles.json and verifies the operator's pick survives a master restart.

**Pre-test.** Capture the known-good state.

```bash
cp ~/.config/subctl/master/providers.json /tmp/preTest-providers.json
cp ~/.config/subctl/profiles.json          /tmp/preTest-profiles.json
```

**Step 1.** Force profiles.json into a deliberately-stale state to prove the
sync handles it.

```bash
cat > ~/.config/subctl/profiles.json <<'EOF'
{ "active": "chat",
  "profiles": {
    "chat":  { "supervisor": "this/should/be/overwritten", "host": "http://stale.example/v1" },
    "heavy": { "supervisor": "qwen/qwen3.6-35b-a3b", "host": "http://localhost:1234/v1" }
  }
}
EOF
```

**Step 2.** Hit the dashboard endpoint as the chat dropdown does. Pick an
arbitrary local model — say lmstudio/qwen3.6-27b — so the test doesn't
depend on Codex auth state.

```bash
DASH_PORT="${SUBCTL_DASHBOARD_PORT:-8787}"
curl -sS -X POST "http://127.0.0.1:${DASH_PORT}/api/master/supervisor" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"lmstudio","model":"qwen/qwen3.6-27b"}' \
  | jq '.'
# Expected: { ok: true, previous: "...", new: "qwen/qwen3.6-27b",
#             message: "providers.json updated, profiles.json updated,
#                       master daemon restarted, ..." }
```

**Step 3.** Verify profiles.json was updated correctly.

```bash
jq '.profiles.chat' ~/.config/subctl/profiles.json
# Expected:
#   { "supervisor": "qwen/qwen3.6-27b",
#     "host": "http://localhost:1234/v1" }
# (Local provider with no body.host → default localhost:1234/v1.
#  The deliberately-stale "http://stale.example/v1" is GONE — this fix
#  refuses to perpetuate stale custom hosts across a provider switch.)
```

**Step 4.** Confirm master, after the auto-restart, is running the picked
model — NOT the stale value from before.

```bash
sleep 6
curl -sS http://127.0.0.1:8788/health | jq -r '.ok, .active_profile, .version'
grep '\[master\] profile=' ~/Library/Logs/subctl/master.log | tail -1
# Expected last boot line:
#   [master] profile=chat → supervisor=lmstudio/qwen/qwen3.6-27b
```

**Step 5.** Bonus — verify that switching to a CLOUD provider clears the
host correctly. (No actual cloud call; just structural.)

```bash
curl -sS -X POST "http://127.0.0.1:${DASH_PORT}/api/master/supervisor" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"anthropic","model":"claude-sonnet-4-6"}' \
  | jq '.'
sleep 4
jq '.profiles.chat' ~/.config/subctl/profiles.json
# Expected:
#   { "supervisor": "claude-sonnet-4-6", "host": "" }
# (Cloud provider → host emptied; master.buildModel falls back to the
#  provider's canonical baseURL.)
```

**Pass criteria.**

- Step 2 response includes `"profiles.json updated"` in the `message`
  field (NOT "profiles.json sync FAILED").
- Step 3: `profiles.json.profiles.chat.supervisor === "qwen/qwen3.6-27b"`
  and the previously-stale `"this/should/be/overwritten"` is gone.
- Step 4: master.log's `profile=chat → supervisor=…` line shows
  `lmstudio/qwen/qwen3.6-27b`, NOT the stale model.
- Step 5: `profiles.json.profiles.chat.host === ""` after the anthropic
  pick.

**Revert.**

```bash
cp /tmp/preTest-providers.json ~/.config/subctl/master/providers.json
cp /tmp/preTest-profiles.json  ~/.config/subctl/profiles.json
launchctl kickstart -k gui/$UID/com.subctl.master
sleep 4
curl -sS http://127.0.0.1:8788/health | jq -r '.ok, .active_profile'
grep '\[master\] profile=' ~/Library/Logs/subctl/master.log | tail -1
# Expected: ok=true, profile=chat, master.log line shows the pre-test model
```

---

## Why I'm leaving the live test to the orchestrator

The HALT message from team-lead noted the operator is actively in the chat
tab. Both tests above swap providers.json + profiles.json and kickstart
master, which breaks any in-flight chat session. Coordinate a 2-minute
pause with the operator before running.

Test 1 ALSO requires interactive re-auth (`codex login`) on the operator's
behalf — orchestrator should batch that with the test window, not as a
separate ask.
