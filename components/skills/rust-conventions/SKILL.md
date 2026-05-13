---
name: rust-conventions
description: >-
  Rust house style for subctl-adjacent work — cargo, clippy, rustfmt,
  error handling with `thiserror` / `anyhow`, async patterns with tokio,
  testing.

  Load this skill whenever a worker is touching `.rs` files. Subctl has a
  Rust component (the policy bash-gate kernel) and several adjacent projects
  use Rust for performance-sensitive paths. These are the defaults to apply
  when the project's local CLAUDE.md doesn't override.
scope: dev-team
loaded_by_default: []
created_at: "2026-05-10"
created_by: operator
---

# Rust Conventions

Default ecosystem skill for Rust-flavored work. The subctl policy gate's
performance-critical path was rewritten in Go; for any new performance work
where Go isn't a fit, Rust is the default. Argent-core's "rust spine" and
several adjacent agents (`argent-core-rust-spine`) are also Rust.

---

## 1. Tooling — cargo, clippy, rustfmt

Everything goes through `cargo`. No raw `rustc`.

```bash
cargo new --bin my-tool      # new binary crate
cargo new --lib my-lib       # new library crate
cargo build                  # debug build
cargo build --release        # release build
cargo run -- arg1 arg2       # run with args
cargo test                   # tests
cargo clippy -- -D warnings  # lint with warnings as errors
cargo fmt                    # format
cargo fmt --check            # check formatting without modifying
```

### Pre-commit checks

The standard pre-commit gate for any Rust commit:

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

If any of these fail, fix before committing. Don't disable clippy lints
without justification; `#[allow(...)]` annotations require a one-line
comment explaining why.

---

## 2. Edition and toolchain

Target Rust edition 2021 (2024 once stabilized in the operator's toolchain).
Pin the toolchain explicitly:

```toml
# rust-toolchain.toml
[toolchain]
channel = "1.83.0"          # whatever's current stable; pin, don't float
components = ["rustfmt", "clippy"]
```

Don't use `nightly` unless a specific feature requires it; if you must, isolate
nightly-only code behind a feature flag.

---

## 3. Cargo.toml hygiene

```toml
[package]
name = "my-tool"
version = "0.1.0"
edition = "2021"
rust-version = "1.83"
license = "MIT"

[dependencies]
anyhow = "1"
thiserror = "1"
serde = { version = "1", features = ["derive"] }
tokio = { version = "1", features = ["full"] }

[dev-dependencies]
assert_fs = "1"
proptest = "1"
```

- Pin major versions (`"1"`) for libraries; pin minor versions (`"1.83"`)
  for the toolchain
- Group `[dependencies]` and `[dev-dependencies]`; alphabetize within
- Use `features = [...]` instead of `default-features = false` + re-enabling
  unless you specifically need to trim
- One workspace per project; multiple crates under `members = [...]` for
  large projects

---

## 4. Error handling — `thiserror` for libs, `anyhow` for apps

**Library crate:** define typed errors with `thiserror`.

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ResolveError {
    #[error("backend unavailable: {0}")]
    BackendUnavailable(String),

    #[error("invalid key: {key}")]
    InvalidKey { key: String },

    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, ResolveError>;
```

**Binary crate / app glue:** use `anyhow::Result<T>` at the top level.

```rust
use anyhow::{Context, Result};

fn main() -> Result<()> {
    let cfg = load_config().context("loading config")?;
    run(cfg)?;
    Ok(())
}
```

The `.context("...")` calls form a breadcrumb trail when errors propagate.
Use them liberally — they're free at runtime and priceless when debugging.

### Never `unwrap()` or `expect()` in production paths

`unwrap` and `expect` are acceptable in:
- Tests
- Examples
- Initialization code that genuinely cannot fail (and you can prove it)

Everywhere else: propagate with `?` or handle explicitly. `expect("infallible")`
is a smell — if it's infallible, encode that in the type.

---

## 5. Async — tokio

When async is needed, tokio is the default runtime. Multi-threaded scheduler
for general work; current-thread for CLI utilities.

```rust
#[tokio::main]
async fn main() -> Result<()> {
    let client = reqwest::Client::new();
    let results = futures::future::join_all(
        urls.iter().map(|u| client.get(u).send())
    ).await;
    Ok(())
}
```

- One runtime per binary; never `block_on` from inside an async context
- `tokio::select!` for racing operations
- `tokio::time::timeout` for bounded waits — bare `.await` with no timeout
  is a smell on any external call
- Drop guards: structured concurrency via scopes (`tokio::task::spawn` +
  explicit `JoinHandle::abort` on shutdown) — no orphaned tasks

For non-async crates, prefer sync code. Don't drag tokio in for the sake of
"future-proofing."

---

## 6. Module structure

```
src/
  lib.rs              # public surface, re-exports
  config.rs           # one module per concept
  secrets/
    mod.rs            # module entry, re-exports
    backends.rs       # implementation details
    audit.rs
  bin/
    cli.rs            # binary entrypoint
tests/
  integration.rs      # cross-module tests
```

- One concept per module, not one type per file
- `pub use` re-exports in `lib.rs` / `mod.rs` define the crate's public
  surface
- Internal modules (`pub(crate)`) for things shared across the crate but
  not part of the public API

---

## 7. Naming

| Kind | Convention | Example |
|------|------------|---------|
| Module | `snake_case` | `mod secret_backends` |
| Function | `snake_case` | `fn resolve_secret` |
| Type / trait | `PascalCase` | `struct SecretBackend`, `trait Resolver` |
| Constant / static | `SCREAMING_SNAKE` | `const DEFAULT_TIMEOUT: Duration` |
| Lifetime | short lowercase | `'a`, `'src` |
| Generic | single uppercase or `PascalCase` | `T`, `K`, `Resolver` |
| Test fn | `snake_case`, `test_` prefix optional | `fn returns_value_when_set()` |

---

## 8. Logging — `tracing`, not `log`

```rust
use tracing::{info, warn, error, instrument};

#[instrument(skip(client))]
async fn resolve(client: &Client, key: &str) -> Result<String> {
    info!(key = %key, "resolving secret");
    let value = client.get(key).await
        .map_err(|e| { warn!(error = %e, "backend failed"); e })?;
    Ok(value)
}
```

- `tracing` over `log` — structured fields, spans, async-aware
- Use `info!`, `warn!`, `error!` — `debug!` and `trace!` for noise that's off
  by default
- Configure subscriber at the binary entrypoint, never in library code
- Same `[scope]` prefix convention if logs route through subctl:
  `info!(target: "secrets", "resolved {}", key)`

Sensitive values never appear in logs. Use `tracing::field::Empty` and fill
selectively, or annotate with `skip(...)` on `#[instrument]`.

---

## 9. Tests

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_env_var_when_set() {
        std::env::set_var("MY_KEY", "value");
        assert_eq!(resolve_secret("my_key").unwrap(), "value");
    }

    #[tokio::test]
    async fn async_path_works() {
        let result = fetch_one("http://localhost").await;
        assert!(result.is_err());
    }
}
```

- Unit tests in `#[cfg(test)] mod tests` next to the code
- Integration tests in `tests/*.rs` — one file per scenario
- `#[tokio::test]` for async tests; vanilla `#[test]` for sync
- `assert!`, `assert_eq!`, `assert_ne!` — `unwrap` on Result is fine in tests
- Property-based tests via `proptest` for anything with non-trivial input space

---

## 10. Unsafe

Almost never. If you write `unsafe`:

1. Block with a `// SAFETY: ...` comment explaining the invariant
2. The unsafe block contains the smallest scope possible
3. The function's public signature is safe — invariants verified inside

If you can't write the SAFETY comment, you don't understand the unsafe well
enough to write it. Reach for the safe alternative.

---

## 11. Common crates (operator defaults)

| Need | Crate |
|------|-------|
| Error types | `thiserror` (lib) / `anyhow` (bin) |
| Serialization | `serde` + `serde_json` |
| HTTP client | `reqwest` |
| Async runtime | `tokio` |
| CLI args | `clap` (derive feature) |
| Tracing / logs | `tracing` + `tracing-subscriber` |
| Config | `figment` or `config` |
| Time | `chrono` or `time` (operator prefers `time`) |
| UUID | `uuid` with `serde` + `v4` features |

If a project already uses different crates, match its choices. Don't migrate
as a side effect.

---

## 12. Commit messages

Conventional commits, same shape as the Node and Python sides:

```
feat(policy): bash-gate kernel cold-start under 5ms
fix(audit): rotate JSONL when size exceeds threshold
refactor(secrets): extract backend trait
```

---

## 13. What this skill does NOT cover

- Embedded / `no_std` development
- WASM targets — separate concern
- Project-specific layout (subctl policy kernel vs argent rust-spine) — read
  the project's CLAUDE.md
- Node — `node-conventions`
- Python — `python-conventions`
