import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTranscript } from '../src/parseTranscript.js';
import { parseHookLog } from '../src/parseHookLog.js';
import { readSelfReport } from '../src/readSelfReport.js';
import { readRetrospective } from '../src/readRetrospective.js';
import { assemble } from '../src/assemble.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, 'fixtures/happy', name);

describe('assemble', () => {
  it('produces the expected results for the happy fixture', async () => {
    const turns = await parseTranscript(fixture('transcript.jsonl'));
    const hookEvents = await parseHookLog(fixture('hook.log'));
    const selfReport = await readSelfReport(fixture('run-summary.json'));
    const retrospective = await readRetrospective(fixture('retrospective.json'));

    const result = assemble({
      turns,
      hookEvents,
      selfReport,
      retrospective,
      meta: {
        achilles_version: '0.1.0',
        achilles_commit: 'abc1234567',
        claude_code_version: '1.0.0',
        mode: 'local',
        host: { runner_os: 'darwin', cpu_count: 8, mem_gb: 16 },
      },
    });
    const expected = JSON.parse(await readFile(fixture('expected-results.json'), 'utf8'));
    expect(result).toEqual(expected);
  });

  it('records a discrepancy when self-report is missing', async () => {
    const turns = await parseTranscript(fixture('transcript.jsonl'));
    const hookEvents = await parseHookLog(fixture('hook.log'));
    const result = assemble({
      turns,
      hookEvents,
      selfReport: null,
      retrospective: null,
      meta: {
        achilles_version: '0.1.0',
        achilles_commit: 'abc1234567',
        claude_code_version: '1.0.0',
        mode: 'local',
        host: { runner_os: 'darwin', cpu_count: 8, mem_gb: 16 },
      },
    });
    expect(result.discrepancies.some((d) => d.kind === 'self_report_missing')).toBe(true);
    expect(result.discrepancies.some((d) => d.kind === 'retrospective_missing')).toBe(true);
  });
});
