#!/bin/sh
# settings-patch.sh add|remove
# Manage ~/.claude/settings.json hook registrations for bookhive-benchmark.
# Requires jq on PATH (prefers ~/.claude/hooks/bin/jq when present).

set -eu

ACTION="${1:-}"
if [ "$ACTION" != "add" ] && [ "$ACTION" != "remove" ]; then
  echo "usage: $0 add|remove" >&2
  exit 2
fi

JQ="${HOME}/.claude/hooks/bin/jq"
if [ ! -x "$JQ" ]; then
  JQ="$(command -v jq || true)"
fi
if [ -z "$JQ" ] || [ ! -x "$JQ" ]; then
  echo "jq not found (looked in ~/.claude/hooks/bin/jq and PATH)" >&2
  exit 1
fi

SETTINGS="${HOME}/.claude/settings.json"
mkdir -p "${HOME}/.claude"
[ -f "$SETTINGS" ] || printf '{}\n' > "$SETTINGS"

TAG="bookhive-benchmark-managed"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PHASE_START="${ROOT}/hooks/phase-start.sh"
PHASE_END="${ROOT}/hooks/phase-end.sh"
SUBAGENT="${ROOT}/hooks/subagent-dispatch.sh"
STOP="${ROOT}/hooks/stop-retro.sh"

tmp=$(mktemp)

if [ "$ACTION" = "remove" ]; then
  "$JQ" --arg tag "$TAG" '
    def cleanArr(arr): [arr[]? | select((.benchmark_tag // "") != $tag)];
    if has("hooks") then
      .hooks |= (
        with_entries(
          if (.value | type) == "array" then .value |= cleanArr(.) else . end
        )
      )
    else . end
  ' "$SETTINGS" > "$tmp"
  mv "$tmp" "$SETTINGS"
  exit 0
fi

"$JQ" \
  --arg tag "$TAG" \
  --arg phaseStart "$PHASE_START" \
  --arg phaseEnd "$PHASE_END" \
  --arg subagent "$SUBAGENT" \
  --arg stop "$STOP" '
  def ensureArr(k): if has(k) then . else .[k] = [] end;
  .hooks //= {} |
  .hooks |= (ensureArr("PostToolUse") | ensureArr("PreToolUse") | ensureArr("Stop"))
  | .hooks.PostToolUse += [
      {benchmark_tag: $tag, matcher: "Write|Edit", command: $phaseStart},
      {benchmark_tag: $tag, matcher: "Write|Edit", command: $phaseEnd}
    ]
  | .hooks.PreToolUse += [
      {benchmark_tag: $tag, matcher: "Task", command: $subagent}
    ]
  | .hooks.Stop += [
      {benchmark_tag: $tag, command: $stop}
    ]
' "$SETTINGS" > "$tmp"
mv "$tmp" "$SETTINGS"
