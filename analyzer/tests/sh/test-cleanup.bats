#!/usr/bin/env bats

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  TMP="$(mktemp -d)"
  mkdir -p "$TMP/scripts" "$TMP/hooks" "$TMP/baseline" "$TMP/driver"
  cp "$ROOT/scripts/cleanup.sh" "$TMP/scripts/"
  cp "$ROOT/scripts/settings-patch.sh" "$TMP/scripts/" 2>/dev/null || true
  cp -R "$ROOT/hooks/." "$TMP/hooks/"
  cp -R "$ROOT/baseline/." "$TMP/baseline/" 2>/dev/null || true
  # Create a fake driver/docker-compose.yml so cleanup doesn't fail on docker
  printf 'services: {}\n' > "$TMP/driver/docker-compose.yml" 2>/dev/null || true
  cd "$TMP"
  mkdir -p .benchmark/run .achilles tests node_modules playwright-report test-results
  : > tests/foo.spec.ts
  : > .achilles/run-summary.json
  : > .benchmark/run/hook.log
  : > playwright.config.ts
}

teardown() {
  cd "$ROOT"
  rm -rf "$TMP"
}

@test "cleanup removes generated scaffolding but keeps committed dirs" {
  run sh "$TMP/scripts/cleanup.sh"
  [ "$status" -eq 0 ]
  [ ! -d "$TMP/tests" ]
  [ ! -d "$TMP/.achilles" ]
  [ ! -d "$TMP/.benchmark" ]
  [ ! -d "$TMP/node_modules" ]
  [ ! -d "$TMP/playwright-report" ]
  [ -d "$TMP/hooks" ]
  [ -d "$TMP/scripts" ]
  [ -d "$TMP/baseline" ]
}
