---
name: node-conventions
description: >-
  Node.js / Bun / TypeScript house style for subctl projects — runtime
  choice, imports, naming, errors, async patterns, testing.

  Load this skill whenever a worker is touching `.ts`, `.tsx`, `.js`, or
  `.mjs` files in a subctl-managed project. Use it instead of guessing the
  conventions from the surrounding code (the surrounding code may itself be
  drift). Defaults documented here are the operator's preferences as
  expressed across the v2.7.x release wave.
---

# Node Conventions

Default ecosystem skill for Node-flavored work in subctl projects. These are
the conventions the v2.7.x wave shipped against; treat them as the defaults
unless a project's local CLAUDE.md overrides.

---

## 1. Runtime: Bun, not Node

Subctl is a Bun project. New code:

- Uses `bun` as the runtime, `bun:sqlite` for SQLite, `bun:test` for tests
- Uses `Bun.spawn` for subprocess (not `child_process`)
- Uses `Bun.file()` for file IO (not `fs.promises`) where it improves
  readability
- Uses `Bun.serve()` for HTTP servers (not Express / Fastify) where the
  project already uses it

Exception: if a file already imports from `node:*` modules, match its style
unless you're rewriting the whole file. Don't half-convert.

Package install: `bun install`. Lockfile: `bun.lock`. Do not commit
`package-lock.json` or `pnpm-lock.yaml` to a Bun project.

---

## 2. TypeScript

### Strict mode

`tsconfig.json` has `"strict": true`. Never disable strict checks
file-by-file. If you need an `any`, write `// eslint-disable-next-line` (or
the Bun equivalent) with a one-line reason. `any` without justification fails
review.

### Imports

- ES module style: `import { foo } from "./bar"`
- No file extension in import paths for `.ts` files
- Relative imports use `./` and `../`. Path aliases (`@/components/...`) are
  used only where `tsconfig.json` already declares them. Don't introduce new
  ones in a single-file PR.
- One blank line between import groups: external packages, internal modules,
  type-only imports
- `import type { … }` for type-only imports — Bun strips them at build time

### Types

- Prefer `type` over `interface` unless you specifically need declaration
  merging or class-shape contracts
- Inline anonymous types are fine for return-type clarity; named types when
  reused
- Discriminated unions (`type Foo = { kind: "a"; … } | { kind: "b"; … }`)
  over loose objects with optional fields
- `unknown` over `any` when accepting untrusted input; narrow with type guards
  before use

### Naming

- `camelCase` — variables, functions, parameters, instance methods
- `PascalCase` — types, classes, React components
- `SCREAMING_SNAKE` — environment variables, true constants (rare)
- `kebab-case` — file names, except React components (which match the
  exported component name)
- Tests: `<module>.test.ts` next to the module, or under `__tests__/`
  subdirectory if the module folder has multiple tests

---

## 3. Error handling

### Throw `Error`, not strings

```typescript
// no
throw "config missing"
// yes
throw new Error("config missing: ~/.config/subctl/policy.json")
```

### Errors are values at the boundary

Functions that can fail in expected ways return a discriminated result
rather than throwing — especially anything called from the master agent's
tool loop or a dashboard route handler:

```typescript
type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export function resolveSecret(key: string): Result<string> {
  // ...
}
```

Throws are reserved for **programmer errors** (preconditions, invariants).
Expected failures are `{ ok: false, error }`.

### No silent catches

```typescript
// no
try { ... } catch { /* whatever */ }
// yes
try { ... } catch (err) {
  console.error(`[scope] operation failed: ${err}`)
  return { ok: false, error: String(err) }
}
```

Logging the error with a `[scope]` prefix lets the operator find it in
`master.log` later. Silent catches eat debugging time.

---

## 4. Async patterns

- `async`/`await` over raw promise chains
- One `Promise.all` per batch when calls are independent. Loops of `await`
  inside a `for` are usually wrong unless ordering matters.
- `AbortSignal` for any operation that can outlive its caller — HTTP fetches,
  long-running subprocesses, watcher polls
- No `process.nextTick`, no `setImmediate` for sequencing — use proper await
  points

### Subprocess (Bun.spawn)

Always pass argv as an array; never as a string. No shell interpolation:

```typescript
// no — shell-interpreted, injection risk
Bun.spawn(["sh", "-c", `op read ${ref}`])
// yes — argv-passed, safe
Bun.spawn(["op", "read", ref])
```

Capture stdout/stderr to buffers, not stream to the parent process, unless
you're intentionally proxying.

---

## 5. Logging

`console.log` for stdout, `console.error` for stderr. No log libraries
unless the project already uses one.

Tag every log line with a scope prefix in brackets:

```typescript
console.log("[secrets] cache hit", { key, age_ms: 42 })
console.error("[secrets] op CLI not found in PATH")
```

The dashboard's Live Logs view filters on these prefixes. Lines without a
prefix are noise.

Sensitive values (secrets, tokens, op:// refs to specific items) never appear
in logs. Use a redaction helper if the value comes from operator input.

---

## 6. HTTP route handlers (master daemon style)

Master HTTP routes live in `components/master/server.ts`. The shape every
new route follows:

```typescript
if (url.pathname === "/secrets/test" && req.method === "POST") {
  const body = await req.json().catch(() => ({}))
  const key = typeof body.key === "string" ? body.key : null
  if (!key) {
    return jsonResponse({ ok: false, error: "missing key" }, 400)
  }
  const result = await testSecret(key)
  return jsonResponse({ ok: true, ...result })
}
```

- Validate inputs explicitly; don't trust shape
- Return `{ ok: true, ... }` or `{ ok: false, error }` — the dashboard
  expects this shape
- 4xx for client errors, 5xx for server errors, no `throw` inside the route
  handler

---

## 7. Tests

`bun:test` syntax. One test file per module being tested:

```typescript
import { describe, test, expect } from "bun:test"
import { resolveSecret } from "../secrets"

describe("resolveSecret", () => {
  test("returns env var when set", () => {
    process.env.FOO = "bar"
    expect(resolveSecret("foo")).toEqual({ ok: true, value: "bar" })
  })
})
```

- Test files: `<module>.test.ts` adjacent to the module, or under
  `__tests__/`
- Tests are deterministic — no time, no random, no network unless mocked
- Setup/teardown via `beforeEach` / `afterEach`; never via module-level
  side effects
- Test names: `test("returns X when Y")` — describe the contract, not the
  implementation

### What to test

- Public API surface — exports of the module, HTTP route shapes, CLI
  arguments
- Error paths — every `{ ok: false, error }` branch has a test
- Edge cases — empty input, malformed input, missing files

Do NOT test:

- Internal implementation details (private helpers)
- Third-party libraries (assume they work)
- TypeScript types (the compiler does that)

---

## 8. File layout

```
components/
  <scope>/
    server.ts             # HTTP route additions (if relevant)
    <module>.ts           # core module
    __tests__/
      <module>.test.ts    # adjacent test
    README.md             # short overview if the scope is non-obvious
```

Don't create new top-level directories without a reason. The repo's layout
is load-bearing for the master daemon's tool-discovery logic.

---

## 9. Commit messages

Conventional commits, scope-prefixed:

```
feat(master): v2.7.31 1Password Service Accounts (multi-backend resolution)
fix(dashboard): v2.7.21 watchdog reconciliation race
test(eval): v2.7.30 add eval coverage for v2.7.18 through v2.7.24
docs(master): clarify Tier 3 substrate decision
```

- Past-tense imperative ("add", "fix", "refactor")
- Include the version when the commit is part of a release
- One change per commit (one PR may have multiple commits)
- Co-author trailer added by the operator's tooling — don't add it manually
  unless committing standalone

---

## 10. What this skill does NOT cover

- React / Next.js specifics — covered by `expert-react-typescript` agent
  definition
- Python — covered by `python-conventions`
- Rust — covered by `rust-conventions`
- Project-specific layout (subctl vs holace vs callscrub) — read the
  project's CLAUDE.md
