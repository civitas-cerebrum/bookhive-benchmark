# Plan 3 — CI Workflow + Achilles Snippets + Public Docs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the cross-repo bridge and ship the public docs. After this plan, the repo is fork-ready: a contributor (or an achilles PR) can trigger a benchmark CI run and post results back to the achilles PR.

**Architecture:** YAML workflow under `ci/workflows/`, copy-paste templates under `ci/achilles-snippets/`, a workflow self-test that exercises the analyzer with a fake `claude` binary, a real README (the only doc end users read), and a `PROCESS.md` that explains what's measured and why.

**Tech Stack:** GitHub Actions, gh CLI, sh.

---

## File structure created by this plan

```
bookhive-benchmark/
├── ci/
│   ├── workflows/benchmark.yml               # the real workflow (lives in this repo)
│   ├── workflows/self-test.yml               # workflow_dispatch self-test (fake claude)
│   └── achilles-snippets/
│       ├── benchmark-trigger.yml.template    # copy to achilles/.github/workflows/
│       ├── benchmark-json-check.yml.template # copy to achilles/.github/workflows/
│       ├── run-summary-writer.sh.template    # copy to achilles/hooks/, register via Stop
│       └── README.md                         # instructions for the achilles maintainer
├── ci/fakes/claude                           # tiny shell script that simulates `claude -p`
├── README.md                                 # full contributor guide (rewrites the placeholder)
├── PROCESS.md                                # full process doc (rewrites the placeholder)
└── baseline/baseline.json                    # already exists; refresh comment
```

---

### Task 1: Real CI workflow (`ci/workflows/benchmark.yml`)

**Files:** create `ci/workflows/benchmark.yml`.

The repo's `.github/workflows/` is conventional for GH Actions. We'll keep workflows under `ci/workflows/` for visibility and use a symlink (or document a one-time copy) for activation. For Plan 3, we'll commit at the GitHub-expected path: `.github/workflows/benchmark.yml` AND keep a copy under `ci/workflows/` as the canonical source. To avoid duplication, the actual file lives at `.github/workflows/benchmark.yml` and `ci/workflows/` is a docs pointer (a markdown file describing where the workflow lives).

- [ ] **Step 1: Write the workflow at `.github/workflows/benchmark.yml`**

```yaml
name: 🧪 bookhive-benchmark

on:
  repository_dispatch:
    types: [achilles-pr]
  workflow_dispatch:
    inputs:
      pr_number:
        description: "Achilles PR number (for manual reruns)"
        required: true
      head_sha:
        description: "Achilles PR head SHA"
        required: true
      achilles_ref:
        description: "Achilles PR branch ref"
        required: true
      achilles_repo:
        description: "owner/repo of achilles"
        required: true
        default: "Umutayb/achilles"

concurrency:
  group: benchmark-${{ github.event.client_payload.head_sha || inputs.head_sha }}
  cancel-in-progress: true

jobs:
  benchmark:
    runs-on: ubuntu-22.04
    timeout-minutes: 90
    env:
      PR_NUMBER:    ${{ github.event.client_payload.pr_number || inputs.pr_number }}
      HEAD_SHA:     ${{ github.event.client_payload.head_sha || inputs.head_sha }}
      ACHILLES_REF: ${{ github.event.client_payload.achilles_ref || inputs.achilles_ref }}
      ACHILLES_REPO: ${{ github.event.client_payload.achilles_repo || inputs.achilles_repo }}
      MAX_RUN_TOKENS: "5000000"
    steps:
      - name: Checkout bookhive-benchmark
        uses: actions/checkout@v4
        with: { path: bench }

      - name: Checkout achilles @ head_sha
        uses: actions/checkout@v4
        with:
          repository: ${{ env.ACHILLES_REPO }}
          ref: ${{ env.HEAD_SHA }}
          path: achilles
          token: ${{ secrets.ACHILLES_BENCHMARK_TOKEN }}

      - uses: actions/setup-node@v4
        with: { node-version: "20" }

      - name: Install Claude Code CLI
        run: npm i -g @anthropic-ai/claude-code@latest

      - name: Install jq
        run: sudo apt-get update -y && sudo apt-get install -y jq

      - name: Prepare benchmark (restart.sh)
        working-directory: bench
        env:
          ACHILLES_PATH: ${{ github.workspace }}/achilles
        run: ./restart.sh

      - name: Run achilles via headless Claude Code
        working-directory: bench
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          BOOKHIVE_BENCHMARK: "1"
          BENCHMARK_DIR: ${{ github.workspace }}/bench/.benchmark
          BENCHMARK_MODE: "ci"
        run: |
          set -e
          mkdir -p .benchmark/run
          claude -p "complete e2e test automation" \
            --output-format=stream-json \
            --dangerously-skip-permissions \
            --max-turns 400 \
            > .benchmark/run/stream.jsonl \
            2> .benchmark/run/stream.err || true
          # token guard
          total=$(jq -s '[.[] | .usage.input_tokens + .usage.output_tokens] | add // 0' .benchmark/run/stream.jsonl 2>/dev/null || echo 0)
          echo "TOTAL_TOKENS=$total" >> $GITHUB_ENV
          if [ "$total" -gt "$MAX_RUN_TOKENS" ]; then
            echo "::warning::run exceeded MAX_RUN_TOKENS ($total > $MAX_RUN_TOKENS), marking as truncated"
            touch .benchmark/run/.truncated
          fi

      - name: Analyze
        working-directory: bench
        run: |
          set -e
          [ -f .benchmark/run/.truncated ] && export BENCHMARK_TRUNCATED=1
          ./restart.sh --analyze
          latest=$(ls -1t results/*.json | head -1)
          echo "RESULTS_PATH=$latest" >> $GITHUB_ENV
          jq -r '.baseline_comparison.regression_verdict' "$latest" > .benchmark/verdict
          echo "VERDICT=$(cat .benchmark/verdict)" >> $GITHUB_ENV

      - name: Publish check_run on achilles
        env:
          GH_TOKEN: ${{ secrets.ACHILLES_BENCHMARK_TOKEN }}
        run: |
          conclusion="success"
          case "$VERDICT" in
            warn) conclusion="neutral" ;;
            fail) conclusion="failure" ;;
          esac
          gh api "repos/$ACHILLES_REPO/check-runs" \
            -X POST \
            -f name='bookhive-benchmark' \
            -f head_sha="$HEAD_SHA" \
            -f status='completed' \
            -f conclusion="$conclusion" \
            -f output.title="Verdict: $VERDICT" \
            -f output.summary="See workflow run for full results JSON" \
            >/dev/null

      - name: Comment on achilles PR
        env:
          GH_TOKEN: ${{ secrets.ACHILLES_BENCHMARK_TOKEN }}
        run: |
          body=$(jq -n \
            --arg verdict "$VERDICT" \
            --arg total "$TOTAL_TOKENS" \
            --slurpfile r "$RESULTS_PATH" \
            '{
              md: ("## bookhive-benchmark — \($verdict)\n\n"
                + "- tokens: \($total)\n"
                + "- duration_sec: \($r[0].run.duration_sec)\n"
                + "- scenarios: \($r[0].outcomes.scenarios_written.count)\n"
                + "- bugs: \($r[0].outcomes.bugs_filed.count)\n"
                + "- tests passing: \($r[0].outcomes.tests_passing.count)/\($r[0].outcomes.tests_passing.total)\n\n"
                + "<details><summary>baseline deltas</summary>\n\n```\n"
                + ($r[0].baseline_comparison.deltas | tostring)
                + "\n```\n</details>")
            }' | jq -r .md)
          gh pr comment "$PR_NUMBER" --repo "$ACHILLES_REPO" --body "$body"

      - name: Upload results artifact
        uses: actions/upload-artifact@v4
        with:
          name: bookhive-benchmark-results
          path: bench/results/*.json
```

- [ ] **Step 2: Write `ci/workflows/README.md` (pointer)**

```markdown
# CI workflows

The runnable workflow lives at the GitHub-expected path:

- `.github/workflows/benchmark.yml` — handles `repository_dispatch: { types: [achilles-pr] }` and `workflow_dispatch`.
- `.github/workflows/self-test.yml` — `workflow_dispatch` self-test with a fake `claude` binary; verifies the analyzer + reporting steps without burning API credits.

This directory is a pointer; do not duplicate the YAML here.
```

Save at `ci/workflows/README.md`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/benchmark.yml ci/workflows/README.md
git commit -m "feat(ci): add benchmark workflow with repository_dispatch + check_run"
```

---

### Task 2: Workflow self-test + fake `claude` binary

**Files:**
- Create: `ci/fakes/claude`
- Create: `.github/workflows/self-test.yml`

- [ ] **Step 1: Write the fake claude binary**

```sh
#!/usr/bin/env bash
# A fake `claude` binary for CI self-test. Ignores arguments and emits a recorded
# transcript on stdout (stream-json format).

set -eu
# Stream a minimal jsonl that exercises the analyzer
cat <<'EOF'
{"type":"system","subtype":"init","session_id":"selftest-123"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
{"type":"result","subtype":"success","is_error":false}
EOF
```

Save at `ci/fakes/claude`. Will be chmod-ed by the workflow before use.

- [ ] **Step 2: Write the self-test workflow**

```yaml
name: 🧪 benchmark self-test

on:
  workflow_dispatch:

jobs:
  self-test:
    runs-on: ubuntu-22.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with: { node-version: "20" }

      - name: Install deps
        run: npm install --silent

      - name: TS tests
        run: npm test

      - name: Shell tests
        run: |
          sudo apt-get update -y && sudo apt-get install -y bats jq
          npm run test:sh

      - name: Analyzer end-to-end with fixtures
        run: |
          mkdir -p .benchmark/run results
          # Use the happy fixtures as a stand-in for a CI run
          cp analyzer/tests/fixtures/happy/transcript.jsonl .benchmark/run/transcript.jsonl
          cp analyzer/tests/fixtures/happy/hook.log .benchmark/run/hook.log
          mkdir -p .achilles && cp analyzer/tests/fixtures/happy/run-summary.json .achilles/run-summary.json
          mkdir -p .benchmark && cp analyzer/tests/fixtures/happy/retrospective.json .benchmark/retrospective.json
          cat > .benchmark/meta.json <<'JSON'
          {"achilles_version":"selftest","achilles_commit":"deadbeef","claude_code_version":"selftest","mode":"ci","host":{"runner_os":"linux","cpu_count":2,"mem_gb":7}}
          JSON
          npx tsx analyzer/src/cli.ts analyze \
            --transcript .benchmark/run/transcript.jsonl \
            --hooks .benchmark/run/hook.log \
            --self-report .achilles/run-summary.json \
            --retro .benchmark/retrospective.json \
            --baseline baseline/baseline.json \
            --meta .benchmark/meta.json \
            --project-dir . \
            --out results/selftest.json

      - name: Validate self-test result
        run: |
          jq -e '.schema_version == "1.0.0"' results/selftest.json
          jq -e '.baseline_comparison.regression_verdict' results/selftest.json

      - name: Fake claude binary on PATH
        run: |
          chmod +x ci/fakes/claude
          echo "$PWD/ci/fakes" >> $GITHUB_PATH

      - name: Run fake claude
        run: claude -p "anything" > /tmp/stream.jsonl
```

Save at `.github/workflows/self-test.yml`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/self-test.yml ci/fakes/claude
git commit -m "feat(ci): add self-test workflow + fake claude binary"
```

---

### Task 3: Achilles-side snippets

**Files:**
- Create: `ci/achilles-snippets/benchmark-trigger.yml.template`
- Create: `ci/achilles-snippets/benchmark-json-check.yml.template`
- Create: `ci/achilles-snippets/run-summary-writer.sh.template`
- Create: `ci/achilles-snippets/README.md`

- [ ] **Step 1: `benchmark-trigger.yml.template`**

```yaml
# Copy to achilles/.github/workflows/benchmark-trigger.yml
# Requires the secret BENCHMARK_DISPATCH_TOKEN: a PAT with `contents: write` on
# bookhive-benchmark (enough to send a repository_dispatch).

name: 🧪 Benchmark trigger
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - uses: peter-evans/repository-dispatch@v3
        with:
          token: ${{ secrets.BENCHMARK_DISPATCH_TOKEN }}
          repository: __OWNER__/bookhive-benchmark
          event-type: achilles-pr
          client-payload: |
            {"pr_number":"${{ github.event.pull_request.number }}",
             "head_sha":"${{ github.event.pull_request.head.sha }}",
             "achilles_ref":"${{ github.event.pull_request.head.ref }}",
             "achilles_repo":"${{ github.repository }}"}
```

- [ ] **Step 2: `benchmark-json-check.yml.template`**

```yaml
# Copy to achilles/.github/workflows/benchmark-json-check.yml
# Verifies that the PR includes/updates .benchmark/results.json and that it
# conforms to the bookhive-benchmark schema.

name: ✅ Benchmark JSON present
on: pull_request
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Diff includes .benchmark/results.json
        run: |
          BASE=${{ github.event.pull_request.base.sha }}
          if ! git diff --name-only $BASE...HEAD | grep -q '^.benchmark/results.json$'; then
            echo "::error::PR must include or update .benchmark/results.json (run bookhive-benchmark locally)"
            exit 1
          fi
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - name: Validate against schema
        run: |
          npm i -g ajv-cli ajv-formats
          curl -fsSL -o /tmp/results.schema.json \
            https://raw.githubusercontent.com/__OWNER__/bookhive-benchmark/main/schema/results.schema.json
          ajv validate -s /tmp/results.schema.json -d .benchmark/results.json -c ajv-formats --spec=draft2020
```

- [ ] **Step 3: `run-summary-writer.sh.template`**

```sh
#!/bin/sh
# Achilles Stop hook. Writes <project>/.achilles/run-summary.json so the
# bookhive-benchmark analyzer has an authoritative self-report to cross-check.
#
# Install: copy to achilles/hooks/run-summary-writer.sh, then `npm run sync-hooks`
# (or otherwise register as a Stop hook in ~/.claude/settings.json).

set -eu

ROOT="${PWD}"
out="${ROOT}/.achilles/run-summary.json"
mkdir -p "${ROOT}/.achilles"

# Phases: read from the onboarding ledger if present (achilles writes one)
if [ -f "${ROOT}/.achilles/onboarding-ledger.json" ]; then
  phases_json=$(jq -c '.phases // []' "${ROOT}/.achilles/onboarding-ledger.json" 2>/dev/null || echo '[]')
else
  phases_json='[]'
fi

# Scenarios: any .spec.* under tests/
scenarios_json='[]'
if [ -d "${ROOT}/tests" ]; then
  scenarios_json=$(find "${ROOT}/tests" -type f \( -name '*.spec.ts' -o -name '*.spec.js' -o -name '*.spec.mjs' \) | jq -R . | jq -s .)
fi

# Bugs from .bug-ledger/
bugs_ids='[]'
bugs_high=0; bugs_med=0; bugs_low=0
if [ -d "${ROOT}/.bug-ledger" ]; then
  bugs_ids=$(find "${ROOT}/.bug-ledger" -name '*.json' -exec jq -r '.id // empty' {} \; | jq -R . | jq -s .)
  bugs_high=$(find "${ROOT}/.bug-ledger" -name '*.json' -exec jq -r 'select(.severity=="high") | .id' {} \; | wc -l | tr -d ' ')
  bugs_med=$(find "${ROOT}/.bug-ledger" -name '*.json' -exec jq -r 'select(.severity=="med") | .id' {} \; | wc -l | tr -d ' ')
  bugs_low=$(find "${ROOT}/.bug-ledger" -name '*.json' -exec jq -r 'select(.severity=="low") | .id' {} \; | wc -l | tr -d ' ')
fi

# Tests
pw_exit=0
passing=0
total=0
if [ -f "${ROOT}/test-results/results.json" ]; then
  passing=$(jq '[.suites[]?.specs[]? | select(.tests[0].results[0].status=="passed")] | length' "${ROOT}/test-results/results.json" 2>/dev/null || echo 0)
  total=$(jq '[.suites[]?.specs[]?] | length' "${ROOT}/test-results/results.json" 2>/dev/null || echo 0)
fi

# Journey map page count
pages=0
if [ -f "${ROOT}/.achilles/journey-map.json" ]; then
  pages=$(jq '.pages | length' "${ROOT}/.achilles/journey-map.json" 2>/dev/null || echo 0)
fi

jq -n \
  --argjson phases "$phases_json" \
  --argjson scenarios "$scenarios_json" \
  --argjson ids "$bugs_ids" \
  --argjson high "$bugs_high" --argjson med "$bugs_med" --argjson low "$bugs_low" \
  --argjson passing "$passing" --argjson total "$total" --argjson pw_exit "$pw_exit" \
  --argjson pages "$pages" \
  '{
    phases: $phases,
    scenarios: { files: $scenarios },
    bugs: { ids: $ids, by_severity: { high: $high, med: $med, low: $low } },
    tests: { passing: $passing, total: $total, playwright_exit_code: $pw_exit },
    journey_map: { pages: $pages }
  }' > "$out"

printf '{}\n'
```

- [ ] **Step 4: `ci/achilles-snippets/README.md` — instructions**

```markdown
# Achilles-side snippets

These files belong in the **achilles** repo, not here. Copy them, replacing `__OWNER__` with your GitHub user/org.

## What to copy

| Source (here) | Destination (in achilles) |
|---|---|
| `benchmark-trigger.yml.template` | `.github/workflows/benchmark-trigger.yml` |
| `benchmark-json-check.yml.template` | `.github/workflows/benchmark-json-check.yml` |
| `run-summary-writer.sh.template` | `hooks/run-summary-writer.sh` |

## Secrets to configure

- **In bookhive-benchmark** repo Settings → Secrets:
  - `ACHILLES_BENCHMARK_TOKEN` — fine-grained PAT scoped to your `achilles` repo with `pull-requests: write`, `checks: write`, `contents: read`.
  - `ANTHROPIC_API_KEY` — for `claude -p` in the runner.

- **In achilles** repo Settings → Secrets:
  - `BENCHMARK_DISPATCH_TOKEN` — PAT with `contents: write` on `bookhive-benchmark` (enough to send `repository_dispatch`).

## Register the Stop hook in achilles

The `run-summary-writer.sh` is a Stop hook. Achilles ships `scripts/sync-hooks.js` which already registers `hooks/*.sh` files into `~/.claude/settings.json` on `postinstall`. As long as the file is added to `achilles/hooks/` and `scripts/sync-hooks.js` is invoked, it will be wired automatically.

If you prefer manual registration, add to `~/.claude/settings.json`:

```json
"Stop": [
  { "command": "/abs/path/to/achilles/hooks/run-summary-writer.sh" }
]
```
```

- [ ] **Step 5: Commit**

```bash
git add ci/achilles-snippets/
git commit -m "feat(ci): add achilles-side snippets (trigger, static check, self-report writer)"
```

---

### Task 4: Real README

**Files:**
- Modify: `README.md` (full rewrite)

- [ ] **Step 1: Write the real README**

```markdown
# bookhive-benchmark

> Public benchmarking harness for [`@civitas-cerebrum/achilles`](https://www.npmjs.com/package/@civitas-cerebrum/achilles).

Runs the full 8-phase achilles onboarding workflow against a frozen BookHive docker image and records process metrics (tokens, durations, subagent dispatches, gate stats) plus outcome metrics (scenarios produced, bugs filed, generated suite pass rate) in a canonical `results.json`.

Every achilles PR must include an updated `results.json` from a local run; achilles also fires a CI run of this benchmark and posts results back as a PR comment + check.

---

## Quick start (local)

```sh
# 1) Clone next to your local achilles checkout
cd ~/code
git clone https://github.com/__OWNER__/bookhive-benchmark.git
ls   # achilles/  bookhive-benchmark/   ← siblings

# 2) Run the prepare step
cd bookhive-benchmark
./restart.sh                # cleans, installs local achilles, starts BookHive

# 3) Source the env and launch Claude Code
set -a; . ./.env; set +a
claude
# In Claude Code:
#   complete e2e test automation

# 4) After Claude finishes, analyze
./restart.sh --analyze      # produces results/<timestamp>.json, then cleans up

# 5) Commit the results into your achilles PR at .benchmark/results.json
cp results/<timestamp>.json ../achilles/.benchmark/results.json
cd ../achilles && git add .benchmark/results.json && git commit -m "chore: update benchmark results"
```

That's it.

### Requirements

- Node.js 20+
- Docker + Docker Compose v2
- A working `claude` (Claude Code CLI)
- An achilles checkout. Default discovery: sibling at `../achilles`. Override with `ACHILLES_PATH=/abs/path ./restart.sh`.

---

## What the benchmark measures

See [`PROCESS.md`](PROCESS.md) for the full process doc. In short:

- **Process efficiency** — per-phase tokens (input/output/cache), durations, turn counts, tool-call counts, subagent dispatches.
- **Outcome quality** — scenarios written (count + on-disk verification), bugs filed (by severity), generated Playwright suite pass rate, journey-map page count.
- **Reliability cross-checks** — every metric exists in two sources (Claude transcript + achilles self-report); disagreements are recorded as `discrepancies[]` in the output.
- **Qualitative retrospective** — Claude writes a structured retro at end of session: novel observations, difficulties, would-do-differently, per-phase impact.

The `results.json` schema is at [`schema/results.schema.json`](schema/results.schema.json) (JSON Schema draft 2020-12). A baseline is stored at [`baseline/baseline.json`](baseline/baseline.json). Every PR run produces a delta vs. baseline and a `regression_verdict` of `pass | warn | fail`.

---

## CI integration with achilles

When an achilles PR opens, a tiny workflow in achilles fires a `repository_dispatch` to this repo. This repo runs the benchmark headless via `claude -p`, posts a `bookhive-benchmark` check_run on the achilles PR, and comments the delta table.

To wire your own fork, see [`ci/achilles-snippets/README.md`](ci/achilles-snippets/README.md).

Two PR checks gate achilles merges:

- **`Benchmark JSON present`** — static, runs in achilles, verifies the PR includes a schema-valid `.benchmark/results.json`.
- **`bookhive-benchmark`** — dynamic, runs in this repo via `repository_dispatch`, posts a check_run back to achilles with `pass/warn/fail`.

---

## Project layout

```
bookhive-benchmark/
├── restart.sh                # local prepare + analyze dispatcher
├── analyzer/                 # pure TS analyzer + golden-file tests
├── hooks/                    # opt-in benchmark hooks (BOOKHIVE_BENCHMARK=1)
├── driver/                   # docker-compose.yml, retro prompt, CLAUDE.md snippet
├── ci/                       # workflow source + achilles snippets + self-test fakes
├── scripts/                  # cleanup.sh, settings-patch.sh
├── schema/                   # results.schema.json + run-summary.schema.json
├── baseline/                 # baseline.json (7-day rolling median, updated on main)
└── results/                  # per-run results (gitignored except .gitkeep)
```

---

## Tests

```sh
npm test          # TypeScript: analyzer + CLI
npm run test:sh   # POSIX shell: emit, settings-patch, cleanup (bats)
npm run typecheck # strict TS
```

CI runs all three on every PR to this repo.

---

## Contributing

1. Open a PR with your changes.
2. Run the benchmark locally and update `baseline/baseline.json` if your changes affect the baseline (rare).
3. CI runs all tests on every PR.

For changes that affect achilles directly, see [`ci/achilles-snippets/README.md`](ci/achilles-snippets/README.md) for the changes achilles needs.

---

## License

MIT
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: write the real README (contributor manual)"
```

---

### Task 5: PROCESS.md (full)

**Files:**
- Modify: `PROCESS.md`

- [ ] **Step 1: Write PROCESS.md**

```markdown
# bookhive-benchmark — process

What this benchmark measures, how it captures the data, and why each metric earns its place.

---

## What's measured

### Process efficiency
| Metric | Source | Why |
|---|---|---|
| `totals.tokens.{input,output,cache_read,cache_creation,total}` | Claude transcript `message.usage` | Direct cost signal. |
| `totals.turns` | Transcript line count (user + assistant) | Process verbosity. |
| `totals.tool_calls` | Transcript `tool_use` content | Activity proxy. |
| `totals.subagent_dispatches` | Hook log + transcript Task tool uses | How much achilles delegates. |
| `totals.gate_failures` | Hook log `phase.end.gate_result == "fail"` + achilles self-report | Workflow rigor. |
| `totals.retries` | Achilles self-report `phases[].retries` | Phase robustness. |
| `phases[].duration_sec` | Hook log `phase.start` ↔ `phase.end` timestamps | Per-phase cost attribution. |
| `phases[].tokens` | Transcript turns bucketed into phase ranges | Per-phase resource cost. |
| `phases[].tool_calls_by_name` | Transcript tool calls within phase range | Which tools dominate each phase. |

### Outcome quality
| Metric | Source | Why |
|---|---|---|
| `outcomes.scenarios_written.{count,files}` | Achilles self-report + on-disk verification | Did achilles produce real tests? |
| `outcomes.bugs_filed.{count,by_severity,ids}` | Achilles self-report (`.bug-ledger/*.json`) | Did achilles find real bugs? |
| `outcomes.tests_passing.{count,total,ratio}` | Achilles self-report (`test-results/results.json`) | Does the generated suite actually pass? |
| `outcomes.playwright_exit_code` | Achilles self-report | Process-level success signal. |
| `outcomes.journey_map_pages` | Achilles self-report (`.achilles/journey-map.json`) | Coverage signal. |

### Reliability cross-checks
| Discrepancy | When recorded |
|---|---|
| `self_report_missing` | `.achilles/run-summary.json` not found at end of session. |
| `retrospective_missing` | `.benchmark/retrospective.json` not produced. |
| `scenario_count_mismatch` | On-disk `.spec.*` files differ in count from self-report. |
| `truncated_run` | `run.truncated == true` due to `--max-turns` or token cap. |

### Qualitative retrospective

At end of session, the `stop-retro.sh` hook ensures Claude writes `.benchmark/retrospective.json`:

```json
{
  "novel_observations": "<what was new or unexpected this run>",
  "difficulties": "<what was hardest>",
  "would_do_differently": "<what you'd change next time>",
  "per_phase_impact": [
    { "phase": "scaffold", "impact": "<one sentence>" }
  ]
}
```

These prose fields are not scored but are diff-friendly across runs and give the "why" behind numeric deltas.

---

## How the data is captured

Three independent sources feed the analyzer:

1. **Claude Code transcript** — `~/.claude/projects/<encoded-cwd>/<session>.jsonl`. One JSON line per turn with `message.usage`, `message.content[].type == "tool_use"`, and timestamps.
2. **Benchmark hook log** — `$BENCHMARK_DIR/run/hook.log`. Written by opt-in hooks under `hooks/` when `BOOKHIVE_BENCHMARK=1`. Carries `phase.start`, `phase.end`, `subagent.dispatch` events keyed by turn index.
3. **Achilles self-report** — `<project>/.achilles/run-summary.json`. Written by an achilles Stop hook (see `ci/achilles-snippets/run-summary-writer.sh.template`). Carries semantic counts (scenarios, bugs, gates) the transcript cannot infer.

The analyzer joins all three by turn index → phase → run, walks `tests/` and `.bug-ledger/` on disk to verify the self-report, then computes the baseline comparison.

---

## Regression verdict

Three thresholds, configured in the schema (`regression_thresholds`):

- `tokens_total_pct` (default 25): if total tokens regress by ≥25% vs baseline → `warn`.
- `duration_pct` (default 50): if total duration regresses by ≥50% vs baseline → `warn`.
- `tests_ratio_drop` (default 0.10): if test-pass ratio drops by ≥0.10 → `fail`.

`run.truncated == true` always → `fail`. Schema-invalid output → `fail`.

`pass` only when all thresholds are within bounds.

---

## Non-goals

- **Not a flake monitor.** N=1 per run. Variance across runs is out of scope; rerun manually if you want a second data point.
- **Not a fairness benchmark.** Compares achilles-vs-achilles on one frozen target.
- **Not a CI security boundary.** `--dangerously-skip-permissions` is on in CI because that's the only way `claude -p` runs unattended. Standard "trust the PR's code as much as its tests" boundary.

See [`docs/superpowers/specs/2026-06-04-bookhive-benchmark-design.md`](docs/superpowers/specs/2026-06-04-bookhive-benchmark-design.md) for the full design rationale.
```

- [ ] **Step 2: Commit**

```bash
git add PROCESS.md
git commit -m "docs: write the real PROCESS.md (what we measure and why)"
```

---

### Task 6: Final pass + tag

- [ ] **Step 1: Full test sweep**

Run: `npm run typecheck && npm test && npm run test:sh`
Expected: all green.

- [ ] **Step 2: Tag**

```bash
git tag -a plan-3-complete -m "Plan 3 — CI + Achilles snippets + Docs complete"
```

---

## Self-review

- ✅ Spec §3 (`.github/workflows/`, `ci/achilles-snippets/`)
- ✅ Spec §7 (CI flow end-to-end)
- ✅ Spec §8 (achilles-side: trigger, static check, self-report writer — all snippets)
- ✅ Spec §10 layer 3 (workflow self-test)
- ✅ README + PROCESS replace the placeholders
