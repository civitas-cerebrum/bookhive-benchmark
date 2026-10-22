#!/bin/sh
# restart.sh — the contributor's one-command entry point.
#
# Default:    prepare a fresh run (clean, install, bring up, wire).
# --analyze:  after a session ends, run the analyzer.
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
chmod +x scripts/cleanup.sh scripts/settings-patch.sh hooks/*.sh hooks/lib/*.sh 2>/dev/null || true

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

  npx tsx analyzer/src/cli.ts analyze \
    --transcript "$transcript" \
    --hooks "$ROOT/.benchmark/run/hook.log" \
    --self-report "$ROOT/.achilles/run-summary.json" \
    --retro "$ROOT/.benchmark/retrospective.json" \
    --baseline "$ROOT/baseline/baseline.json" \
    --project-dir "$ROOT" \
    --meta "$meta_file" \
    --out "$out_file"

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

echo "==> pack achilles from $ACHILLES_PATH"
# A folder install (npm install <dir>) symlinks the package, so achilles'
# postinstall sees its own repo path and skips silently: the harness never
# lands and the run uses whatever is already in ~/.claude. Install a tarball.
# achilles' prepack script builds the validator, checks the pack and runs its
# tests, so the build happens as part of `npm pack`.
pack_dir=$(mktemp -d)
trap 'rm -rf "$pack_dir"' EXIT
(cd "$ACHILLES_PATH" && npm pack --silent --pack-destination "$pack_dir" >/dev/null)
tgz=$(ls -1t "$pack_dir"/*.tgz 2>/dev/null | head -1 || true)
if [ -z "$tgz" ] || [ ! -f "$tgz" ]; then
  echo "npm pack produced no tarball for $ACHILLES_PATH" >&2
  exit 1
fi

echo "==> install achilles tarball $(basename "$tgz")"
npm install --silent
npm install --silent "$tgz"

echo "==> verify achilles harness landed"
installed_scope=""
if [ -f "$ROOT/.claude/achilles-install.json" ] && [ "$ROOT/.claude/achilles-install.json" -nt "$tgz" ] \
   && ls "$ROOT/.claude/hooks/"achilles-*.sh >/dev/null 2>&1; then
  installed_scope="project"
elif [ -f "${HOME}/.claude/achilles-install.json" ] && [ "${HOME}/.claude/achilles-install.json" -nt "$tgz" ] \
   && ls "${HOME}/.claude/hooks/"achilles-*.sh >/dev/null 2>&1; then
  installed_scope="user"
fi
if [ -z "$installed_scope" ]; then
  echo "achilles harness did not install: no fresh achilles-install.json plus achilles-*.sh hooks under $ROOT/.claude or ${HOME}/.claude" >&2
  echo "the benchmark would run on a stale or missing harness; aborting" >&2
  exit 1
fi
echo "achilles installed at ${installed_scope} scope"

echo "==> copy benchmark hooks to ~/.claude/hooks/"
mkdir -p "${HOME}/.claude/hooks"
cp hooks/phase-start.sh hooks/phase-end.sh hooks/subagent-dispatch.sh hooks/stop-retro.sh "${HOME}/.claude/hooks/"
chmod +x "${HOME}/.claude/hooks/phase-start.sh" "${HOME}/.claude/hooks/phase-end.sh" "${HOME}/.claude/hooks/subagent-dispatch.sh" "${HOME}/.claude/hooks/stop-retro.sh"

echo "==> register hooks in ~/.claude/settings.json"
scripts/settings-patch.sh add

echo "==> bring up BookHive"
docker compose -f driver/docker-compose.yml up -d
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
  "achilles_install_scope": "${installed_scope}",
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
