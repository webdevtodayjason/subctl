# Radar

The rate-limit awareness layer. Originally a separate project named `claude-dispatch-radar`; now part of `subctl`.

This document explains why naive rate-limit reporting lies to you, what signals `subctl` actually tracks, and how the `/dispatch-check` verdict is computed.

---

## The 6%-mystery

You open Claude Code, run `/usage`, and see "6% of context used". You fire off another agent. You get rate-limited.

Why? Because `/usage` reports **context window usage**, not rate-limit headroom. Those are different things. Context % tells you how full the current conversation transcript is. It says nothing about how many requests you've sent in the last minute, how many tokens you've burned in the last hour, or how close you are to the daily cap.

`/usage` was never wrong — it just answered a different question than the one you were asking.

## The three constraints

Claude's API enforces three independent limits. Hitting any one of them rate-limits you, regardless of the other two:

| Constraint | Window     | What you do that hits it                          |
|------------|------------|---------------------------------------------------|
| **RPM**    | per minute | Many small requests in quick succession.          |
| **TPM**    | per minute | Long prompts / large transcripts on each turn.    |
| **Daily**  | rolling 24h| Sustained heavy use across the day.               |

Every server response includes headers describing remaining capacity per constraint. `subctl` does not call the API to read these — it reads them from local transcripts that already captured them.

---

## The five signals subctl tracks

| Signal              | Source                                                  | What it tells you                                  |
|---------------------|---------------------------------------------------------|----------------------------------------------------|
| Parallel sessions   | Count of live `claude` processes by config dir          | How much load you have *in flight right now*.      |
| Session age         | mtime of the active transcript                          | Long sessions tend to have large transcripts → high TPM. |
| Ctx %               | Token count parsed from transcript                      | Context window pressure (the only thing `/usage` shows). |
| RL hits today       | Count of `rate_limit_error` / `overloaded_error` literals in today's transcripts | Empirical evidence the API said no today. |
| Branch state        | `git status --porcelain` of cwd                         | Are you safe to crash the agent? Dirty state ≠ safe. |

### Threshold table

| Signal              | 🟢 Green | 🟡 Yellow | 🟠 Orange | 🔴 Red    |
|---------------------|---------|-----------|-----------|-----------|
| Parallel sessions   | 1       | 2–3       | —         | ≥4        |
| Session age         | <2h     | 2–6h      | —         | ≥6h       |
| Ctx %               | <30     | 30–60     | 60–80     | ≥80       |
| RL hits today       | 0       | 1–2       | —         | ≥3        |

These thresholds are configurable in `~/.config/subctl/accounts.conf` under a `[radar]` section if you want to tune them.

---

## The Stop hook

`subctl install` registers a Stop hook for the Claude provider at `~/.claude/hooks/subctl-stop.sh`. Every time a Claude Code session ends, the hook scans the transcript for rate-limit and overloaded errors.

**Important: the regex is tight.** It matches the JSON literals:

```
"type":"rate_limit_error"
"type":"overloaded_error"
```

It does **not** match bare `429` or `529` numeric codes. Why? Because `429` and `529` show up in transcripts for plenty of reasons that aren't actual rate limits — code snippets, error messages from other APIs, user-pasted log lines, even the literal string "Error 429" in documentation a user pasted in. Matching on the JSON literal is the only way to know it was a real rate-limit response from the Anthropic API.

The hook increments a counter at `~/.config/subctl/state/rl-today.<provider>.<alias>` and that counter feeds the `⚠ N RL today` segment of the statusline.

---

## `/dispatch-check`

`subctl install` drops a slash command at `~/.claude/commands/dispatch-check.md`. Inside Claude Code:

```
/dispatch-check
```

prints a verdict. The verdict logic:

1. Read the four numeric signals (parallel, age, ctx %, RL today).
2. Bucket each into green / yellow / orange / red using the threshold table above.
3. The verdict is the **worst** bucket among them, with one override:
   - If **RL hits today ≥ 1** *and* parallel sessions ≥ 2, verdict is forced to red. (Empirical evidence the API is unhappy + you're still piling on = stop.)

The verdict is one of:

| Verdict         | Meaning                                                            |
|-----------------|--------------------------------------------------------------------|
| 🟢 Dispatch     | All signals green. Safe to fire off another agent.                 |
| 🟡 Caution      | Mixed. Likely fine but watch the next response.                    |
| 🟠 Slow down    | High ctx pressure. Compact, summarize, or split work before firing.|
| 🔴 Hold         | Stop. Either RL evidence or stacked load. Wait or use another account. |

The output also includes the per-signal breakdown so you can see *which* signal triggered the verdict.

---

## Reading the dashboard

The dashboard at `localhost:8787` shows the same signals as a live grid: one card per configured account, color-coded by verdict, with the per-signal numbers visible. When the Stop hook increments an RL counter, the dashboard's WebSocket pushes the update; the card flips to red without a reload.

If you keep the dashboard as your browser's new-tab page (see [service.md](service.md)), every new tab you open is a glance at your radar.
