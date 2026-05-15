# `feat/ctxpin-dedup-and-models-cache` — Live Test Recipes

**Operator-facing.** Two independent fixes that landed on the same branch.
Both can be run without disturbing the operator's chat session — the master
restart in test 1 is brief (<5s) and master's transcript persists across
restarts.

There are **two independent fixes**:

1. **Master `ctx-pin` dedup** — skip the reviewer pin when reviewer
   `provider+model+host` equals supervisor's, preventing LM Studio from
   spawning a `:2` shadow instance of the same model when ctx sizes differ
   between roles.
2. **Dashboard server-side cache for LM Studio `/api/v0/models`** — 30s
   TTL with in-flight coalescing, plus a `POST /api/models/refresh` route
   to force a bust on demand.

No operator config changes needed before running. The fixes activate as
soon as master / dashboard are restarted.

---

## Pre-test snapshot

```bash
# Snapshot LM Studio's currently loaded models BEFORE running anything.
curl -sS http://127.0.0.1:1234/api/v0/models \
  | python3 -m json.tool > /tmp/preTest-lmstudio-models.json
echo "loaded ids before:"
python3 -c "
import json
d = json.load(open('/tmp/preTest-lmstudio-models.json'))
for m in d.get('data', []):
    if m.get('state') == 'loaded':
        print(f'  {m[\"id\"]} ctx={m.get(\"loaded_context_length\")}')
"
```

---

## Test 1 — Master `ctx-pin` dedup

**Goal:** confirm that when reviewer and supervisor resolve to the same
`provider/model/host` triple in `providers.json`, master only fires ONE
ctx-pin call at boot, and LM Studio loads exactly one instance of that
model (no `:2` suffix).

**Precondition:** `providers.models.reviewer` and
`providers.models.supervisor` in `~/.config/subctl/master/providers.json`
point at the same local model. Operator's current config typically does
this with `qwen/qwen3.6-27b` on `http://localhost:1234/v1`. If both roles
already point at different models the dedup branch never triggers and the
test isn't applicable — the negative confirmation is just "no SKIPPED log
line appeared, and that's correct".

**Stage and verify.**

```bash
# 1. Restart master to re-run the boot ctx-pin loop.
launchctl kickstart -k gui/$UID/com.subctl.master
sleep 5

# 2. Verify only one qwen3.6-27b instance is loaded (no :2 suffix).
curl -sS http://127.0.0.1:1234/api/v0/models | python3 -c "
import json, sys
d = json.load(sys.stdin)
qwen = [m for m in d['data'] if m.get('id','').startswith('qwen/qwen3.6-27b')]
print(f'qwen instances loaded: {len(qwen)}')
for m in qwen:
    print(f'  {m[\"id\"]} ctx={m.get(\"loaded_context_length\")} state={m.get(\"state\")}')
"
# Expected: exactly ONE entry, no id ending in ':2'.

# 3. Verify master logged the dedup skip.
grep 'ctx-pin reviewer: SKIPPED' ~/Library/Logs/subctl/master.log | tail -3
# Expected: at least one line ending with
# "[master] ctx-pin reviewer: SKIPPED — same model+host as supervisor (avoids LM Studio :2 instance)"

# 4. Verify supervisor pin still fired and succeeded.
grep '\[master\] ctx-pin supervisor' ~/Library/Logs/subctl/master.log | tail -2
# Expected: line like "[master] ctx-pin supervisor: <detail>" with no FAILED.
```

**Negative case (different models).** If `providers.models.reviewer.model`
is different from `supervisor.model`, both pins should fire and the
SKIPPED line should NOT appear. Test by inspecting current config:

```bash
python3 -c "
import json
p = json.load(open('$HOME/.config/subctl/master/providers.json'))
s = p['models']['supervisor']
r = p['models'].get('reviewer')
print(f'supervisor: {s[\"provider\"]}/{s[\"model\"]} @ {s.get(\"host\",\"-\")}')
if r: print(f'reviewer:   {r[\"provider\"]}/{r[\"model\"]} @ {r.get(\"host\",\"-\")}')
print('dedup branch active:', bool(r and s['provider']==r['provider'] and s['model']==r['model'] and s.get('host','')==r.get('host','')))
"
```

---

## Test 2 — Dashboard cache + refresh

**Goal:** confirm that 10 concurrent hits to `/api/providers` result in at
MOST one upstream `GET /api/v0/models` to LM Studio, AND that
`POST /api/models/refresh` forces a fresh upstream fetch.

```bash
# 1. Restart dashboard to load the cache helper.
launchctl kickstart -k gui/$UID/com.subctl.dashboard
sleep 4
curl -sS http://127.0.0.1:8787/api/version | python3 -m json.tool

# 2. Tail LM Studio's server log so you can count upstream hits.
#    (Adjust path if LM Studio is set to log elsewhere.)
#    Run this in a separate tmux pane:
tail -F "$HOME/.lmstudio/server-logs/latest.log" 2>/dev/null \
  || tail -F "$HOME/.cache/lm-studio/server.log" 2>/dev/null \
  || echo "NOTE: locate LM Studio's server log manually — UI: Developer → Server → Logs"

# 3. Hammer /api/providers from 10 concurrent curl invocations.
for i in {1..10}; do
  curl -sS -o /dev/null http://127.0.0.1:8787/api/providers &
done
wait
# Expected in LM Studio log: ONE GET /api/v0/models in that burst (not 10).

# 4. Hammer /api/models from another 10 concurrent invocations.
for i in {1..10}; do
  curl -sS -o /dev/null http://127.0.0.1:8787/api/models &
done
wait
# Expected: ZERO additional upstream hits (still within 30s of step 3).

# 5. Force-bust the cache.
curl -sS -X POST http://127.0.0.1:8787/api/models/refresh \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('ok:', d.get('ok'))
print('refreshed:', d.get('refreshed'))
print('total:', d.get('total'))
print('loaded_count:', d.get('loaded_count'))
"
# Expected: ok=True, refreshed=True. LM Studio log shows ONE new
# GET /api/v0/models (the explicit refresh).

# 6. Wait 31s, then re-hit /api/models. Expect ONE upstream call
#    (TTL expired) on the FIRST request, no further calls within 30s.
sleep 31
curl -sS -o /dev/null http://127.0.0.1:8787/api/models
# LM Studio log: ONE new entry.
for i in {1..5}; do curl -sS -o /dev/null http://127.0.0.1:8787/api/models & done; wait
# LM Studio log: NO new entries (all 5 served from cache).
```

**Error-path sanity (optional — only if operator has time):**

```bash
# Simulate LM Studio being unreachable: temporarily stop the LM Studio
# server (Developer → Stop Server), then hit /api/models.
curl -sS http://127.0.0.1:8787/api/models | python3 -m json.tool
# Expected: { "ok": false, "kind": "unreachable", ... } — error is NOT
# cached (next call retries upstream). Re-start LM Studio when done.
```

---

## Test 3 — Chat sanity (regression guard)

Make sure neither fix broke the chat path the operator is actively using.

```bash
# Send a one-shot prompt through the dashboard chat endpoint.
curl -sS -X POST http://127.0.0.1:8787/api/master/chat \
  -H 'Content-Type: application/json' \
  -d '{"text":"Reply with the literal string: CACHE-OK","source":"chat","attachments":[]}' \
  -w "\n[HTTP %{http_code}]\n"

# Wait for the agent to write the reply to the transcript.
sleep 15

# Pull the latest transcript entry.
curl -sS "http://127.0.0.1:8788/transcript?limit=1" | python3 -c "
import json, sys
d = json.load(sys.stdin)
msg = (d.get('messages') or [{}])[-1]
print('role:', msg.get('role'))
print('content:', msg.get('content'))
"
# Expected: role=assistant, content contains 'CACHE-OK'.
```

---

## Build / type gates

```bash
bun build --target=bun components/master/server.ts --outfile /tmp/master-build.js
bun build --target=bun dashboard/server.ts         --outfile /tmp/dashboard-build.js

grep -n 'sameLocalRoute\|ctx-pin reviewer: SKIPPED' components/master/server.ts
grep -n 'getLmstudioModels\|LMSTUDIO_CACHE_TTL_MS'  dashboard/server.ts
grep -n '/api/models/refresh'                       dashboard/server.ts
```

All four greps should return at least one match. Both bun builds should
exit 0 with no errors.

---

## Restore recipe (no-op — these fixes don't change operator config)

Neither fix touches `providers.json`, `profiles.json`, `accounts.conf`, or
any other operator-owned config. Reverting is a `git revert` of the two
commits and a `launchctl kickstart` of master + dashboard.
