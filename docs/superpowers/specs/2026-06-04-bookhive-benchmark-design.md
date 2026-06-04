# bookhive-benchmark — Design Spec

**Date:** 2026-06-04
**Status:** Approved (brainstorming complete)
**Author:** Umut Ay Bora (with Claude)

## 1. Purpose

`bookhive-benchmark` is the public, open-source benchmarking harness for the [`@civitas-cerebrum/achilles`](https://www.npmjs.com/package/@civitas-cerebrum/achilles) autonomous QA methodology. It runs a full achilles onboarding workflow against a frozen BookHive docker image and records both **process efficiency** (tokens, durations, dispatches, gate stats) and **outcome quality** (scenarios produced, bugs filed, generated suite pass rate) in a canonical `results.json`.

The harness has two runners — interactive local (contributor's laptop, Claude Code Max subscription) and headless CI (GitHub Actions, Anthropic API) — that share one analyzer. Every achilles pull request is gated by two checks: a static check that the contributor included an updated `results.json`, and a dynamic check from a benchmark CI run triggered via `repository_dispatch`.

## 2. Goals & non-goals

### Goals

- Measure achilles end-to-end on a stable, reproducible target (BookHive at a pinned image tag).
- Capture both resource cost AND output quality so a "cheap-but-broken" regression cannot pass.
- Use three telemetry sources (Claude Code transcript, achilles self-report, opt-in benchmark hooks) and cross-check them for discrepancies — a key reliability signal.
- Run identically (same `restart.sh`) locally and in CI; the only divergence is whether a human or `claude -p` drives the session.
- Be small enough that an open-source contributor can clone, run, and understand it in an afternoon.

### Non-goals

- **Not a flake monitor.** N=1 per run by design. Cross-run variance is out of scope.
- **Not a fairness benchmark.** Compares achilles-vs-achilles on one target, not achilles-vs-other-agents or achilles across diverse apps.
- **Not a CI security boundary.** CI uses `--dangerously-skip-permissions` because that's how `claude -p` runs unattended. Standard "trust the PR's code as much as its tests" boundary.
- **Not a published npm package.** Public repo, MIT, clone-and-run.
- **Not coupled to a moving BookHive.** Image pinned to an immutable digest; bumping is a normal PR with a fresh baseline.

## 3. Architecture overview

Four small, well-bounded components plus four committed config/data dirs:

```
bookhive-benchmark/
├── README.md                    # contributor manual
├── PROCESS.md                   # what the benchmark measures, how, why
├── restart.sh                   # local prepare: clean → install → ready
├── analyzer/                    # pure-TS library, zero side effects
│   ├── src/{parseTranscript,parseHookLog,readSelfReport,assemble,schema,compare}.ts
│   ├── tests/                   # golden fixtures
│   └── package.json
├── hooks/                       # opt-in benchmark telemetry hooks (env-gated, sh)
│   ├── phase-start.sh           # writes one JSON line per phase entry
│   ├── phase-end.sh             # writes one JSON line per phase exit
│   ├── subagent-dispatch.sh     # writes one JSON line per Task tool use
│   └── stop-retro.sh            # ensures retrospective.json exists at session end
├── driver/
│   ├── docker-compose.yml       # BookHive + deps with healthcheck
│   ├── run-ci.sh                # CI-only orchestration
│   ├── prepare-claude-md.sh     # writes a benchmark-aware CLAUDE.md hint
│   └── retro-prompt.txt         # the post-run retrospective prompt
├── ci/
│   ├── workflows/benchmark.yml  # this repo's workflow (handles repository_dispatch)
│   └── achilles-snippets/       # copy-paste templates for achilles repo
│       ├── benchmark-trigger.yml.template
│       └── benchmark-json-check.yml.template
├── baseline/
│   └── baseline.json            # 7-day rolling median across recent main runs
├── schema/
│   ├── results.schema.json      # the canonical results.json schema
│   └── run-summary.schema.json  # shared with achilles
└── scripts/
    └── cleanup.sh               # the single source of truth for "what stays"
```

### Component boundaries

- **`analyzer/` has zero I/O outside its arguments.** No shell, no docker, no network, no fs side effects beyond writing the final `results.json` at a path passed in. Pure functions over `(transcriptPath, hookLogPath, selfReportPath, baselinePath) → results`. Golden-file tests cover regressions cheaply.
- **`hooks/` are POSIX shell.** Each script reads hook input JSON on stdin (provided by Claude Code), no-ops unless `BOOKHIVE_BENCHMARK=1` is set, appends one JSON line to `$BENCHMARK_DIR/run/hook.log`. ~30 lines each.
- **`driver/` is shell-first.** `restart.sh` is the only script most contributors will read.
- **`ci/` is YAML.** No business logic in workflows — they delegate to `restart.sh`, `claude -p`, and the analyzer.

### Dependency graph (no cycles)

```
restart.sh ─┬─> scripts/cleanup.sh
            ├─> docker-compose ──> bookhive
            ├─> npm install ../achilles (or $ACHILLES_PATH)
            └─> copies hooks/* to ~/.claude/hooks/, registers in settings.json (idempotent)

run-ci.sh ──> restart.sh, then `claude -p`, then analyzer, then post-results

analyzer/ ──> reads transcript + hook.log + run-summary.json + retrospective.json,
              writes results.json (pure functions)

ci/workflows/benchmark.yml ──> run-ci.sh + analyzer + gh API
```

## 4. Telemetry pipeline

Three data sources flow into one canonical output.

### Source 1 — Benchmark hook log (phase boundaries)

Located at `~/.claude/hooks/{phase-start,phase-end,subagent-dispatch,stop-retro}.sh`, copied in by `restart.sh`, registered in `~/.claude/settings.json` via a magic comment marker so cleanup is surgical. Each hook is opt-in via `BOOKHIVE_BENCHMARK=1`. They append one JSON line per event to `$BENCHMARK_DIR/run/hook.log`:

```jsonl
{"t":"2026-06-04T10:12:03Z","kind":"phase.start","phase":"groundwork","turn_index":47}
{"t":"2026-06-04T10:18:51Z","kind":"phase.end","phase":"groundwork","turn_index":112,"gate_result":"pass"}
{"t":"2026-06-04T10:18:55Z","kind":"subagent.dispatch","parent_phase":"happy-path","subagent_type":"general-purpose","prompt_chars":1842}
```

These hooks read the same input JSON Claude Code already passes to achilles's existing `*-gate.sh` hooks. They do not change achilles behavior.

### Source 2 — Claude Code transcript

`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` — one line per turn, with `message.usage` (input/output/cache_read/cache_creation tokens), `message.content[].type == "tool_use"` for tool calls, and timestamps. The parser produces a flat list of turn events keyed by turn index — the same key the hook log uses, so joining is trivial.

### Source 3 — Achilles self-report

At end of session, achilles writes `<project>/.achilles/run-summary.json` containing its own view: phases entered, gate outcomes, scenarios produced (count + file paths), bugs filed (count + IDs), files written. The analyzer reads this for **semantic counts the transcript cannot infer** (e.g., is this `.spec.ts` file a scenario or a fixture).

### Source 4 (auxiliary) — Retrospective

`<project>/.benchmark/retrospective.json` — written by Claude in response to a Stop-hook-appended retrospective prompt at session end. Structure validated by `results.schema.json`'s `retrospective` field.

### Assembly

The analyzer joins all sources by turn index → phase → run, then walks `tests/` and `.bug-ledger/` on disk to verify the self-report's counts. Any disagreement produces a `discrepancies[]` entry — the cross-check value of the hybrid approach.

## 5. `results.json` canonical schema

```json
{
  "schema_version": "1.0.0",
  "run": {
    "id": "2026-06-04T10:12:00Z-abc123",
    "started_at": "2026-06-04T10:12:00Z",
    "ended_at": "2026-06-04T11:34:08Z",
    "duration_sec": 4928,
    "mode": "ci",
    "truncated": false,
    "achilles_version": "0.1.0",
    "achilles_commit": "abc123",
    "claude_code_version": "1.x.y",
    "host": {"runner_os": "ubuntu-22.04", "cpu_count": 4, "mem_gb": 16}
  },
  "totals": {
    "tokens": {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "total": 0},
    "turns": 0,
    "tool_calls": 0,
    "subagent_dispatches": 0,
    "gate_failures": 0,
    "retries": 0
  },
  "phases": [
    {
      "name": "scaffold",
      "started_at": "...",
      "ended_at": "...",
      "duration_sec": 0,
      "turns": 0,
      "tokens": {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "total": 0},
      "tool_calls_by_name": {"Bash": 0, "Read": 0, "Write": 0, "Task": 0},
      "subagent_dispatches": [
        {"subagent_type": "general-purpose", "duration_sec": 0, "tokens": {"total": 0}, "returned_ok": true}
      ],
      "gate_outcome": "pass",
      "retries": 0
    }
  ],
  "outcomes": {
    "scenarios_written": {"count": 0, "files": []},
    "bugs_filed": {"count": 0, "by_severity": {"high": 0, "med": 0, "low": 0}, "ids": []},
    "tests_passing": {"count": 0, "total": 0, "ratio": 0.0},
    "playwright_exit_code": 0,
    "journey_map_pages": 0
  },
  "retrospective": {
    "novel_observations": "...",
    "difficulties": "...",
    "would_do_differently": "...",
    "per_phase_impact": [{"phase": "scaffold", "impact": "..."}]
  },
  "discrepancies": [
    {"kind": "scenario_count_mismatch", "self_report": 12, "on_disk": 10, "detail": "..."}
  ],
  "baseline_comparison": {
    "baseline_id": "2026-05-30T...-main",
    "deltas": {
      "tokens.total": {"baseline": 0, "current": 0, "delta_pct": 0.0},
      "duration_sec": {"baseline": 0, "current": 0, "delta_pct": 0.0},
      "outcomes.tests_passing.ratio": {"baseline": 0.0, "current": 0.0, "delta_abs": 0.0}
    },
    "regression_verdict": "pass",
    "regression_thresholds": {"tokens_total_pct": 25, "duration_pct": 50, "tests_ratio_drop": 0.10}
  }
}
```

The achilles `phases[]` enumeration: `scaffold`, `groundwork`, `happy-path`, `journey-mapping`, `coverage-expansion`, `bug-discovery`, `secrets-sweep`, `report` (matches achilles's onboarding skill).

`regression_verdict` semantics:
- `pass` — all delta metrics within thresholds → PR check ✅
- `warn` — at least one informational threshold tripped → PR check 🟡 with comment, does not block
- `fail` — at least one blocking threshold tripped, OR `run.truncated == true`, OR schema invalid → PR check ❌ blocks merge

## 6. Local flow

```
$ ./restart.sh
  ├─ scripts/cleanup.sh                       # nuke prior run state
  ├─ resolve ACHILLES_PATH                    # ../achilles (default) or env override
  ├─ verify achilles package.json + name      # bail with clear error if invalid
  ├─ npm install "$ACHILLES_PATH"             # local install of achilles
  ├─ cp hooks/*.sh ~/.claude/hooks/           # benchmark hooks
  ├─ register hooks in ~/.claude/settings.json (idempotent, magic marker)
  ├─ docker compose up -d bookhive
  ├─ wait-for-healthcheck                     # block until /health returns 200
  ├─ write .env with BOOKHIVE_BENCHMARK=1, BENCHMARK_DIR, BOOKHIVE_URL
  ├─ write CLAUDE.md hint pointing at retro-prompt.txt
  └─ print: "Ready. Launch Claude Code and prompt: complete e2e test automation"

[User opens Claude Code, types the prompt, achilles runs end-to-end]
[Hooks emit to hook.log throughout the run]
[Achilles writes .achilles/run-summary.json at session end]
[Stop hook appends retrospective prompt if retrospective.json is missing]

$ ./restart.sh --analyze         # or auto-invoked by the Stop hook
  ├─ analyzer reads hook.log + transcript + run-summary.json + retrospective.json
  ├─ analyzer cross-checks self-report vs on-disk state
  ├─ analyzer computes baseline_comparison from baseline/baseline.json
  ├─ writes results/<timestamp>.json
  ├─ scripts/cleanup.sh
  └─ prints: "commit results/<timestamp>.json into your achilles PR at .benchmark/results.json"
```

Achilles discovery — default `../achilles`, override with `ACHILLES_PATH=/abs/path ./restart.sh`. Falls back to a clear error if neither resolves to a valid `@civitas-cerebrum/achilles` package.

## 7. CI flow

```
[achilles PR opened/synchronized]
  └─ achilles/.github/workflows/benchmark-trigger.yml
       └─ sends repository_dispatch to bookhive-benchmark
            payload: {pr_number, head_sha, achilles_ref, achilles_repo}

[bookhive-benchmark CI receives event]
  └─ ci/workflows/benchmark.yml
       ├─ checkout bookhive-benchmark @ main
       ├─ checkout achilles @ head_sha into ../achilles
       ├─ install Claude Code CLI
       ├─ docker compose up -d bookhive (with healthcheck)
       ├─ ./restart.sh                       # same script as local
       ├─ claude -p "complete e2e test automation" \
       │     --output-format=stream-json \
       │     --dangerously-skip-permissions \
       │     --max-turns 400
       ├─ ./restart.sh --analyze
       ├─ gh api PATCH /repos/<owner>/achilles/check-runs/...
       │     # publish check_run named "bookhive-benchmark"
       │     # conclusion = regression_verdict
       ├─ gh pr comment <pr> --repo achilles --body-file results-comment.md
       └─ upload results.json as workflow artifact
```

**Safety caps**: `--max-turns 400` and a 90-minute job timeout. If either trips, `results.json` is emitted with `run.truncated: true` and `regression_verdict: "fail"`. Truncated runs never pass.

**Token-cost guard**: a workflow step streams `stream-json` events and fails fast if cumulative tokens exceed a configured per-run cap (default 5M total tokens — value to be tuned during early runs).

**Secrets**:
- `bookhive-benchmark` repo: `ACHILLES_BENCHMARK_TOKEN` — fine-grained PAT scoped to the achilles repo with `pull-requests: write` + `checks: write` + `contents: read`. Plus `ANTHROPIC_API_KEY`.
- `achilles` repo: `BENCHMARK_DISPATCH_TOKEN` — PAT with `contents: write` (for `repository_dispatch`) on bookhive-benchmark.

Both documented in `README.md` so forks can configure their own.

## 8. Achilles-side changes

A single PR to achilles adds four items:

1. **Self-report writer** (`achilles/hooks/run-summary-writer.sh`, ~80 lines) — Stop hook that walks `tests/`, `.bug-ledger/`, and the journey map, writes `<project>/.achilles/run-summary.json` validated against `run-summary.schema.json`. Registered via existing `scripts/sync-hooks.js`.
2. **Trigger workflow** (`achilles/.github/workflows/benchmark-trigger.yml`, ~30 lines) — fires `repository_dispatch` to bookhive-benchmark on PR open/sync/reopen.
3. **Static JSON check** (`achilles/.github/workflows/benchmark-json-check.yml`, ~25 lines) — verifies `.benchmark/results.json` is present, changed in this PR, and schema-valid.
4. **README note** — one short section linking to bookhive-benchmark and explaining the two PR checks.

**Benchmark hooks live in bookhive-benchmark, not achilles** — copied to `~/.claude/hooks/` by `restart.sh`. Keeps benchmark schema drift from forcing an achilles release.

**No skill changes.** No `package.json` changes other than (optionally) a `benchmark:link-local` convenience script.

## 9. Cleanup contract

`scripts/cleanup.sh` runs at the start of every `restart.sh` AND after every analyze step. Single source of truth.

**Always kept**:
- All committed repo files (README, PROCESS, restart.sh, package.json, tsconfig.json, .gitignore)
- Full subtrees: `analyzer/`, `hooks/`, `driver/`, `ci/`, `schema/`, `baseline/`, `scripts/`
- `results/` and any `results/*.json` from prior runs
- `.git/`

**Always nuked**:
- `node_modules/` (including installed `@civitas-cerebrum/achilles`)
- `tests/`, `playwright.config.ts`, `playwright-report/`, `test-results/` — achilles-generated scaffolding
- `.benchmark/run/` — hook log, intermediate state
- `.achilles/` — self-report and working files
- Docker volumes from prior BookHive container (`docker compose down -v`)
- Benchmark entries in `~/.claude/hooks/` and `~/.claude/settings.json` (surgical, magic-marker-bounded)

**Deliberately untouched**:
- Other `~/.claude/hooks/*`
- Other `~/.claude/settings.json` entries
- `~/.claude/projects/<encoded-cwd>/*.jsonl` (transcripts — keep for forensics)

Cleanup failures log a warning but do not error. Next `restart.sh` redoes the work.

## 10. Testing strategy

### Analyzer unit tests (the only place with real logic)

- Golden-file fixtures in `analyzer/tests/fixtures/` — one full triple (transcript + hook log + run-summary) per scenario: happy run, truncated run, gate failure, scenario-count mismatch, missing self-report, schema-invalid input.
- `assemble.ts` and `compare.ts` are pure functions — assert deep equality on output `results.json`.
- Schema validator runs on every fixture's expected output (keeps schema and assembler honest).
- Target ~90% branch coverage on the analyzer. No coverage targets for shell.

### Shell smoke tests

- `bats` (or plain sh) test per hook script: feed canned hook input JSON on stdin, assert the appended log line.
- One `restart.sh` test that mocks `npm install` and `docker compose` (PATH shim) and asserts side effects: hooks copied, settings.json patched, env file written.
- No end-to-end Claude Code in tests.

### CI workflow self-test

- `workflow_dispatch` job runs `ci/workflows/benchmark.yml` against a fixture achilles ref with a fake `claude` binary on PATH (replays a recorded transcript). Verifies GH API calls, check_run publishing, comment formatting end-to-end without burning real credits.

### What we deliberately don't test in CI

- A real achilles onboarding run. That **is** the benchmark. Acceptance for the benchmark itself is "the next real achilles PR produces a sane results.json against main."

## 11. Open items (intentionally deferred)

These don't block design approval but should be revisited during implementation or post-MVP:

- **BookHive image pin** — pick a digest before merging this design's plan. A pin bump is a normal PR with a fresh baseline.
- **Per-run token cap** — default 5M tokens in CI; tune after first ~5 real runs.
- **Baseline rotation policy** — 7-day rolling median across passing main runs. Single-run baselines would be too noisy.
- **Comment template** — comment body Markdown lives in `ci/workflows/benchmark.yml`. First draft inline; refine after real runs.
- **Cross-run variance follow-up** — if consistency becomes a real question, add a `workflow_dispatch`-driven N=5 nightly job. Out of scope for MVP.

## 12. Decisions log

| Decision | Choice | Rationale |
|---|---|---|
| Scoring scope | Process + outcome | Catches cheap-but-broken regressions. |
| Telemetry source | Hybrid (hooks + transcript + achilles self-report) | Independent observation cross-checked against authoritative self-report. |
| CI execution | Headless `claude -p` on every achilles PR | Maximum signal; cost accepted. |
| Run cardinality | N=1, baseline-compare | Single-run + rolling baseline; variance follow-up deferred. |
| Qualitative source | Post-run retrospective prompt to Claude | Consistent structure, low marginal cost. |
| Container lifecycle | docker-compose, fresh per run, torn down after | Deterministic baseline. |
| Achilles discovery | `../achilles` default + `ACHILLES_PATH` override | Convention with escape hatch. |
| Cross-repo bridge | `repository_dispatch` + bot comment + check_run | Standard pattern; observable in both repos. |
| Architecture | Layered (hooks · analyzer · driver · ci) | Isolates logic to pure-TS analyzer for cheap testing. |
| Benchmark hooks home | bookhive-benchmark (not achilles) | Schema drift isolated to this repo. |

---

*End of design spec.*
