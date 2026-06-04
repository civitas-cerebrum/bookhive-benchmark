# Plan 2 — Driver + Hooks + Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the local runtime. After this plan, a contributor can run `./restart.sh` against an existing local achilles checkout, launch Claude Code, prompt "complete e2e test automation," and after the session ends `./restart.sh --analyze` produces a results.json. No CI yet.

**Architecture:** POSIX shell scripts under `hooks/`, `driver/`, and `scripts/`. They are dumb — no business logic. They install/wire/teardown. The TS analyzer from Plan 1 does the analysis.

**Tech Stack:** POSIX sh (works in bash and zsh), Docker Compose v2, `jq` (already bundled by achilles itself at `~/.claude/hooks/bin/jq`), `bats-core` for shell tests.

---

## File structure created by this plan

```
bookhive-benchmark/
├── restart.sh                              # local prepare + analyze dispatcher
├── scripts/
│   ├── cleanup.sh                          # single source of truth for "what stays"
│   └── settings-patch.sh                   # add/remove benchmark entries from ~/.claude/settings.json
├── hooks/
│   ├── phase-start.sh                      # PostToolUse hook: emit phase.start on onboarding-ledger-write
│   ├── phase-end.sh                        # PostToolUse hook: emit phase.end
│   ├── subagent-dispatch.sh                # PreToolUse hook on Task: emit subagent.dispatch
│   ├── stop-retro.sh                       # Stop hook: append retrospective prompt if missing
│   └── lib/
│       └── emit.sh                         # shared: write a JSON line to $BENCHMARK_DIR/run/hook.log
├── driver/
│   ├── docker-compose.yml                  # bookhive + db
│   ├── retro-prompt.txt                    # the retrospective question set
│   └── claude-md-snippet.md                # injected into the project's CLAUDE.md by restart.sh
└── tests/sh/                               # NOTE: not committed to git's root tests/ ignore
    ├── test-cleanup.bats
    ├── test-emit.bats
    └── test-restart.bats
```

(The shell tests live in `analyzer/tests/sh/` to dodge the `.gitignore` rule that ignores root `/tests/`. Alternatively, we move the rule. Plan 2 puts them in `analyzer/tests/sh/`.)

---

### Task 1: `hooks/lib/emit.sh` — shared event emitter

**Files:**
- Create: `hooks/lib/emit.sh`

- [ ] **Step 1: Write the emitter**

```sh
#!/bin/sh
# emit.sh — write one JSON line to the benchmark hook log
# Args: $1 = JSON line (must already be valid JSON)
# Env: BENCHMARK_DIR (required) — run state dir
# No-op if BOOKHIVE_BENCHMARK != 1

set -eu

if [ "${BOOKHIVE_BENCHMARK:-0}" != "1" ]; then
  exit 0
fi
if [ -z "${BENCHMARK_DIR:-}" ]; then
  exit 0
fi

mkdir -p "$BENCHMARK_DIR/run"
printf '%s\n' "$1" >> "$BENCHMARK_DIR/run/hook.log"
```

- [ ] **Step 2: Make executable**

Run: `chmod +x hooks/lib/emit.sh`

- [ ] **Step 3: Commit**

```bash
git add hooks/lib/emit.sh
git commit -m "feat(hooks): add shared event emitter for benchmark telemetry"
```

---

### Task 2: `hooks/phase-start.sh`, `phase-end.sh`, `subagent-dispatch.sh`, `stop-retro.sh`

**Files:** create each script under `hooks/`.

- [ ] **Step 1: Write `phase-start.sh`**

```sh
#!/bin/sh
# Triggered as a PostToolUse hook on Write/Edit of .achilles/onboarding-ledger.json
# Reads hook input on stdin (Claude Code provides JSON), detects phase transitions
# by scanning the ledger, emits phase.start when a new phase appears.

set -eu

THIS_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$THIS_DIR/lib/emit.sh" 2>/dev/null || true

[ "${BOOKHIVE_BENCHMARK:-0}" = "1" ] || exit 0

input=$(cat)
# Claude Code provides: { tool_input: { file_path: "...", ... }, tool_name: "..." }
file_path=$(printf '%s' "$input" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

# Only react to writes against the onboarding ledger
case "$file_path" in
  */.achilles/onboarding-ledger.json) ;;
  *) exit 0 ;;
esac

# Read latest ledger entry; rely on it shipping the active phase
if [ -f "$file_path" ]; then
  phase=$(sed -n 's/.*"active_phase"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file_path" | head -1)
  turn=$(printf '%s' "$input" | sed -n 's/.*"turn_index"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1)
  turn="${turn:-0}"
  if [ -n "$phase" ]; then
    line=$(printf '{"t":"%s","kind":"phase.start","phase":"%s","turn_index":%s}' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$phase" "$turn")
    mkdir -p "${BENCHMARK_DIR:-/tmp}/run"
    printf '%s\n' "$line" >> "${BENCHMARK_DIR:-/tmp}/run/hook.log"
  fi
fi
```

Save at `hooks/phase-start.sh`.

- [ ] **Step 2: Write `phase-end.sh`**

```sh
#!/bin/sh
# PostToolUse hook on Write/Edit of .achilles/onboarding-ledger.json
# Emits phase.end when the ledger marks a phase complete.

set -eu

[ "${BOOKHIVE_BENCHMARK:-0}" = "1" ] || exit 0

input=$(cat)
file_path=$(printf '%s' "$input" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
case "$file_path" in
  */.achilles/onboarding-ledger.json) ;;
  *) exit 0 ;;
esac

if [ -f "$file_path" ]; then
  closed_phase=$(sed -n 's/.*"closed_phase"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file_path" | head -1)
  gate=$(sed -n 's/.*"closed_gate"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file_path" | head -1)
  turn=$(printf '%s' "$input" | sed -n 's/.*"turn_index"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1)
  turn="${turn:-0}"
  if [ -n "$closed_phase" ] && [ -n "$gate" ]; then
    line=$(printf '{"t":"%s","kind":"phase.end","phase":"%s","turn_index":%s,"gate_result":"%s"}' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$closed_phase" "$turn" "$gate")
    mkdir -p "${BENCHMARK_DIR:-/tmp}/run"
    printf '%s\n' "$line" >> "${BENCHMARK_DIR:-/tmp}/run/hook.log"
  fi
fi
```

Save at `hooks/phase-end.sh`.

- [ ] **Step 3: Write `subagent-dispatch.sh`**

```sh
#!/bin/sh
# PreToolUse hook on Task tool.
# Emits subagent.dispatch with parent_phase (read from ledger) and prompt size.

set -eu

[ "${BOOKHIVE_BENCHMARK:-0}" = "1" ] || exit 0

input=$(cat)
tool=$(printf '%s' "$input" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ "$tool" = "Task" ] || exit 0

subagent_type=$(printf '%s' "$input" | sed -n 's/.*"subagent_type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
prompt=$(printf '%s' "$input" | sed -n 's/.*"prompt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
prompt_chars=$(printf '%s' "$prompt" | wc -c | tr -d ' ')

parent_phase=""
ledger="${PWD}/.achilles/onboarding-ledger.json"
if [ -f "$ledger" ]; then
  parent_phase=$(sed -n 's/.*"active_phase"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ledger" | head -1)
fi
parent_phase="${parent_phase:-unknown}"

line=$(printf '{"t":"%s","kind":"subagent.dispatch","parent_phase":"%s","subagent_type":"%s","prompt_chars":%s}' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$parent_phase" "${subagent_type:-unknown}" "$prompt_chars")
mkdir -p "${BENCHMARK_DIR:-/tmp}/run"
printf '%s\n' "$line" >> "${BENCHMARK_DIR:-/tmp}/run/hook.log"
```

Save at `hooks/subagent-dispatch.sh`.

- [ ] **Step 4: Write `stop-retro.sh`**

```sh
#!/bin/sh
# Stop hook. If retrospective.json is missing, prompt Claude to write it.
# Returns JSON on stdout that Claude Code interprets:
#   { "decision": "block", "reason": "<text>" } prevents stop and feeds reason as next user turn.
# Reference: https://docs.anthropic.com/en/docs/claude-code/hooks#stop

set -eu

[ "${BOOKHIVE_BENCHMARK:-0}" = "1" ] || { printf '{}\n'; exit 0; }

retro="${PWD}/.benchmark/retrospective.json"
if [ -f "$retro" ]; then
  printf '{}\n'
  exit 0
fi

# Only intervene once — if we already blocked, let it stop now to avoid loops.
marker="${BENCHMARK_DIR:-/tmp}/run/.retro-asked"
if [ -f "$marker" ]; then
  printf '{}\n'
  exit 0
fi
mkdir -p "${BENCHMARK_DIR:-/tmp}/run"
: > "$marker"

prompt=$(cat "${BOOKHIVE_BENCHMARK_RETRO_PROMPT:-/dev/null}" 2>/dev/null || cat <<'EOF'
Before we finish, write `.benchmark/retrospective.json` with this exact JSON shape:

{
  "novel_observations": "<what was new or unexpected this run>",
  "difficulties": "<what was hardest>",
  "would_do_differently": "<what you'd change next time>",
  "per_phase_impact": [
    { "phase": "scaffold", "impact": "<one sentence>" }
    /* one entry per phase that meaningfully affected the run */
  ]
}

Only valid phase names: scaffold, groundwork, happy-path, journey-mapping,
coverage-expansion, bug-discovery, secrets-sweep, report.
EOF
)

# Escape for JSON: backslashes, quotes, newlines
esc=$(printf '%s' "$prompt" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS="\\n"}1' | sed 's/\\n$//')

printf '{"decision":"block","reason":"%s"}\n' "$esc"
```

Save at `hooks/stop-retro.sh`.

- [ ] **Step 5: Make all executable**

Run: `chmod +x hooks/*.sh hooks/lib/*.sh`

- [ ] **Step 6: Commit**

```bash
git add hooks/
git commit -m "feat(hooks): add phase, subagent-dispatch, and stop-retro hooks"
```

---

### Task 3: `scripts/cleanup.sh` and `scripts/settings-patch.sh`

**Files:** create both.

- [ ] **Step 1: Write `scripts/settings-patch.sh`**

The script reads/writes `~/.claude/settings.json` using `jq`. Adds or removes the benchmark's hook registrations, marked by a magic string so we can find them later.

```sh
#!/bin/sh
# settings-patch.sh add|remove
# Manage ~/.claude/settings.json hook registrations for bookhive-benchmark.
# Requires jq on PATH (prefers ~/.claude/hooks/bin/jq when present).

set -eu

ACTION="${1:-}"
if [ "$ACTION" != "add" ] && [ "$ACTION" != "remove" ]; then
  echo "usage: $0 add|remove" >&2
  exit 2
fi

JQ="${HOME}/.claude/hooks/bin/jq"
if [ ! -x "$JQ" ]; then
  JQ="$(command -v jq || true)"
fi
if [ -z "$JQ" ] || [ ! -x "$JQ" ]; then
  echo "jq not found (looked in ~/.claude/hooks/bin/jq and PATH)" >&2
  exit 1
fi

SETTINGS="${HOME}/.claude/settings.json"
mkdir -p "${HOME}/.claude"
[ -f "$SETTINGS" ] || printf '{}\n' > "$SETTINGS"

# magic tag used to recognize our entries
TAG="bookhive-benchmark-managed"

# absolute paths to our hook scripts (resolved from the repo root the script is invoked from)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PHASE_START="${ROOT}/hooks/phase-start.sh"
PHASE_END="${ROOT}/hooks/phase-end.sh"
SUBAGENT="${ROOT}/hooks/subagent-dispatch.sh"
STOP="${ROOT}/hooks/stop-retro.sh"

tmp=$(mktemp)

if [ "$ACTION" = "remove" ]; then
  "$JQ" --arg tag "$TAG" '
    def cleanArr(arr): [arr[]? | select((.benchmark_tag // "") != $tag)];
    if has("hooks") then
      .hooks |= (
        with_entries(
          if (.value | type) == "array" then .value |= cleanArr(.) else . end
        )
      )
    else . end
  ' "$SETTINGS" > "$tmp"
  mv "$tmp" "$SETTINGS"
  exit 0
fi

# ADD
"$JQ" \
  --arg tag "$TAG" \
  --arg phaseStart "$PHASE_START" \
  --arg phaseEnd "$PHASE_END" \
  --arg subagent "$SUBAGENT" \
  --arg stop "$STOP" '
  def ensureArr(k): if has(k) then . else .[k] = [] end;
  .hooks //= {} |
  .hooks |= (ensureArr("PostToolUse") | ensureArr("PreToolUse") | ensureArr("Stop"))
  | .hooks.PostToolUse += [
      {benchmark_tag: $tag, matcher: "Write|Edit", command: $phaseStart},
      {benchmark_tag: $tag, matcher: "Write|Edit", command: $phaseEnd}
    ]
  | .hooks.PreToolUse += [
      {benchmark_tag: $tag, matcher: "Task", command: $subagent}
    ]
  | .hooks.Stop += [
      {benchmark_tag: $tag, command: $stop}
    ]
' "$SETTINGS" > "$tmp"
mv "$tmp" "$SETTINGS"
```

Save at `scripts/settings-patch.sh`.

- [ ] **Step 2: Write `scripts/cleanup.sh`**

```sh
#!/bin/sh
# cleanup.sh — restore the project to a clean state.
# Aggressive on the left side, narrow on the right.

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 1) Stop & remove BookHive container + its volumes (idempotent)
if command -v docker >/dev/null 2>&1 && [ -f "driver/docker-compose.yml" ]; then
  docker compose -f driver/docker-compose.yml down -v --remove-orphans 2>/dev/null || true
fi

# 2) Remove achilles-generated scaffolding
rm -rf tests playwright-report test-results playwright.config.ts package-lock.json.achilles-bak

# 3) Remove benchmark working state
rm -rf .benchmark .achilles

# 4) Remove installed achilles + node_modules (re-installed on next restart)
rm -rf node_modules

# 5) Remove our hook copies from ~/.claude/hooks
for f in phase-start.sh phase-end.sh subagent-dispatch.sh stop-retro.sh; do
  rm -f "${HOME}/.claude/hooks/$f"
done

# 6) Surgically remove benchmark entries from ~/.claude/settings.json
if [ -x "scripts/settings-patch.sh" ]; then
  "scripts/settings-patch.sh" remove 2>/dev/null || true
fi

echo "cleanup done"
```

Save at `scripts/cleanup.sh`.

- [ ] **Step 3: Make executable**

Run: `chmod +x scripts/cleanup.sh scripts/settings-patch.sh`

- [ ] **Step 4: Commit**

```bash
git add scripts/
git commit -m "feat(scripts): add cleanup and settings-patch (surgical)"
```

---

### Task 4: `driver/docker-compose.yml` + `driver/retro-prompt.txt` + `driver/claude-md-snippet.md`

**Files:** create all three.

- [ ] **Step 1: Write `driver/docker-compose.yml`**

```yaml
services:
  bookhive:
    image: umutayb/bookhive:latest
    container_name: bookhive-benchmark-bookhive
    ports:
      - "8080:8080"
    environment:
      SPRING_PROFILES_ACTIVE: "default"
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:8080/actuator/health || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 30
      start_period: 30s
```

Save at `driver/docker-compose.yml`. The image tag is `:latest` for now; Plan 3 pins to a digest.

- [ ] **Step 2: Write `driver/retro-prompt.txt`**

```
Before we finish, write `.benchmark/retrospective.json` with this exact JSON shape:

{
  "novel_observations": "<what was new or unexpected this run>",
  "difficulties": "<what was hardest>",
  "would_do_differently": "<what you'd change next time>",
  "per_phase_impact": [
    { "phase": "scaffold", "impact": "<one sentence>" }
    /* one entry per phase that meaningfully affected the run */
  ]
}

Valid phase names: scaffold, groundwork, happy-path, journey-mapping, coverage-expansion, bug-discovery, secrets-sweep, report.
```

Save at `driver/retro-prompt.txt`.

- [ ] **Step 3: Write `driver/claude-md-snippet.md`**

```markdown
<!-- BEGIN bookhive-benchmark managed block -->
## Benchmark mode active

This project is currently being benchmarked by `bookhive-benchmark`.

- BookHive is running at `http://localhost:8080`.
- At end of session, write a structured retrospective to `.benchmark/retrospective.json` (the Stop hook will remind you if you forget — see `BENCHMARK_DIR/run/retro-prompt.txt`).
- Do NOT modify anything under `.benchmark/` or files matching `~/.claude/hooks/(phase|subagent|stop)-*.sh`.
<!-- END bookhive-benchmark managed block -->
```

Save at `driver/claude-md-snippet.md`.

- [ ] **Step 4: Commit**

```bash
git add driver/
git commit -m "feat(driver): add docker-compose, retro prompt, CLAUDE.md snippet"
```

---

### Task 5: `restart.sh` — local prepare + analyze dispatcher

**Files:** create `restart.sh`.

- [ ] **Step 1: Write `restart.sh`**

```sh
#!/bin/sh
# restart.sh — the contributor's one-command entry point.
#
# Default:                     prepare a fresh run (clean, install, bring up, wire).
# --analyze:                   after a session ends, run the analyzer.
# Env:
#   ACHILLES_PATH              path to local achilles checkout (default: ../achilles)
#   BOOKHIVE_BENCHMARK_RETRO_PROMPT  override retrospective prompt (default: driver/retro-prompt.txt)

set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

ACHILLES_PATH="${ACHILLES_PATH:-../achilles}"

mode="prepare"
if [ "${1:-}" = "--analyze" ]; then
  mode="analyze"
fi

if [ "$mode" = "analyze" ]; then
  transcript_dir="${HOME}/.claude/projects/$(echo "$ROOT" | sed 's|/|-|g')"
  # Pick the most recently modified .jsonl
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

# resolve achilles path
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

echo "==> copy benchmark hooks to ~/.claude/hooks/"
mkdir -p "${HOME}/.claude/hooks"
cp hooks/phase-start.sh hooks/phase-end.sh hooks/subagent-dispatch.sh hooks/stop-retro.sh "${HOME}/.claude/hooks/"

echo "==> register hooks in ~/.claude/settings.json"
scripts/settings-patch.sh add

echo "==> bring up BookHive"
docker compose -f driver/docker-compose.yml up -d
echo "==> wait for healthcheck"
tries=60
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
cat > .benchmark/meta.json <<JSON
{
  "achilles_version": "$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ACHILLES_PATH/package.json" | head -1)",
  "achilles_commit": "$(cd "$ACHILLES_PATH" && git rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "claude_code_version": "$(claude --version 2>/dev/null | head -1 || echo unknown)",
  "mode": "local",
  "host": {
    "runner_os": "$(uname -s)",
    "cpu_count": $(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4),
    "mem_gb": $(( $(sysctl -n hw.memsize 2>/dev/null || awk '/MemTotal/ {print $2*1024; exit}' /proc/meminfo 2>/dev/null || echo 17179869184) / 1073741824 ))
  }
}
JSON

cat > .env <<EOF
BOOKHIVE_BENCHMARK=1
BENCHMARK_DIR=$ROOT/.benchmark
BOOKHIVE_URL=http://localhost:8080
BOOKHIVE_BENCHMARK_RETRO_PROMPT=$ROOT/driver/retro-prompt.txt
EOF

# Append the CLAUDE.md snippet (idempotent — replace previous block)
claude_md="$ROOT/CLAUDE.md"
if [ -f "$claude_md" ]; then
  # remove any prior block
  awk '
    /<!-- BEGIN bookhive-benchmark managed block -->/ { skip=1 }
    !skip { print }
    /<!-- END bookhive-benchmark managed block -->/ { skip=0 }
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
```

Save at `restart.sh`.

- [ ] **Step 2: Make executable**

Run: `chmod +x restart.sh`

- [ ] **Step 3: Commit**

```bash
git add restart.sh
git commit -m "feat: add restart.sh (local prepare + analyze dispatcher)"
```

---

### Task 6: Shell smoke tests with bats

**Files:**
- Create: `analyzer/tests/sh/test-emit.bats`
- Create: `analyzer/tests/sh/test-cleanup.bats`
- Create: `analyzer/tests/sh/test-settings-patch.bats`
- Modify: `package.json` — add `test:sh` script

- [ ] **Step 1: Install bats-core as a devDependency**

Run: `npm install --save-dev bats`
Expected: package added.

- [ ] **Step 2: Add `test:sh` script**

Edit `package.json` `scripts` to add:
```json
"test:sh": "bats analyzer/tests/sh"
```

- [ ] **Step 3: Write `test-emit.bats`**

```sh
#!/usr/bin/env bats

setup() {
  TMP="$(mktemp -d)"
  export BENCHMARK_DIR="$TMP"
  export BOOKHIVE_BENCHMARK=1
}

teardown() {
  rm -rf "$TMP"
}

@test "emit.sh appends a JSON line to hook.log" {
  bash -c ". hooks/lib/emit.sh && true"
  bash -c '. hooks/lib/emit.sh; printf "%s\n" "{\"k\":\"v\"}" >> "$BENCHMARK_DIR/run/hook.log"'
  # The above pattern mirrors how hook scripts use emit.sh
  [ -f "$BENCHMARK_DIR/run/hook.log" ]
}

@test "emit.sh is a no-op when BOOKHIVE_BENCHMARK != 1" {
  unset BOOKHIVE_BENCHMARK
  # Source emit.sh in a way that triggers its `exit 0` guard
  run sh hooks/lib/emit.sh '{"x":1}'
  [ "$status" -eq 0 ]
  [ ! -f "$BENCHMARK_DIR/run/hook.log" ]
}
```

Save at `analyzer/tests/sh/test-emit.bats`.

- [ ] **Step 4: Write `test-settings-patch.bats`**

```sh
#!/usr/bin/env bats

setup() {
  TMP="$(mktemp -d)"
  export HOME="$TMP"
  mkdir -p "$HOME/.claude"
  printf '{}\n' > "$HOME/.claude/settings.json"
}

teardown() {
  rm -rf "$TMP"
}

@test "add then remove leaves settings.json unchanged" {
  cp "$HOME/.claude/settings.json" "$TMP/before.json"
  run scripts/settings-patch.sh add
  [ "$status" -eq 0 ]
  run scripts/settings-patch.sh remove
  [ "$status" -eq 0 ]
  diff "$HOME/.claude/settings.json" "$TMP/before.json"
}

@test "add inserts entries tagged bookhive-benchmark-managed" {
  run scripts/settings-patch.sh add
  [ "$status" -eq 0 ]
  grep -q 'bookhive-benchmark-managed' "$HOME/.claude/settings.json"
}
```

Save at `analyzer/tests/sh/test-settings-patch.bats`.

- [ ] **Step 5: Write `test-cleanup.bats`**

```sh
#!/usr/bin/env bats

setup() {
  ROOT="$(pwd)"
  TMP="$(mktemp -d)"
  cp -R hooks driver scripts analyzer/tests/sh restart.sh package.json baseline schema "$TMP"/ 2>/dev/null || true
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
  run scripts/cleanup.sh
  [ "$status" -eq 0 ]
  [ ! -d tests ]
  [ ! -d .achilles ]
  [ ! -d .benchmark ]
  [ ! -d node_modules ]
  [ ! -d playwright-report ]
  [ -d hooks ]
  [ -d scripts ]
  [ -d baseline ]
}
```

Save at `analyzer/tests/sh/test-cleanup.bats`.

- [ ] **Step 6: Run shell tests**

Run: `npm run test:sh`
Expected: all bats tests pass.

- [ ] **Step 7: Commit**

```bash
git add analyzer/tests/sh/ package.json package-lock.json
git commit -m "test(sh): bats smoke tests for emit, settings-patch, cleanup"
```

---

### Task 7: Final pass + tag

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 2: Run full test suite**

Run: `npm test && npm run test:sh`
Expected: all green.

- [ ] **Step 3: Tag**

```bash
git tag -a plan-2-complete -m "Plan 2 — Driver + Hooks + Cleanup complete"
```

---

## Self-review

- ✅ Spec §3 (driver/, hooks/, scripts/, restart.sh)
- ✅ Spec §4 source 1 (benchmark hook log: emit.sh + phase-start/end + subagent-dispatch)
- ✅ Spec §4 source 4 (retrospective: stop-retro.sh + retro-prompt.txt)
- ✅ Spec §6 (local flow end-to-end)
- ✅ Spec §9 (cleanup contract)
- ✅ Spec §10 layer 2 (shell smoke tests)
- ⛔ Deferred to Plan 3: CI workflow, achilles-side PR, README/PROCESS rewrite, BookHive digest pin
