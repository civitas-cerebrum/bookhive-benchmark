#!/usr/bin/env bats

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  TMP="$(mktemp -d)"
  # cleanup.sh deletes files under $HOME/.claude/hooks: never let a test see the real HOME
  export HOME="$TMP/home"
  mkdir -p "$HOME"
  # Never reach a real docker daemon: a compose project named after its directory
  # ("driver") collides with the live benchmark stack. Fake docker first on PATH,
  # and the skip guard as a second layer.
  mkdir -p "$TMP/fakebin"
  printf '#!/bin/sh\necho "$@" >> "%s/docker.calls"\nexit 0\n' "$TMP" > "$TMP/fakebin/docker"
  chmod +x "$TMP/fakebin/docker"
  export PATH="$TMP/fakebin:$PATH"
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
  mkdir -p results
  printf '{"keep":"me"}\n' > results/2026-10-01T00-00-00Z.json
}

teardown() {
  cd "$ROOT"
  rm -rf "$TMP"
}

@test "cleanup removes generated scaffolding but keeps committed dirs" {
  run sh "$TMP/scripts/cleanup.sh"
  [ "$status" -eq 0 ]
  grep -q '^compose -f driver/docker-compose.yml down -v --remove-orphans$' "$TMP/docker.calls"
  [ ! -d "$TMP/tests" ]
  [ ! -d "$TMP/.achilles" ]
  [ ! -d "$TMP/.benchmark" ]
  [ ! -d "$TMP/node_modules" ]
  [ ! -d "$TMP/playwright-report" ]
  [ -d "$TMP/hooks" ]
  [ -d "$TMP/scripts" ]
  [ -d "$TMP/baseline" ]
}

@test "cleanup never touches baseline/ or results/" {
  printf '{"id":"x"}\n' >> "$TMP/baseline/history.jsonl"
  before_b="$(cat "$TMP/baseline/history.jsonl")"
  before_r="$(cat "$TMP/results/2026-10-01T00-00-00Z.json")"
  run sh "$TMP/scripts/cleanup.sh"
  [ "$status" -eq 0 ]
  [ "$(cat "$TMP/baseline/history.jsonl")" = "$before_b" ]
  [ -f "$TMP/baseline/baseline.json" ]
  [ "$(cat "$TMP/results/2026-10-01T00-00-00Z.json")" = "$before_r" ]
}

@test "BENCHMARK_SKIP_DOCKER=1 skips the docker step" {
  BENCHMARK_SKIP_DOCKER=1 run sh "$TMP/scripts/cleanup.sh"
  [ "$status" -eq 0 ]
  [ ! -e "$TMP/docker.calls" ]
}
