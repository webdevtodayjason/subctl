# pi-coder prototype (spike, throwaway)

Companion code for `docs/spikes/picoder.md`. NOT product code. Demonstrates
that the four open questions of the v3.0 Initiative's Phase 5 spike have
concrete, runnable answers.

## What's here

| File | Purpose |
|---|---|
| `picoder-worker.ts` | The Bun worker. Reads HMAC-signed directives from a file, executes, writes inbox events. Reuses `components/master/trust-marker.ts` for verification. |
| `master-emit.ts` | Stand-in for Evy's `/api/orchestration/<team>/msg` route. Builds a signed directive and writes it to the worker's directives file. |
| `demo.sh` | End-to-end driver — boots the worker, sends a good directive, sends a tampered directive, prints inbox + classifier output. |

## Run it

```bash
cd docs/spikes/picoder-prototype
bash demo.sh
```

Last verified run (2026-05-23):
- ✅ Good directive: HMAC verified → progress + done events written.
- ✅ Tampered directive: HMAC verification FAILED → refused, error event written.
- ✅ `classifyWorkerReply` (the real one from `components/master/auto-nudge.ts`) classified the worker's pane text as `completed_idle` without modification.

## Cleanup

```bash
rm -rf /tmp/picoder-demo
```

The prototype writes nothing outside `/tmp/picoder-demo`.
