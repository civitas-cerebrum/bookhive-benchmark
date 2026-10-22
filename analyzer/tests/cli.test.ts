import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');

describe('cli analyze', () => {
  it('produces a schema-valid results.json for the happy fixture', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'bhb-'));
    const out = join(outDir, 'results.json');
    await exec('npx', [
      'tsx', 'analyzer/src/cli.ts', 'analyze',
      '--transcript', 'analyzer/tests/fixtures/happy/transcript.jsonl',
      '--hooks', 'analyzer/tests/fixtures/happy/hook.log',
      '--self-report', 'analyzer/tests/fixtures/happy/run-summary.json',
      '--retro', 'analyzer/tests/fixtures/happy/retrospective.json',
      '--baseline', 'analyzer/tests/fixtures/baseline/baseline.json',
      '--out', out,
    ], { cwd: repoRoot });

    const data = JSON.parse(await readFile(out, 'utf8'));
    expect(data.schema_version).toBe('1.0.0');
    expect(data.baseline_comparison.regression_verdict).toBe('pass');
  }, 30_000);
});
