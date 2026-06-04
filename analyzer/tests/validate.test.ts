import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateResults, validateRunSummary } from '../src/validate.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('validateResults', () => {
  it('accepts the happy expected output', async () => {
    const data = JSON.parse(await readFile(join(here, 'fixtures/happy/expected-results.json'), 'utf8'));
    expect(await validateResults(data)).toEqual({ ok: true });
  });
  it('rejects when schema_version is wrong', async () => {
    const r = await validateResults({ schema_version: '0.0.0' });
    expect(r.ok).toBe(false);
  });
});

describe('validateRunSummary', () => {
  it('accepts the happy fixture self-report', async () => {
    const data = JSON.parse(await readFile(join(here, 'fixtures/happy/run-summary.json'), 'utf8'));
    expect(await validateRunSummary(data)).toEqual({ ok: true });
  });
});
