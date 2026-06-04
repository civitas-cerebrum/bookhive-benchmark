import { describe, it, expect } from 'vitest';
import { readSelfReport } from '../src/readSelfReport.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

describe('readSelfReport', () => {
  it('reads and returns a parsed SelfReport', async () => {
    const sr = await readSelfReport(join(here, 'fixtures/happy/run-summary.json'));
    expect(sr?.phases).toHaveLength(8);
    expect(sr?.scenarios.files).toContain('tests/auth.spec.ts');
    expect(sr?.bugs.by_severity.med).toBe(1);
  });
  it('returns null when file is missing', async () => {
    expect(await readSelfReport('/nope.json')).toBeNull();
  });
});
