// Frozen per-package execution coordinator; cannot accept caller PASS reports.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LESSONS, COLLECTION } from './oracle.mjs';
import { createHttpAdapter } from './http-runner.mjs';
import { runHttpSuite } from './http-suite.mjs';
import { createBrowserAdapter } from './browser-adapter.mjs';
import { runBrowserSuite } from './browser-suite.mjs';
const required = [
  'selection',
  'approval',
  'recognition',
  'help',
  'audio-unavailable',
  'restart',
  'duplicate-conflict',
  'review-24h',
  'review-7d',
  'progress-export',
  'recovery',
  'ownership',
  'browser-family',
];
const args = process.argv.slice(2);
assert.equal(args.length, 8);
assert.equal(args[0], '--handoff');
assert.equal(args[2], '--output');
assert.equal(args[4], '--lesson-version');
assert.equal(args[6], '--mode');
assert.equal(args[7], 'proof');
const [handoffFile, output, lessonVersion] = [args[1], args[3], args[5]];
assert(LESSONS.some((l) => l.version === lessonVersion));
const h = JSON.parse(await readFile(handoffFile, 'utf8'));
assert.equal(h.collection.profile, 'positive-collection');
assert.equal(h.collection.collectionVersion, COLLECTION.version);
const item = h.collection.items.find((i) => i.lessonVersion === lessonVersion);
assert(item && /^sha256:[a-f0-9]{64}$/.test(item.contentDigest));
await mkdir(output, { mode: 0o700 });
const startedAt = Date.now(),
  a = await createHttpAdapter(h, output, lessonVersion),
  executed = [];
let browser;
try {
  assert(Number.isSafeInteger(h.collection.initialClock));
  await a.setServerTime(h.collection.initialClock);
  executed.push(...(await runHttpSuite(a, { lessonVersion })));
  if (executed.every((c) => c.outcome === 'PASS')) {
    browser = await createBrowserAdapter(h, a, output, lessonVersion);
    executed.push(...(await runBrowserSuite(browser)));
  }
} catch (error) {
  executed.push({
    id: 'coordinator-execution',
    scenarios: required,
    outcome: 'FAIL',
    error: error.message,
  });
} finally {
  if (browser) await browser.cleanup();
}
const cases = [];
for (const [index, c] of executed.entries()) {
  const name = 'case-' + index + '.json';
  await writeFile(
    path.join(output, name),
    JSON.stringify(
      { lessonVersion, contentDigest: item.contentDigest, ...c },
      null,
      2,
    ) + '\n',
  );
  cases.push({ id: c.id, outcome: c.outcome, evidenceRefs: [name] });
}
const scenarios = required.map((id) => {
  const matching = executed
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.scenarios.includes(id));
  return {
    id,
    outcome:
      matching.length && matching.every(({ c }) => c.outcome === 'PASS')
        ? 'PASS'
        : matching.length
          ? 'FAIL'
          : 'BLOCKED',
    caseIds: matching.map(({ c }) => c.id),
    evidenceFiles: matching.map(({ index }) => 'case-' + index + '.json'),
  };
});
const sourceDir = path.dirname(fileURLToPath(import.meta.url)),
  testSourceHashes = {};
for (const name of (await readdir(sourceDir))
  .filter((n) => n.endsWith('.mjs'))
  .sort())
  testSourceHashes['tests/readiness-r5/' + name] = createHash('sha256')
    .update(await readFile(path.join(sourceDir, name)))
    .digest('hex');
await a.verifyFrozenIdentity();
const report = {
  schemaVersion: 'r5-executed-report-1',
  candidateId: h.candidateId,
  sourceDigest: h.sourceDigest,
  artifactDigest: h.artifactDigest,
  buildId: h.buildId,
  lessonVersion,
  contentDigest: item.contentDigest,
  evidenceInstallationId: h.evidenceInstallationId,
  targetInstallationId: h.targetInstallationId,
  namespace: h.namespace,
  startedAt,
  finishedAt: Date.now(),
  scenarios,
  cases,
  testSourceHashes,
};
await writeFile(
  path.join(output, 'report.json'),
  JSON.stringify(report, null, 2) + '\n',
);
process.exitCode =
  scenarios.every((s) => s.outcome === 'PASS') &&
  cases.every((c) => c.outcome === 'PASS')
    ? 0
    : 1;
