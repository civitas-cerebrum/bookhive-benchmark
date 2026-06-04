#!/usr/bin/env bats

setup() {
  TMP="$(mktemp -d)"
  export HOME="$TMP"
  mkdir -p "$HOME/.claude"
  printf '{}\n' > "$HOME/.claude/settings.json"
  ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

teardown() {
  rm -rf "$TMP"
}

@test "add inserts entries tagged bookhive-benchmark-managed" {
  run sh "$ROOT/scripts/settings-patch.sh" add
  [ "$status" -eq 0 ]
  grep -q 'bookhive-benchmark-managed' "$HOME/.claude/settings.json"
}

@test "remove cleans benchmark entries" {
  sh "$ROOT/scripts/settings-patch.sh" add
  run sh "$ROOT/scripts/settings-patch.sh" remove
  [ "$status" -eq 0 ]
  ! grep -q 'bookhive-benchmark-managed' "$HOME/.claude/settings.json"
}

@test "add then remove is idempotent (no benchmark tags remain)" {
  sh "$ROOT/scripts/settings-patch.sh" add
  sh "$ROOT/scripts/settings-patch.sh" remove
  ! grep -q 'bookhive-benchmark-managed' "$HOME/.claude/settings.json"
}
