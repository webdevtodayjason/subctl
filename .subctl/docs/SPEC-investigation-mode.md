# SPEC: Investigation Mode for subCTL

## Status
Draft updated from operator feedback, 2026-05-18.

## Intent
Do not merely mimic Hermes' surface. Learn from the operating pattern and apply it in subCTL's own architecture.

The desired change is behavioural and product-level:

- treat non-trivial evaluation prompts as jobs, not casual questions
- make routing and work shape visible to the operator
- inspect primary sources before recommending
- show enough receipts that the operator can judge depth
- preserve Evy's short coordination style for simple desk questions

This is not about copying emoji labels or copying Hermes internals. It is about adopting the useful loop: route, plan, inspect, verify, recommend.

## Trigger
Use investigation mode for non-trivial evaluation prompts, especially:

- GitHub repository links
- vendor or dependency evaluation
- “look into this”
- “should we incorporate this?”
- browser/agent/security tooling proposals
- architecture comparison requests

## Operator-visible pattern
The operator should see the work shape, not just the answer.

Recommended visible events:

```text
route: repo/vendor investigation
plan: N tasks
web: fetched product/docs page
repo: inspected owner/name@commit
read: README / package metadata / Dockerfile / core source
search: risky patterns / license / network binding / auto-update
verify: evidence-backed recommendation
```

Icons are optional. The important pattern is visible routing, planned work, evidence reads, risk search, and verified recommendation.

## Minimum investigation checklist
For a repo/vendor adoption ask, inspect and report:

1. Identity
   - repo owner/name
   - current commit inspected
   - release/package version where applicable
   - stars/forks/issues/PRs only if useful
   - project age and maintenance recency

2. Architecture
   - what it is
   - where the real value lives
   - open source vs opaque binary/model/service boundary
   - integration surface: API, CLI, CDP, SDK, plugin, container

3. Implementation evidence
   - README/docs
   - package files: pyproject, package.json, lockfiles where useful
   - Dockerfile/container entrypoints
   - core launch/server/provider code
   - config and environment variables
   - examples that map to subCTL/Hermes/Moltyverse usage

4. Risk search
   - subprocess/shell/eval/exec/dynamic import patterns
   - network binding defaults: 127.0.0.1 vs 0.0.0.0
   - auth defaults and exposed management ports
   - auto-update defaults
   - checksum/signature/attestation story
   - archive extraction/path traversal handling
   - dependency and binary download path

5. License and commercial fit
   - wrapper license
   - binary/model/data/service license if separate
   - redistribution clauses
   - SaaS/OEM/third-party-customer clauses
   - internal-use vs hosted-product implications

6. Verification plan
   - safe local smoke test
   - authorized target matrix
   - comparison against current baseline
   - resource usage and failure recovery
   - security guardrails

7. Recommendation
   - promising/not promising
   - maturity level
   - adoption risk
   - phased path: external/no-code pilot, formal provider/plugin, deeper product integration
   - explicit no-go/hard rules

## CloakBrowser-derived hard rules
If the target exposes CDP or a browser-control port:

- bind only to `127.0.0.1` by default
- never expose CDP to LAN/public internet without explicit operator approval
- prefer auth tokens when supported
- disable auto-update for reproducible tests unless explicitly enabled
- use dedicated cache/profile directories
- use only authorized browsing targets
- do not use for auth bypass, credential stuffing, automated account abuse, or ToS-hostile flows

## Behavioural requirements for Evy

### Desk-level behaviour
Evy should not answer vendor/repo incorporation requests from README claims alone. If no worker is dispatched, Evy should still fetch the site/repo, inspect available metadata, and label the result as a desk pass.

### Visible routing
For investigation tasks, Evy should briefly state the selected lane before doing the work, for example:

- `route: repo/vendor investigation`
- `route: browser automation risk review`
- `route: architecture-fit comparison`

This is not decorative. It tells the operator what kind of work is being done.

### Visible plan
For non-trivial investigations, Evy should expose a short plan or todo list before or during execution. The plan should be updated if the work changes.

### Evidence before recommendation
The final answer should distinguish:

- confirmed from source inspection
- claimed by project/vendor
- inferred by Evy
- not yet verified

## Worker-level behaviour
For full investigations, spawn or route to a research/code-inspection worker with this mandate:

- clone/fetch into a temp workdir
- inspect files listed above
- run static risk searches
- produce evidence-backed findings with file references
- avoid destructive commands
- do not run unknown binaries unless explicitly approved

## Product feature
Add an `investigation mode` affordance to subCTL/dashboard that can display:

- route/skills selected
- current todo list
- artifacts read
- searches performed
- final evidence-backed report

This mirrors the useful Hermes operator experience without copying Hermes internals blindly.

## Non-goals

- Do not make every answer verbose.
- Do not show fake work.
- Do not invent skill names that do not correspond to real routing or procedures.
- Do not copy Hermes UI details blindly.
- Do not treat README synthesis as investigation.
