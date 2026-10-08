// Frozen independent coordinator. Accepts a private runner handoff, never PASS JSON.
import assert from 'node:assert/strict';
import {
  readFile,
  writeFile,
  mkdir,
  realpath,
  stat,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { REQUIRED_SCENARIOS, CONTRACT } from './oracle.mjs';
const args = process.argv.slice(2),
  flags = {};
for (let i = 0; i < args.length; i += 2) {
  assert(
    ['--handoff', '--output', '--mode'].includes(args[i]),
    'Undocumented coordinator option',
  );
  assert(!Object.hasOwn(flags, args[i]), 'Duplicate coordinator option');
  assert(args[i + 1], 'Option value required');
  flags[args[i]] = args[i + 1];
}
assert.equal(flags['--mode'], 'proof');
assert(flags['--handoff'] && flags['--output']);
const handoffPath = await realpath(flags['--handoff']);
assert.equal(handoffPath, path.resolve(flags['--handoff']));
const info = await stat(handoffPath);
assert(info.isFile() && info.size <= 1048576);
assert.equal(info.mode & 0o077, 0, 'Private handoff must be0600');
const handoff = JSON.parse(await readFile(handoffPath, 'utf8'));
const output = path.resolve(flags['--output']);
assert.equal(await realpath(path.dirname(output)), path.dirname(output));
// Runtime owner constrains output parent/marker; coordinator additionally refuses
// pre-existing output so evidence cannot replace a previous run.
await mkdir(output, { recursive: false, mode: 0o700 });
const requiredIdentity = [
  'candidateId',
  'sourceDigest',
  'artifactDigest',
  'buildId',
  'lessonVersion',
  'contentDigest',
  'evidenceInstallationId',
  'targetInstallationId',
  'namespace',
];
for (const field of requiredIdentity)
  assert(
    typeof handoff[field] === 'string' && handoff[field].length > 0,
    `Missing frozen identity ${field}`,
  );
assert.equal(handoff.lessonVersion, CONTRACT.lesson);
for (const field of ['sourceDigest', 'artifactDigest', 'contentDigest'])
  assert(/^sha256:[a-f0-9]{64}$/.test(handoff[field]), `Invalid ${field}`);
const report = {
  schemaVersion: 'r3-executed-report-1',
  ...Object.fromEntries(requiredIdentity.map((k) => [k, handoff[k]])),
  startedAt: Date.now(),
  finishedAt: null,
  scenarios: [],
  cases: [],
  testSourceHashes: {},
};
const sourceRoot = path.resolve(import.meta.dirname, '../..');
async function sourceHashes(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    assert(!item.isSymbolicLink(), 'Tester symlink refused');
    if (item.isDirectory()) await sourceHashes(file);
    else if (
      item.isFile() &&
      directory === import.meta.dirname &&
      item.name.endsWith('.mjs')
    ) {
      const relative = path
        .relative(sourceRoot, file)
        .split(path.sep)
        .join('/');
      report.testSourceHashes[relative] = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
    }
  }
}
await sourceHashes(import.meta.dirname);
let runtime;
try {
  // Fixed relative adapter is frozen with coordinator; handoff cannot select code.
  const { createRuntimeAdapter } = await import('./runtime-adapter.mjs');
  runtime = await createRuntimeAdapter({ handoff, handoffPath, output });
  await runtime.verifyFrozenIdentity();
  const suites = await runtime.createIndependentCases();
  assert(Array.isArray(suites) && suites.length > 0);
  const caseIds = new Set();
  for (const item of suites) {
    assert(
      typeof item.id === 'string' &&
        /^[a-zA-Z0-9_-]+$/.test(item.id) &&
        !caseIds.has(item.id) &&
        Array.isArray(item.scenarios) &&
        item.scenarios.every((id) => REQUIRED_SCENARIOS.includes(id)) &&
        typeof item.run === 'function',
    );
    caseIds.add(item.id);
    let outcome = 'PASS',
      detail;
    try {
      detail = await item.run();
      assert(
        Array.isArray(detail.evidenceRefs) && detail.evidenceRefs.length > 0,
        'Executed case requires real evidence files',
      );
      for (const file of detail.evidenceRefs) {
        assert(
          typeof file === 'string' &&
            !path.isAbsolute(file) &&
            !file.split('/').includes('..'),
        );
        const target = path.join(output, file);
        assert.equal(
          await realpath(target),
          target,
          'Evidence symlink refused',
        );
        assert((await stat(target)).isFile());
      }
    } catch (error) {
      outcome = error.code === 'QA_BLOCKED' ? 'BLOCKED' : 'FAIL';
      detail = { evidenceRefs: [], message: error.message };
    }
    const evidenceFile = `case-${item.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    await writeFile(
      path.join(output, evidenceFile),
      JSON.stringify({ id: item.id, outcome, ...detail }, null, 2) + '\n',
    );
    report.cases.push({
      id: item.id,
      outcome,
      evidenceRefs: [evidenceFile, ...detail.evidenceRefs],
      scenarioIds: item.scenarios,
    });
  }
  await runtime.verifyFrozenIdentity();
} catch (error) {
  await writeFile(
    path.join(output, 'preflight.json'),
    JSON.stringify({ outcome: 'BLOCKED', message: error.message }, null, 2) +
      '\n',
  );
  report.cases.push({
    id: 'runtime-preflight',
    outcome: 'BLOCKED',
    evidenceRefs: ['preflight.json'],
    scenarioIds: REQUIRED_SCENARIOS,
  });
} finally {
  try {
    await runtime?.cleanupOwnedContexts();
  } catch (error) {
    await writeFile(
      path.join(output, 'cleanup.json'),
      JSON.stringify({ outcome: 'FAIL', message: error.message }, null, 2) +
        '\n',
    );
    report.cases.push({
      id: 'owned-context-cleanup',
      outcome: 'FAIL',
      evidenceRefs: ['cleanup.json'],
      scenarioIds: REQUIRED_SCENARIOS,
    });
  }
  report.scenarios = REQUIRED_SCENARIOS.map((id) => {
    const cases = report.cases.filter((c) => c.scenarioIds.includes(id));
    return {
      id,
      outcome:
        !cases.length || cases.some((c) => c.outcome === 'BLOCKED')
          ? 'BLOCKED'
          : cases.some((c) => c.outcome === 'FAIL')
            ? 'FAIL'
            : 'PASS',
      caseIds: cases.map((c) => c.id),
      evidenceFiles: [...new Set(cases.flatMap((c) => c.evidenceRefs))],
    };
  });
  // Private adapter metadata and credential material never enter this report.
  report.cases = report.cases.map(({ scenarioIds: _, ...rest }) => rest);
  report.finishedAt = Date.now();
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
process.exitCode = report.scenarios.every((s) => s.outcome === 'PASS') ? 0 : 1;
