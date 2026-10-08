import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { ROOT, sourceFiles, digest } from './qa-helpers.mjs';

const files = sourceFiles();
const sprint = process.argv.includes('--sprint=2') ? 2 : 1;
const fingerprint = digest(ROOT, files);
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${fingerprint.slice(0, 8)}`;
const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hanzi-qa-'));
fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), runId);
const snapshot = path.join(work, 'candidate');
const buildState = path.join(work, 'build-state');
const output = path.join(ROOT, 'outputs', 'qa', runId);
fs.mkdirSync(snapshot); fs.mkdirSync(buildState); fs.mkdirSync(output, { recursive: true });
for (const file of files) {
  const dest = path.join(snapshot, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, file), dest);
}
if (digest(snapshot, files) !== fingerprint) throw new Error('Source changed while snapshotting; retry once edits are complete');
const candidateId = `s${sprint}-${fingerprint.slice(0, 12)}`;
const env = {
  ...process.env, npm_config_cache: process.env.HANZI_NPM_CACHE || path.join(os.tmpdir(), 'hanzi-npm-cache'),
  HANZI_PREVIEW_MODE: '1', HANZI_TEST_MODE: '1', HANZI_TEST_STATE_DIR: buildState,
  HANZI_TEST_RUN_ID: runId, HANZI_TEST_TOKEN: crypto.randomBytes(24).toString('hex'),
  HANZI_CANDIDATE_ID: candidateId, WRANGLER_SEND_METRICS: 'false',
};
const checks = [];
for (const args of [['ci', '--no-audit', '--no-fund'], ['run', 'typecheck'], ['test'], ['run', 'curriculum:check'], ['run', 'lint'], ['run', 'build']]) {
  const name = args.join('-').replaceAll('/', '-');
  console.log(`Candidate ${candidateId}: npm ${args.join(' ')}`);
  const result = spawnSync('npm', args, { cwd: snapshot, env, encoding: 'utf8', maxBuffer: 12_000_000 });
  fs.writeFileSync(path.join(output, `${name}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  checks.push({ command: `npm ${args.join(' ')}`, exitCode: result.status });
  if (result.status !== 0) {
    console.error((result.stdout ?? '').slice(-10000), (result.stderr ?? '').slice(-4000));
    fs.writeFileSync(path.join(output, 'prepare-failure.json'), JSON.stringify({ candidateId, work, checks }, null, 2));
    process.exit(result.status || 1);
  }
}
const manifest = {
  runId, candidateId, specVersion: sprint === 2 ? 's2-spec-1' : 's1-spec-2', lessonVersion: 'forest-01-v1',
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim(),
  digest: fingerprint, files, work, snapshot, buildState, output, checks,
  node: process.version, browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.tmpdir(), 'hanzi-playwright-browsers'),
  createdAt: new Date().toISOString(),
};
const manifestFile = path.join(output, 'manifest.json');
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(ROOT, 'outputs', 'qa', 'latest.json'), JSON.stringify({ manifest: manifestFile }));
console.log(`Prepared isolated candidate. Manifest: ${manifestFile}`);
