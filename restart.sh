#!/bin/sh
# restart.sh — the contributor's one-command entry point.
#
# Default:    prepare a fresh run (clean, install, bring up, wire).
# --analyze:  after a session ends, run the analyzer and record the run in
#             baseline/history.jsonl (it does NOT promote it to the baseline).
#
# Env:
#   ACHILLES_PATH                    path to local achilles checkout (default: ../achilles)
#   BOOKHIVE_BENCHMARK_RETRO_PROMPT  override retrospective prompt
#
# Invoke either as `./restart.sh` (preferred) or `sh restart.sh`.

set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Ensure our shipped scripts are executable before we use them
chmod +x scripts/cleanup.sh scripts/compose.sh scripts/run-summary.sh scripts/settings-patch.sh scripts/baseline.sh hooks/*.sh hooks/lib/*.sh 2>/dev/null || true

ACHILLES_PATH="${ACHILLES_PATH:-../achilles}"

mode="prepare"
if [ "${1:-}" = "--analyze" ]; then
  mode="analyze"
fi

if [ "$mode" = "analyze" ]; then
  encoded=$(echo "$ROOT" | sed 's|/|-|g')
  transcript_dir="${HOME}/.claude/projects/${encoded}"
  transcript=$(ls -1t "$transcript_dir"/*.jsonl 2>/dev/null | head -1 || true)
  if [ -z "$transcript" ]; then
    echo "no transcript found under $transcript_dir" >&2
    exit 1
  fi
  meta_file="$ROOT/.benchmark/meta.json"
  out_file="$ROOT/results/$(date -u +%Y-%m-%dT%H-%M-%SZ).json"
  mkdir -p "$ROOT/results"

  # Achilles 0.1.8+ writes no run summary of its own; derive it from the run's files.
  scripts/run-summary.sh "$ROOT" || echo "warning: could not derive .achilles/run-summary.json" >&2

  npx tsx analyzer/src/cli.ts analyze \
    --transcript "$transcript" \
    --hooks "$ROOT/.benchmark/run/hook.log" \
    --self-report "$ROOT/.achilles/run-summary.json" \
    --retro "$ROOT/.benchmark/retrospective.json" \
    --baseline "$ROOT/baseline/baseline.json" \
    --project-dir "$ROOT" \
    --meta "$meta_file" \
    --out "$out_file"

  # Log the run in baseline/history.jsonl. Never promotes: promoting is a
  # deliberate step (scripts/baseline.sh promote). A failure here must not
  # block cleanup or lose the results file, which is already on disk.
  scripts/baseline.sh record "$out_file" \
    || echo "warning: could not record run in baseline/history.jsonl (results file is intact)" >&2

  scripts/cleanup.sh
  echo
  echo "results: $out_file"
  echo "commit this file into your achilles PR at .benchmark/results.json"
  exit 0
fi

# ----- prepare -----

echo "==> cleanup"
scripts/cleanup.sh

if [ ! -d "$ACHILLES_PATH" ]; then
  echo "ACHILLES_PATH does not exist: $ACHILLES_PATH" >&2
  echo "set ACHILLES_PATH=/abs/path or place achilles at ../achilles" >&2
  exit 1
fi
ACHILLES_PATH=$(cd "$ACHILLES_PATH" && pwd)
if [ ! -f "$ACHILLES_PATH/package.json" ]; then
  echo "no package.json at $ACHILLES_PATH" >&2
  exit 1
fi
name=$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ACHILLES_PATH/package.json" | head -1)
case "$name" in
  *achilles*) ;;
  *)
    echo "package at $ACHILLES_PATH does not look like achilles (name=$name)" >&2
    exit 1
    ;;
esac

echo "==> install local achilles from $ACHILLES_PATH"
npm install --silent
npm install --silent "$ACHILLES_PATH"
# npm 12 blocks dependency install scripts by default; run the Achilles postinstall
# (plugin registration, Chromium) explicitly. It is idempotent.
INIT_CWD="$ROOT" node node_modules/@civitas-cerebrum/achilles/scripts/postinstall.js

echo "==> copy benchmark hooks to ~/.claude/hooks/"
mkdir -p "${HOME}/.claude/hooks"
cp hooks/phase-start.sh hooks/phase-end.sh hooks/subagent-dispatch.sh hooks/stop-retro.sh "${HOME}/.claude/hooks/"
chmod +x "${HOME}/.claude/hooks/phase-start.sh" "${HOME}/.claude/hooks/phase-end.sh" "${HOME}/.claude/hooks/subagent-dispatch.sh" "${HOME}/.claude/hooks/stop-retro.sh"

echo "==> register hooks in ~/.claude/settings.json"
scripts/settings-patch.sh add

echo "==> bring up BookHive"
scripts/compose.sh -f driver/docker-compose.yml up -d
echo "==> wait for healthcheck"
tries=60
status=""
while [ $tries -gt 0 ]; do
  status=$(docker inspect --format='{{.State.Health.Status}}' bookhive-benchmark-bookhive 2>/dev/null || echo "")
  if [ "$status" = "healthy" ]; then
    break
  fi
  sleep 2
  tries=$((tries - 1))
done
if [ "$status" != "healthy" ]; then
  echo "BookHive failed to become healthy" >&2
  exit 1
fi
echo "==> seed BookHive"
curl -fsS -X POST http://localhost:8080/api/seed >/dev/null

echo "==> write benchmark state"
mkdir -p .benchmark/run
achilles_version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ACHILLES_PATH/package.json" | head -1)
achilles_commit=$(cd "$ACHILLES_PATH" && git rev-parse --short HEAD 2>/dev/null || echo unknown)
claude_version=$(claude --version 2>/dev/null | head -1 || echo unknown)
runner_os=$(uname -s)
cpu_count=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
mem_bytes=$(sysctl -n hw.memsize 2>/dev/null || awk '/MemTotal/ {print $2*1024; exit}' /proc/meminfo 2>/dev/null || echo 17179869184)
mem_gb=$(( mem_bytes / 1073741824 ))

cat > .benchmark/meta.json <<JSON
{
  "achilles_version": "${achilles_version}",
  "achilles_commit": "${achilles_commit}",
  "claude_code_version": "${claude_version}",
  "mode": "local",
  "host": {
    "runner_os": "${runner_os}",
    "cpu_count": ${cpu_count},
    "mem_gb": ${mem_gb}
  }
}
JSON

cat > .env <<EOF
BOOKHIVE_BENCHMARK=1
BENCHMARK_DIR=$ROOT/.benchmark
BOOKHIVE_URL=http://localhost:8080
BOOKHIVE_BENCHMARK_RETRO_PROMPT=$ROOT/driver/retro-prompt.txt
EOF

claude_md="$ROOT/CLAUDE.md"
if [ -f "$claude_md" ]; then
  awk '
    /<!-- BEGIN bookhive-benchmark managed block -->/ { skip=1; next }
    /<!-- END bookhive-benchmark managed block -->/ { skip=0; next }
    !skip { print }
  ' "$claude_md" > "$claude_md.tmp" && mv "$claude_md.tmp" "$claude_md"
fi
cat driver/claude-md-snippet.md >> "$claude_md"

echo
echo "Ready. Source the env and launch Claude Code:"
echo "  set -a; . ./.env; set +a"
echo "  claude"
echo "Then prompt: complete e2e test automation"
echo
echo "After Claude finishes, run: ./restart.sh --analyze"
