#!/bin/sh
# PreToolUse hook on Task tool dispatches.
# Emits subagent.dispatch with parent_phase (read from ledger) and prompt size.

set -eu

[ "${BOOKHIVE_BENCHMARK:-0}" = "1" ] || exit 0

input=$(cat)
tool=$(printf '%s' "$input" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ "$tool" = "Task" ] || exit 0

subagent_type=$(printf '%s' "$input" | sed -n 's/.*"subagent_type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
prompt=$(printf '%s' "$input" | sed -n 's/.*"prompt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
prompt_chars=$(printf '%s' "$prompt" | wc -c | tr -d ' ')

parent_phase=""
ledger="${PWD}/.achilles/onboarding-ledger.json"
if [ -f "$ledger" ]; then
  parent_phase=$(sed -n 's/.*"active_phase"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ledger" | head -1)
fi
parent_phase="${parent_phase:-unknown}"

line=$(printf '{"t":"%s","kind":"subagent.dispatch","parent_phase":"%s","subagent_type":"%s","prompt_chars":%s}' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$parent_phase" "${subagent_type:-unknown}" "$prompt_chars")
mkdir -p "${BENCHMARK_DIR:-/tmp}/run"
printf '%s\n' "$line" >> "${BENCHMARK_DIR:-/tmp}/run/hook.log"
