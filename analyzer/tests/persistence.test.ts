import { describe, it, expect } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');

const read = (rel: string) => readFile(join(repoRoot, rel), 'utf8');

/** Non-comment, non-blank lines of a shell script. */
function code(src: string): string[] {
  return src.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/** baseline or results as a whole path segment (so test-results/ does not match). */
const PROTECTED = /(^|[\s/"'=])(baseline|results)([/\s"']|$)/;
const DESTRUCTIVE = /^(rm|mv|find|git\s+(clean|checkout|restore|reset|stash)|truncate|shred|unlink|rsync\b.*--delete)\b/;

describe('baseline/ and results/ survive cleanup and restart (static)', () => {
  for (const script of ['scripts/cleanup.sh', 'restart.sh']) {
    it(`${script}: no destructive command can name baseline/ or results/`, async () => {
      const bad = code(await read(script)).filter((l) => DESTRUCTIVE.test(l) && PROTECTED.test(l));
      expect(bad).toEqual([]);
    });

    it(`${script}: no destructive command deletes the repo root or a bare glob`, async () => {
      const bad = code(await read(script)).filter(
        (l) => /^(rm|find|git\s+clean)\b/.test(l) && (/(^|\s)(\.|\*|\.\/|\.\/\*|"?\$ROOT"?\/?\*?|"?\$\{?ROOT\}?"?\/?\*?)(\s|$)/.test(l) || /git\s+clean/.test(l) || /\s-delete\b/.test(l)),
      );
      expect(bad).toEqual([]);
    });
  }

  it('cleanup.sh only deletes an explicit allowlist of generated paths', async () => {
    const targets = new Set<string>();
    for (const l of code(await read('scripts/cleanup.sh'))) {
      const m = /^rm\s+(?:-[a-zA-Z]+\s+)+(.*)$/.exec(l);
      if (m) for (const t of m[1]!.split(/\s+/)) targets.add(t.replace(/^"|"$/g, ''));
    }
    const allowed = new Set([
      'tests', 'playwright-report', 'test-results', 'playwright.config.ts', 'package-lock.json.achilles-bak',
      '.benchmark', '.achilles', 'node_modules', '"${HOME}/.claude/hooks/$f"', '${HOME}/.claude/hooks/$f',
    ]);
    const unexpected = [...targets].filter((t) => !allowed.has(t));
    expect(unexpected, 'new rm target in cleanup.sh: make sure it is not baseline/ or results/, then allowlist it here').toEqual([]);
  });

  it('cleanup.sh has the BENCHMARK_SKIP_DOCKER guard on its docker step', async () => {
    expect(await read('scripts/cleanup.sh')).toMatch(/BENCHMARK_SKIP_DOCKER:-\}" != "1" \] && command -v docker/);
  });

  it('every test that runs cleanup.sh fakes docker', async () => {
    for (const f of ['analyzer/tests/persistence.test.ts', 'analyzer/tests/sh/test-cleanup.bats']) {
      expect(await read(f), f).toMatch(/fakebin/);
    }
  });

  it('restart.sh --analyze records the run but never promotes it', async () => {
    const src = await read('restart.sh');
    expect(src).toMatch(/scripts\/baseline\.sh record "\$out_file"/);
    expect(code(src).join('\n')).not.toMatch(/baseline\.sh\s+promote/);
    expect(src.indexOf('baseline.sh record')).toBeLessThan(src.indexOf('scripts/cleanup.sh\n  echo'));
  });
});

describe('cleanup.sh leaves baseline/ and results/ intact (runs a copy in a sandbox)', () => {
  it('byte-identical after cleanup, while generated paths are removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bhb-persist-'));
    const home = join(root, 'home'); // cleanup.sh deletes files under $HOME/.claude/hooks: keep it away from the real one
    await mkdir(home, { recursive: true });
    const proj = join(root, 'proj');
    await mkdir(join(proj, 'scripts'), { recursive: true });
    await cp(join(repoRoot, 'scripts/cleanup.sh'), join(proj, 'scripts/cleanup.sh'));
    await cp(join(repoRoot, 'scripts/settings-patch.sh'), join(proj, 'scripts/settings-patch.sh'));
    await cp(join(repoRoot, 'scripts/compose.sh'), join(proj, 'scripts/compose.sh'));
    await cp(join(repoRoot, 'baseline'), join(proj, 'baseline'), { recursive: true });
    await mkdir(join(proj, 'results'));
    await writeFile(join(proj, 'results/2026-10-01T00-00-00Z.json'), '{"keep":"me"}\n');
    await writeFile(join(proj, 'results/.gitkeep'), '');
    // generated state cleanup is supposed to delete
    await mkdir(join(proj, 'tests/e2e'), { recursive: true });
    await mkdir(join(proj, '.benchmark'));
    await mkdir(join(proj, '.achilles'));
    await mkdir(join(proj, 'node_modules'));
    await writeFile(join(proj, 'tests/e2e/a.spec.ts'), '');

    const snapshot = async (sub: string) => {
      const base = join(proj, sub);
      const names = (await readdir(base)).sort();
      return Promise.all(names.map(async (n) => [n, await readFile(join(base, n), 'utf8')] as const));
    };
    const beforeBaseline = await snapshot('baseline');
    const beforeResults = await snapshot('results');

    // Fake docker first on PATH (records args, exits 0) plus the skip guard: this test must never reach a real daemon.
    const fakebin = join(root, 'fakebin');
    await mkdir(fakebin);
    await writeFile(join(fakebin, 'docker'), `#!/bin/sh\necho "$@" >> "${root}/docker.calls"\nexit 0\n`, { mode: 0o755 });
    await mkdir(join(proj, 'driver'));
    await writeFile(join(proj, 'driver/docker-compose.yml'), 'services: {}\n');
    const run = (extra: Record<string, string>) =>
      exec('sh', [join(proj, 'scripts/cleanup.sh')], { cwd: proj, env: { PATH: `${fakebin}:/usr/bin:/bin`, HOME: home, ...extra } });

    await run({ BENCHMARK_SKIP_DOCKER: '1' });
    await expect(stat(join(root, 'docker.calls'))).rejects.toThrow(); // guard honoured
    await run({});
    // compose.sh probes `docker compose version` before the real call.
    expect((await readFile(join(root, 'docker.calls'), 'utf8')).trim().split('\n')).toEqual(['compose version', 'compose -f driver/docker-compose.yml down -v --remove-orphans']);

    expect(await snapshot('baseline')).toEqual(beforeBaseline);
    expect(await snapshot('results')).toEqual(beforeResults);
    expect(beforeBaseline.map(([n]) => n)).toEqual(expect.arrayContaining(['baseline.json', 'history.jsonl']));
    for (const gone of ['tests', '.benchmark', '.achilles', 'node_modules']) {
      await expect(stat(join(proj, gone))).rejects.toThrow();
    }
  }, 30_000);
});

describe('shell syntax', () => {
  for (const f of ['restart.sh', 'scripts/baseline.sh', 'scripts/cleanup.sh', 'scripts/settings-patch.sh']) {
    it(`sh -n ${f}`, async () => {
      await exec('sh', ['-n', join(repoRoot, f)]);
    });
  }
});
