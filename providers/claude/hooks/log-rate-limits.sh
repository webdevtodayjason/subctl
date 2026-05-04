#!/usr/bin/env bash
# providers/claude/hooks/log-rate-limits.sh — Claude Code Stop hook.
# Scans the session transcript for Anthropic API error type literals
# since the last hook fire and appends each occurrence to the events log.
# Fails silently — never blocks the main Claude flow.
#
# Symlinked into ~/.claude/hooks/log-rate-limits.sh by `subctl install`.
set -uo pipefail

input=$(cat 2>/dev/null) || exit 0
transcript=$(echo "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
sid=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)

[[ -z "$transcript" ]] && exit 0
[[ ! -f "$transcript" ]] && exit 0

log="$HOME/.claude/rate-limit-events.log"
offsets="$HOME/.claude/rate-limit-offsets"
mkdir -p "$(dirname "$log")"
touch "$log" "$offsets"

prev_offset=$(grep "^${sid} " "$offsets" 2>/dev/null | tail -1 | awk '{print $2}')
prev_offset=${prev_offset:-0}

size=$(wc -c < "$transcript" 2>/dev/null | tr -d ' ' || echo 0)
[[ "$size" -le "$prev_offset" ]] && exit 0

new_bytes=$(tail -c +$((prev_offset + 1)) "$transcript" 2>/dev/null)

# Tight matching: only Anthropic API error type LITERALS as they appear in
# unescaped transcript JSON. Escaped occurrences inside quoted conversation
# text (\"type\":\"rate_limit_error\") will NOT match.
hit_count=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  type=""
  case "$line" in
    *'"type":"overloaded_error"'*|*'"error":"overloaded_error"'*)
      type="529 (overload)" ;;
    *'"type":"rate_limit_error"'*|*'"error":"rate_limit_error"'*)
      type="429 (rate_limit)" ;;
  esac
  [[ -z "$type" ]] && continue

  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  today=$(date +%Y-%m-%d)
  printf '{"ts":"%s","date":"%s","session":"%s","type":"%s"}\n' \
    "$ts" "$today" "$sid" "$type" >> "$log"
  hit_count=$((hit_count + 1))
done <<< "$new_bytes"

# Update offset (replace existing entry for this session)
{ grep -v "^${sid} " "$offsets" 2>/dev/null; echo "${sid} ${size}"; } \
  > "${offsets}.tmp" && mv "${offsets}.tmp" "$offsets"

exit 0
