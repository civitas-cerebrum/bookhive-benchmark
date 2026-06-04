#!/usr/bin/env bats

setup() {
  TMP="$(mktemp -d)"
  export BENCHMARK_DIR="$TMP"
  export BOOKHIVE_BENCHMARK=1
  ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

teardown() {
  rm -rf "$TMP"
}

@test "emit.sh writes a line when called with an argument and env is set" {
  run sh "$ROOT/hooks/lib/emit.sh" '{"k":"v"}'
  [ "$status" -eq 0 ]
  [ -f "$BENCHMARK_DIR/run/hook.log" ]
  grep -q '"k":"v"' "$BENCHMARK_DIR/run/hook.log"
}

@test "emit.sh is a no-op when BOOKHIVE_BENCHMARK != 1" {
  unset BOOKHIVE_BENCHMARK
  run sh "$ROOT/hooks/lib/emit.sh" '{"x":1}'
  [ "$status" -eq 0 ]
  [ ! -f "$BENCHMARK_DIR/run/hook.log" ]
}

@test "emit.sh is a no-op when BENCHMARK_DIR is empty" {
  unset BENCHMARK_DIR
  run sh "$ROOT/hooks/lib/emit.sh" '{"x":1}'
  [ "$status" -eq 0 ]
}
