#!/bin/sh
# run-summary.sh [project-dir]
# Writes <project>/.achilles/run-summary.json (run-summary/v2) from the files the
# Achilles skills write. Achilles 0.2.0 wrote it from a Stop hook; 0.1.8 dropped
# that hook, so the benchmark derives the same self-report here. An existing
# file (written by Achilles itself) is left alone.
#
#   tests/e2e/docs/onboarding-status.json   phases
#   tests/e2e/docs/adversarial-findings.md  findings ('#### <ID> [sev] — title')
#   tests/e2e/docs/journey-map.md           journeys ('### j-' headings)
#   playwright-report/results.json | test-results/results.json (newest)

set -eu

ROOT="$(cd "${1:-.}" && pwd)"
out="$ROOT/.achilles/run-summary.json"
[ -f "$out" ] && exit 0
JQ="$(command -v jq || true)"
[ -n "$JQ" ] || { echo "run-summary: jq not found, skipping" >&2; exit 0; }
DOCS="$ROOT/tests/e2e/docs"
mkdir -p "$ROOT/.achilles"

phases='[]'
[ -f "$DOCS/onboarding-status.json" ] && phases=$("$JQ" -c '.phases // []' "$DOCS/onboarding-status.json" 2>/dev/null || echo '[]')

scenarios='[]'
[ -d "$ROOT/tests" ] && scenarios=$(find "$ROOT/tests" -type f \( -name '*.spec.ts' -o -name '*.spec.js' -o -name '*.spec.mjs' \) | "$JQ" -R . | "$JQ" -s .)

ids='[]'; sev='{"critical":0,"high":0,"medium":0,"low":0,"info":0}'
if [ -f "$DOCS/adversarial-findings.md" ]; then
  ids=$(grep -E '^#### ' "$DOCS/adversarial-findings.md" | sed -E 's/^#### ([^ ]+) .*/\1/' | "$JQ" -R . | "$JQ" -s .)
  sev=$(grep -E '^#### ' "$DOCS/adversarial-findings.md" | sed -E 's/^#### [^ ]+ \[([A-Za-z]+)\].*/\1/' | tr '[:upper:]' '[:lower:]' | "$JQ" -R . | "$JQ" -s '
    reduce .[] as $s ({"critical":0,"high":0,"medium":0,"low":0,"info":0}; if has($s) then .[$s] += 1 else . end)')
fi

results=""
for c in "$ROOT/playwright-report/results.json" "$ROOT/test-results/results.json"; do
  [ -f "$c" ] || continue
  if [ -z "$results" ] || [ "$c" -nt "$results" ]; then results="$c"; fi
done
tests='{"passing":null,"failing":null,"flaky":null,"skipped":null,"total":null,"status":null}'
if [ -n "$results" ]; then
  tests=$("$JQ" -c '(.stats // {}) as $s | select($s | has("expected")) |
    { passing: $s.expected, failing: ($s.unexpected // 0), flaky: ($s.flaky // 0), skipped: ($s.skipped // 0),
      total: (($s.expected // 0) + ($s.unexpected // 0) + ($s.flaky // 0) + ($s.skipped // 0)),
      status: (if ($s.unexpected // 0) > 0 then "failing" else "passing" end) }' "$results" 2>/dev/null || true)
  [ -n "$tests" ] || tests='{"passing":null,"failing":null,"flaky":null,"skipped":null,"total":null,"status":null}'
fi

journeys=0
[ -f "$DOCS/journey-map.md" ] && { journeys=$(grep -cE '^### j-' "$DOCS/journey-map.md") || journeys=0; }

ver=$("$JQ" -r '.version // ""' "$ROOT/node_modules/@civitas-cerebrum/achilles/package.json" 2>/dev/null || echo "")
"$JQ" -n --argjson phases "$phases" --argjson scenarios "$scenarios" --argjson ids "$ids" --argjson sev "$sev" \
  --argjson tests "$tests" --argjson journeys "$journeys" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg sha "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo "")" --arg ver "$ver" \
  '{ meta: { timestamp: $ts, git_sha: $sha, achilles_version: $ver, schema: "run-summary/v2" },
     phases: $phases, scenarios: { files: $scenarios }, bugs: { ids: $ids, by_severity: $sev },
     tests: $tests, journey_map: { journeys: $journeys } }' > "$out"
