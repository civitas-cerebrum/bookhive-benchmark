#!/bin/sh
# emit.sh — write one JSON line to the benchmark hook log.
# Sourced by hook scripts, or invoked: emit.sh '<json line>'
# Env: BOOKHIVE_BENCHMARK=1 required to do anything.
#      BENCHMARK_DIR required for output location.

set -eu

if [ "${BOOKHIVE_BENCHMARK:-0}" != "1" ]; then
  exit 0
fi
if [ -z "${BENCHMARK_DIR:-}" ]; then
  exit 0
fi

if [ "$#" -ge 1 ]; then
  mkdir -p "$BENCHMARK_DIR/run"
  printf '%s\n' "$1" >> "$BENCHMARK_DIR/run/hook.log"
fi
