// subctl-policy-check
//
// Go-compiled hot path for the policy `PreToolUse` hook. PR 8 of the subctl
// v2.7.0 policy engine. Ports `components/master/tools/policy/check.ts` so
// the per-invocation latency budget (<50ms cold, <10ms warm) is achievable.
//
// Vector parity with the TS implementation is the hard contract: the shared
// `config/policy/test-vectors.toml` corpus must produce byte-identical
// decision + rule_path in both implementations. CI fails on divergence.

module github.com/subctl/subctl-policy-check

go 1.21

require github.com/BurntSushi/toml v1.4.0
