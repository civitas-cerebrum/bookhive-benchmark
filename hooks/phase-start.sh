#!/bin/sh
# PostToolUse hook on Write/Edit of .achilles/onboarding-ledger.json.
# Emits a phase.start line when a new active_phase is observed.

set -eu

[ "${BOOKHIVE_BENCHMARK:-0}" = "1" ] || exit 0

input=$(cat)
file_path=$(printf '%s' "$input" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
case "$file_path" in
  */.achilles/onboarding-ledger.json) ;;
  *) exit 0 ;;
esac

if [ -f "$file_path" ]; then
  phase=$(sed -n 's/.*"active_phase"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file_path" | head -1)
  turn=$(printf '%s' "$input" | sed -n 's/.*"turn_index"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1)
  turn="${turn:-0}"
  if [ -n "$phase" ]; then
    line=$(printf '{"t":"%s","kind":"phase.start","phase":"%s","turn_index":%s}' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$phase" "$turn")
    mkdir -p "${BENCHMARK_DIR:-/tmp}/run"
    printf '%s\n' "$line" >> "${BENCHMARK_DIR:-/tmp}/run/hook.log"
  fi
fi
