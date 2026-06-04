import { describe, it, expect } from 'vitest';
import { parseHookLog } from '../src/parseHookLog.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

describe('parseHookLog', () => {
  it('parses each line into a typed HookEvent', async () => {
    const events = await parseHookLog(join(here, 'fixtures/happy/hook.log'));
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ kind: 'phase.start', phase: 'scaffold', turn_index: 0 });
    expect(events[1]).toMatchObject({ kind: 'phase.end', gate_result: 'pass' });
    expect(events[3]).toMatchObject({ kind: 'subagent.dispatch', subagent_type: 'general-purpose' });
  });

  it('returns empty array when file is missing', async () => {
    expect(await parseHookLog('/nope/no.log')).toEqual([]);
  });

  it('skips malformed lines', async () => {
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'hooklog-'));
    const f = join(dir, 'hook.log');
    await writeFile(f, '{"good":1}\nnot json\n{"t":"x","kind":"phase.start","phase":"scaffold","turn_index":0}\n');
    const out = await parseHookLog(f);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('phase.start');
  });
});
