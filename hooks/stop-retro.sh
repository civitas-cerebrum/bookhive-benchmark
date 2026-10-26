#!/bin/sh
# Stop hook. Ensures a retrospective.json exists by blocking once with a prompt.

set -eu

[ "${BOOKHIVE_BENCHMARK:-0}" = "1" ] || { printf '{}\n'; exit 0; }

retro="${PWD}/.benchmark/retrospective.json"
if [ -f "$retro" ]; then
  printf '{}\n'
  exit 0
fi

# The QA work may run in a subagent after the main turn ends (Achilles 0.1.8
# delegates it to an orchestrator), so ask only once the onboarding has
# completed its Report phase.
status="${PWD}/tests/e2e/docs/onboarding-status.json"
if [ "$(jq -r '[.phases[]? | select(.name == "Report")][0].status // ""' "$status" 2>/dev/null)" != "completed" ]; then
  printf '{}\n'
  exit 0
fi

marker="${BENCHMARK_DIR:-/tmp}/run/.retro-asked"
if [ -f "$marker" ]; then
  printf '{}\n'
  exit 0
fi
mkdir -p "${BENCHMARK_DIR:-/tmp}/run"
: > "$marker"

prompt=$(cat "${BOOKHIVE_BENCHMARK_RETRO_PROMPT:-/dev/null}" 2>/dev/null || cat <<'EOF'
Before we finish, write `.benchmark/retrospective.json` with this exact JSON shape:

{
  "novel_observations": "<what was new or unexpected this run>",
  "difficulties": "<what was hardest>",
  "would_do_differently": "<what you'd change next time>",
  "per_phase_impact": [
    { "phase": "scaffold", "impact": "<one sentence>" }
  ]
}

Valid phase names: scaffold, groundwork, happy-path, journey-mapping, coverage-expansion, bug-discovery, secrets-sweep, report.
EOF
)

esc=$(printf '%s' "$prompt" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS="\\n"}1' | sed 's/\\n$//')
printf '{"decision":"block","reason":"%s"}\n' "$esc"
