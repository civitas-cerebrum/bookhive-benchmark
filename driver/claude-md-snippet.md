<!-- BEGIN bookhive-benchmark managed block -->
## Benchmark mode active

This project is currently being benchmarked by `bookhive-benchmark`.

- BookHive is running at `http://localhost:8080`. It is this benchmark's own instance and you have full control over it: reseed or reset it (`POST /api/seed`) whenever a test or a probe needs a known state, create and delete accounts, orders and listings freely. No one else depends on its data.
- At end of session, write a structured retrospective to `.benchmark/retrospective.json` (the Stop hook will remind you if you forget).
- Do NOT modify anything under `.benchmark/` or files matching `~/.claude/hooks/(phase|subagent|stop)-*.sh`.
<!-- END bookhive-benchmark managed block -->
