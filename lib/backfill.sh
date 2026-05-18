# lib/backfill.sh — operator-invoked memory backfill helpers.
#
# Memory Init (post-v2.8.10) — wraps the master daemon's /memory/backfill/*
# HTTP surface. Each verb is OPERATOR-INVOKED ONLY; nothing here runs at
# boot. Idempotent: re-running a backfill is a no-op for already-ingested
# rows (dedupe via marker-token recall on the target substrate).
#
# Endpoints (master :8788):
#   POST /memory/backfill/evy-to-memori           body {dryRun?, limit?}
#   POST /memory/backfill/claude-mem-to-cognee    body {dryRun?, limit?}
#   POST /memory/backfill/obsidian-to-cognee      body {dryRun?, vault_path?}
#
# This file is sourced lazily from lib/cli.sh on first use of the
# `subctl memory backfill ...` subverb so the main CLI dispatch stays
# fast for the common case (recent / search / remember).

# Build JSON body for backfill POSTs from --dry-run / --limit / --vault-path
# flag state. Echo result on stdout. Empty fields are omitted so the server's
# body parsing stays clean.
_subctl_backfill_make_body() {
  local dry_run="$1" limit="$2" vault_path="${3:-}"
  _subctl_cli_require_jq || return 1
  if [[ -n "$vault_path" ]]; then
    jq -n \
      --argjson dry "$dry_run" \
      --arg vp "$vault_path" \
      '{dryRun: $dry} + (if $vp == "" then {} else {vault_path: $vp} end)'
  else
    jq -n \
      --argjson dry "$dry_run" \
      --argjson limit "${limit:-null}" \
      '{dryRun: $dry} + (if $limit == null then {} else {limit: $limit} end)'
  fi
}

# Pretty-print a BackfillResult JSON doc to stdout. Returns 0 if ok=true,
# 1 otherwise — caller surfaces non-zero exit when the script declined.
_subctl_backfill_render() {
  local body="$1"
  _subctl_cli_require_jq || return 1
  local ok error
  ok=$(printf '%s' "$body" | jq -r '.ok // false')
  error=$(printf '%s' "$body" | jq -r '.error // empty')
  if [[ "$ok" != "true" ]]; then
    printf "${C_RED}✗ backfill declined${C_RST}\n"
    [[ -n "$error" ]] && printf "  ${C_DIM}%s${C_RST}\n" "$error"
    printf '%s' "$body" | jq .
    return 1
  fi
  # Summary line + the full JSON doc so the operator can grep/jq it.
  printf '%s' "$body" | jq -r '
    "✓ backfill complete — planned=\(.planned)  written=\(.written)  skipped=\(.skipped)  errors=\(.errors)"
  '
  printf '%s' "$body" | jq .
  return 0
}

# POST helper. Goes DIRECTLY to master (8788) per the team-lead spec —
# the dashboard proxy is bypassed so a half-down dashboard doesn't block
# the operator from running a manual backfill. The dashboard's existing
# /api/memory/* pass-through reaches the same routes if anything wants
# them later from off-host.
_subctl_backfill_post() {
  local path="$1" body="$2"
  local url
  url="$(_subctl_cli_master_base)${path}"
  curl --silent --show-error \
       --connect-timeout 3 --max-time 120 \
       -X POST -H "Content-Type: application/json" \
       --data "$body" \
       "$url"
}

# ── evy-memory → Memori ───────────────────────────────────────────────
subctl_backfill_evy_to_memori() {
  local dry_run=false limit=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) dry_run=true; shift ;;
      --limit)   limit="$2"; shift 2 ;;
      -h|--help)
        cat <<EOF
subctl memory backfill evy-to-memori [--dry-run] [--limit N]

  Ingest every entry in evy.db (Tier 3, ~/.local/state/subctl/memory/evy.db)
  into the Memori sidecar at 127.0.0.1:8746. Idempotent — re-runs skip
  rows that already carry the backfill marker.

  Options:
    --dry-run    Probe + count planned writes without persisting
    --limit N    Cap entries ingested (default: all)
EOF
        return 0 ;;
      *) subctl_err "unknown flag: $1"; return 1 ;;
    esac
  done
  if [[ -n "$limit" && ! "$limit" =~ ^[0-9]+$ ]]; then
    subctl_err "--limit must be a positive integer (got: $limit)"
    return 1
  fi
  local body resp
  body=$(_subctl_backfill_make_body "$dry_run" "$limit") || return 1
  if ! resp=$(_subctl_backfill_post "/memory/backfill/evy-to-memori" "$body" 2>/dev/null); then
    subctl_err "POST to master failed — is the master daemon running? (subctl status)"
    return 1
  fi
  _subctl_backfill_render "$resp"
}

# ── claude-mem → Cognee ──────────────────────────────────────────────
subctl_backfill_claude_mem_to_cognee() {
  local dry_run=false limit=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) dry_run=true; shift ;;
      --limit)   limit="$2"; shift 2 ;;
      -h|--help)
        cat <<EOF
subctl memory backfill claude-mem-to-cognee [--dry-run] [--limit N]

  Pull observations from claude-mem (localhost:37701) and ingest them
  into Cognee. Cognee unreachable → ok:false (no throws, no retries).

  Options:
    --dry-run    Probe + count without persisting
    --limit N    Cap observations ingested (default: all up to 50k)
EOF
        return 0 ;;
      *) subctl_err "unknown flag: $1"; return 1 ;;
    esac
  done
  if [[ -n "$limit" && ! "$limit" =~ ^[0-9]+$ ]]; then
    subctl_err "--limit must be a positive integer (got: $limit)"
    return 1
  fi
  local body resp
  body=$(_subctl_backfill_make_body "$dry_run" "$limit") || return 1
  if ! resp=$(_subctl_backfill_post "/memory/backfill/claude-mem-to-cognee" "$body" 2>/dev/null); then
    subctl_err "POST to master failed — is the master daemon running? (subctl status)"
    return 1
  fi
  _subctl_backfill_render "$resp"
}

# ── Obsidian vault → Cognee ──────────────────────────────────────────
subctl_backfill_obsidian_to_cognee() {
  local dry_run=false vault_path=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)     dry_run=true; shift ;;
      --vault-path)  vault_path="$2"; shift 2 ;;
      # Common alias the operator may type by reflex from `git ls-files` muscle memory.
      --path)        vault_path="$2"; shift 2 ;;
      -h|--help)
        cat <<EOF
subctl memory backfill obsidian-to-cognee [--dry-run] [--vault-path PATH]

  Walk an Obsidian vault and ingest each *.md file into Cognee. Defaults
  to ~/Documents/Obsidian Vault/Subctl. Cognee unreachable → ok:false.

  Options:
    --dry-run             Probe + count without reading file bodies or writing
    --vault-path PATH     Override vault root (default: ~/Documents/Obsidian Vault/Subctl)
EOF
        return 0 ;;
      *) subctl_err "unknown flag: $1"; return 1 ;;
    esac
  done
  local body resp
  body=$(_subctl_backfill_make_body "$dry_run" "" "$vault_path") || return 1
  if ! resp=$(_subctl_backfill_post "/memory/backfill/obsidian-to-cognee" "$body" 2>/dev/null); then
    subctl_err "POST to master failed — is the master daemon running? (subctl status)"
    return 1
  fi
  _subctl_backfill_render "$resp"
}
