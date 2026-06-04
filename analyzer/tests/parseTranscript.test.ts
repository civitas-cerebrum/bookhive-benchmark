import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../src/parseTranscript.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

describe('parseTranscript', () => {
  it('extracts turn events with usage and tool calls from a happy transcript', async () => {
    const path = join(here, 'fixtures/happy/transcript.jsonl');
    const turns = await parseTranscript(path);

    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatchObject({ turn_index: 0, role: 'user', tool_calls: [] });
    expect(turns[1]).toMatchObject({
      turn_index: 1,
      role: 'assistant',
      tokens: { input: 120, output: 40, cache_read: 0, cache_creation: 50, total: 210 },
      tool_calls: [{ name: 'Bash' }],
    });
    expect(turns[2]?.tool_calls[0]?.name).toBe('Task');
  });

  it('throws clear error when file is missing', async () => {
    await expect(parseTranscript('/nope/no.jsonl')).rejects.toThrow(/transcript file not found/i);
  });
});
