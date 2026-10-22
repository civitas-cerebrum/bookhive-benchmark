# bookhive-benchmark

> Public benchmarking harness for [`@civitas-cerebrum/achilles`](https://www.npmjs.com/package/@civitas-cerebrum/achilles).

Runs the full 8-phase achilles onboarding workflow against a frozen BookHive docker image and records process metrics (tokens, durations, subagent dispatches, gate stats) plus outcome metrics (scenarios produced, bugs filed, generated suite pass rate) in a canonical `results.json`.

Every achilles PR must include an updated `results.json` from a local run; achilles also fires a CI run of this benchmark and posts results back as a PR comment + check.

---

## Quick start (local)

```sh
# 1) Clone next to your local achilles checkout
cd ~/code
git clone https://github.com/Umutayb/bookhive-benchmark.git
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
- An achilles checkout. Default discovery: sibling at `../achilles`. Override with `ACHILLES_PATH=/abs/path ./restart.sh`. `restart.sh` runs `npm pack` on it and installs the tarball (not the folder, which npm symlinks and achilles' postinstall skips), then verifies the harness landed.

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
├── baseline/                 # baseline.json (updated on main)
└── results/                  # per-run results (gitignored except .gitkeep)
```

---

## Tests

```sh
npm test          # TypeScript: analyzer + CLI (vitest)
npm run test:sh   # POSIX shell: emit, settings-patch, cleanup (bats)
npm run typecheck # strict TS
```

CI runs all three on every PR to this repo (`.github/workflows/self-test.yml`).

---

## Contributing

1. Open a PR with your changes.
2. Run the benchmark locally and update `baseline/baseline.json` if your changes affect the baseline (rare).
3. CI runs all tests on every PR.

For changes that affect achilles directly, see [`ci/achilles-snippets/README.md`](ci/achilles-snippets/README.md) for the changes achilles needs.

---

## License

MIT
