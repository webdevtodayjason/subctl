---
description: Pre-dispatch readiness check — should I dispatch this wave?
allowed-tools: Bash(bash:*)
---

Run the dispatch readiness check and present its output verbatim:

```bash
bash ~/.claude/scripts/dispatch-check.sh
```

After the verdict prints:
- If **🔴 STOP**: advise the user not to dispatch and name the red signals.
- If **🟡 HOLD**: summarize the yellows and ask whether to proceed anyway.
- If **🟢 GO**: confirm clear to dispatch.
