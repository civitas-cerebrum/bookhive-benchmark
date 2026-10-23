#!/bin/sh
# baseline.sh — manage the persistent benchmark baseline.
#
#   baseline.sh record <results.json> [--notes "text"]   append a run to baseline/history.jsonl
#   baseline.sh promote <results.json|id> [--force]      make a run the active baseline
#   baseline.sh show                                     table of the history
#
# history.jsonl is append-only and committed. baseline.json is the active
# baseline the analyzer compares against. Neither cleanup.sh nor restart.sh
# ever touches baseline/ or results/.
#
# Env: BASELINE_DIR overrides the baseline directory (default: <repo>/baseline).

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BASELINE_DIR="${BASELINE_DIR:-$ROOT/baseline}"
export BASELINE_DIR

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

[ $# -ge 1 ] || usage

case "$1" in
  record|promote|show)
    exec npx tsx analyzer/src/cli.ts baseline "$@"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "baseline.sh: unknown subcommand: $1" >&2
    usage
    ;;
esac
