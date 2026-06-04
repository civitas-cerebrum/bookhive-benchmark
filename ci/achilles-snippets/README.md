# Achilles-side snippets

These files belong in the **achilles** repo, not here. Copy them, replacing `__OWNER__` with your GitHub user/org.

## What to copy

| Source (here)                          | Destination (in achilles)                            |
| -------------------------------------- | ---------------------------------------------------- |
| `benchmark-trigger.yml.template`       | `.github/workflows/benchmark-trigger.yml`            |
| `benchmark-json-check.yml.template`    | `.github/workflows/benchmark-json-check.yml`         |
| `run-summary-writer.sh.template`       | `hooks/run-summary-writer.sh`                        |

## Secrets to configure

**In `bookhive-benchmark`** repo Settings → Secrets and variables → Actions:

- `ACHILLES_BENCHMARK_TOKEN` — fine-grained PAT scoped to your `achilles` repo with `pull-requests: write`, `checks: write`, `contents: read`.
- `ANTHROPIC_API_KEY` — for `claude -p` in the runner.

**In `achilles`** repo Settings → Secrets and variables → Actions:

- `BENCHMARK_DISPATCH_TOKEN` — PAT with `contents: write` on `bookhive-benchmark` (enough to send `repository_dispatch`).

## Register the Stop hook in achilles

The `run-summary-writer.sh` is a Stop hook. Achilles ships `scripts/sync-hooks.js` which already registers `hooks/*.sh` files into `~/.claude/settings.json` on `postinstall`. As long as the file is added to `achilles/hooks/` and `scripts/sync-hooks.js` is invoked, it will be wired automatically.

If you prefer manual registration, add to `~/.claude/settings.json`:

```json
"Stop": [
  { "command": "/abs/path/to/achilles/hooks/run-summary-writer.sh" }
]
```

## Verifying the integration

1. Open a no-op PR against `achilles`.
2. Confirm the `Benchmark JSON present` check runs and either passes (you included a results.json) or fails clearly (you didn't).
3. Confirm `repository_dispatch` fires (visible in achilles Actions tab as `🧪 Benchmark trigger`).
4. Confirm `bookhive-benchmark` workflow starts in this repo and posts a check_run + comment back.
