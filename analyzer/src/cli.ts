#!/usr/bin/env -S npx tsx
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseTranscript } from './parseTranscript.js';
import { parseHookLog } from './parseHookLog.js';
import { readSelfReport } from './readSelfReport.js';
import { readRetrospective } from './readRetrospective.js';
import { assemble, crossCheckOnDisk } from './assemble.js';
import { compare, readBaseline } from './compare.js';
import { validateResults } from './validate.js';
import type { AssembleInputs } from './types.js';
import { runBaseline } from './baselineCli.js';
import { deriveEvidence } from './deriveEvidence.js';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

function envOr(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

async function readMetaJson(path: string | undefined): Promise<AssembleInputs['meta']> {
  if (path) {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as AssembleInputs['meta'];
  }
  const os = await import('node:os');
  return {
    achilles_version: envOr('ACHILLES_VERSION', 'unknown'),
    achilles_commit: envOr('ACHILLES_COMMIT', 'unknown'),
    claude_code_version: envOr('CLAUDE_CODE_VERSION', 'unknown'),
    mode: (envOr('BENCHMARK_MODE', 'local') as 'local' | 'ci'),
    host: {
      runner_os: process.platform,
      cpu_count: os.cpus().length,
      mem_gb: Math.round(os.totalmem() / (1024 ** 3)),
    },
  };
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'baseline') {
    process.exit(await runBaseline(process.argv.slice(3)));
  }
  if (cmd !== 'analyze') {
    console.error('usage: bookhive-benchmark baseline <record|promote|show> | analyze --transcript <path> --hooks <path> --self-report <path> --retro <path> [--baseline <path>] [--out <path>] [--meta <path>] [--project-dir <path>]');
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(3));
  const transcript = args.transcript;
  if (!transcript) { console.error('--transcript is required'); process.exit(2); }
  const hookLog = args.hooks ?? '/dev/null';
  const selfReportPath = args['self-report'] ?? '/dev/null';
  const retroPath = args.retro ?? '/dev/null';
  const baselinePath = args.baseline;
  const outPath = resolve(args.out ?? `results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const metaPath = args.meta;

  const [turns, hookEvents, selfReport, retrospective, baseline, meta] = await Promise.all([
    parseTranscript(transcript),
    parseHookLog(hookLog),
    readSelfReport(selfReportPath),
    readRetrospective(retroPath),
    baselinePath ? readBaseline(baselinePath) : Promise.resolve(null),
    readMetaJson(metaPath),
  ]);

  const projectDir = args['project-dir'];
  const evidence = await deriveEvidence(transcript, projectDir);
  const assembled = assemble({ turns, hookEvents, selfReport, retrospective, meta, evidence });
  const checked = projectDir ? await crossCheckOnDisk(assembled, projectDir) : assembled;
  const final = compare(checked, baseline);

  const v = await validateResults(final);
  if (!v.ok) {
    console.error('results failed schema validation:');
    for (const e of v.errors) console.error('  -', e);
    process.exit(3);
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(final, null, 2) + '\n', 'utf8');
  console.log(outPath);
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
