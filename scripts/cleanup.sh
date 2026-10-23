#!/bin/sh
# cleanup.sh — restore the project to a clean state.
# Aggressive on the left side, narrow on the right.

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# BENCHMARK_SKIP_DOCKER=1 skips this step (used by tests so they can never reach a real daemon).
if [ "${BENCHMARK_SKIP_DOCKER:-}" != "1" ] && command -v docker >/dev/null 2>&1 && [ -f "driver/docker-compose.yml" ]; then
  docker compose -f driver/docker-compose.yml down -v --remove-orphans 2>/dev/null || true
fi

rm -rf tests playwright-report test-results playwright.config.ts package-lock.json.achilles-bak
rm -rf .benchmark .achilles
rm -rf node_modules

for f in phase-start.sh phase-end.sh subagent-dispatch.sh stop-retro.sh; do
  rm -f "${HOME}/.claude/hooks/$f"
done

if [ -x "scripts/settings-patch.sh" ]; then
  "scripts/settings-patch.sh" remove 2>/dev/null || true
fi

echo "cleanup done"
