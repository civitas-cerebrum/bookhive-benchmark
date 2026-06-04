# CI workflows

The runnable workflow lives at the GitHub-expected path:

- `.github/workflows/benchmark.yml` — handles `repository_dispatch: { types: [achilles-pr] }` and `workflow_dispatch`.
- `.github/workflows/self-test.yml` — `workflow_dispatch` self-test with a fake `claude` binary; verifies the analyzer + reporting steps without burning API credits.

This directory is a pointer; do not duplicate the YAML here.
