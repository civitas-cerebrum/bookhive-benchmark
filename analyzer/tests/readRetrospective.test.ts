import { describe, it, expect } from 'vitest';
import { readRetrospective } from '../src/readRetrospective.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

describe('readRetrospective', () => {
  it('reads a retrospective json', async () => {
    const r = await readRetrospective(join(here, 'fixtures/happy/retrospective.json'));
    expect(r?.novel_observations).toMatch(/onboarding/i);
    expect(r?.per_phase_impact).toHaveLength(2);
  });
  it('returns null when file is missing', async () => {
    expect(await readRetrospective('/nope.json')).toBeNull();
  });
});
