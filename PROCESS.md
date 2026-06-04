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
