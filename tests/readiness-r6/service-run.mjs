/** Fixed executable tester. Root coordinator independently validates and signs. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { corpusExecutionBinding } from '../../scripts/readiness-corpus-proof-issuer.mjs';
import { corpusProfile } from '../../scripts/readiness-corpus-profiles.mjs';
import * as engine from '../../lib/curriculum/corpus-runtime.ts';
import { runMemberChecks } from './member-checks.mjs';
import { MEMBER_CHECK_IDS } from './oracle.mjs';
import { createServiceHTTP } from './service-http.mjs';
import { runServiceFamily } from './service-family.mjs';
import { runServiceBrowser } from './service-browser.mjs';
import { runServiceGlobal } from './service-global.mjs';
import { runServiceBenchmark } from './service-benchmark.mjs';
const args = process.argv.slice(2);
assert.equal(args.length, 6);
assert.deepEqual(
  [args[0], args[2], args[4]],
  ['--handoff', '--output', '--mode'],
);
const handoffFile = path.resolve(args[1]),
  output = path.resolve(args[3]),
  mode = args[5];
assert(['proof', 'global', 'benchmark'].includes(mode));
const info = fs.lstatSync(handoffFile);
assert(info.isFile() && !info.isSymbolicLink());
assert.equal(info.mode & 0o777, 0o600);
assert.equal(info.uid, process.getuid());
assert.equal(fs.realpathSync(handoffFile), handoffFile);
const h = JSON.parse(fs.readFileSync(handoffFile, 'utf8'));
assert.equal(h.schemaVersion, 'r6-corpus-runtime-1');
const manifest = JSON.parse(fs.readFileSync(h.manifestPath, 'utf8'));
assert.equal(path.dirname(output), fs.realpathSync(manifest.work));
assert(!fs.existsSync(output), 'Output must not exist');
fs.mkdirSync(output, { mode: 0o700 });
const startedAt = Date.now(),
  cases = [],
  memberReports = [],
  familyScenarios = [],
  FAMILY_IDS = [
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
let http,
  binding,
  cleanup = {
    ownedBrowserContextsClosed: true,
    sharedBrowserDisconnected: true,
  },
  sequence = 0;
const evidence = (id, value) => {
  const filename =
    String(++sequence).padStart(5, '0') +
    '-' +
    id.replace(/[^a-zA-Z0-9_-]/gu, '_') +
    '.json';
  const text = JSON.stringify(value, null, 2);
  assert(Buffer.byteLength(text) <= 20 * 1024 * 1024);
  fs.writeFileSync(path.join(output, filename), text, {
    flag: 'wx',
    mode: 0o600,
  });
  return filename;
};
evidence.path = (filename) => {
  assert(/^[A-Za-z0-9_-]+\.png$/u.test(filename));
  return path.join(output, filename);
};
async function execute(rep, id, fn) {
  const caseId = rep.lessonVersion + '--' + id;
  let outcome = 'PASS',
    details;
  try {
    details = await fn();
  } catch (error) {
    outcome = 'FAIL';
    details = {
      code: typeof error.code === 'string' ? error.code : null,
      message: String(error.message).slice(0, 1000),
    };
  }
  const file = evidence(caseId, details),
    refs = [file];
  if (details?.screenshot) refs.push(details.screenshot);
  cases.push({ id: caseId, outcome, evidenceRefs: refs });
  familyScenarios.push({
    lessonVersion: rep.lessonVersion,
    contentDigest: rep.contentDigest,
    id,
    outcome,
    caseIds: [caseId],
    evidenceFiles: refs,
  });
  return outcome;
}
try {
  binding = corpusExecutionBinding(manifest, h.profile);
  for (const [key, value] of Object.entries(binding.identity))
    assert.equal(h[key], value, 'Frozen handoff mismatch ' + key);
  assert.equal(h.installationId, h.bootstrap ? h.installationId : null);
  assert.equal(h.corpusVersion, binding.corpus.corpusVersion);
  assert.equal(h.corpusDigest, binding.identity.corpusDigest);
  const indices = [
    0,
    Math.floor((binding.items.length - 1) / 2),
    binding.items.length - 1,
  ];
  const expectedRepresentatives = [...new Set(indices)].map(
    (i) => binding.items[i],
  );
  assert.deepEqual(
    h.representatives.map(({ lessonVersion, contentDigest }) => ({
      lessonVersion,
      contentDigest,
    })),
    expectedRepresentatives,
  );
  assert.equal(h.families.length, 10);
  assert.equal(new Set(h.families.map((x) => x.childId)).size, 10);
  assert.deepEqual(
    h.representatives.map((x) => [
      x.familyIndex,
      x.helpFamilyIndex,
      x.audioFamilyIndex,
      x.browserFamilyIndex,
    ]),
    [
      [1, 2, 3, 4],
      [5, 6, 7, 4],
      [10, 8, 9, 4],
    ],
  );
  const profile = corpusProfile(h.profile),
    oracles = JSON.parse(
      fs.readFileSync(path.join(manifest.snapshot, profile.oraclePath), 'utf8'),
    ).items;
  http = createServiceHTTP(h, evidence);
  async function globalCase(id, fn) {
    let outcome = 'PASS',
      details;
    try {
      details = await fn();
      if (details?.outcome) outcome = details.outcome;
    } catch (error) {
      outcome = 'FAIL';
      details = {
        code: error.code ?? null,
        message: String(error.message).slice(0, 1000),
      };
    }
    const file = evidence(id, details);
    cases.push({ id, outcome, evidenceRefs: [file] });
  }
  if (mode === 'global')
    await runServiceGlobal(http, binding, manifest, globalCase, evidence);
  else if (mode === 'benchmark')
    await globalCase('C16-benchmark', () =>
      runServiceBenchmark(http, binding, oracles, evidence),
    );
  else {
    for (const item of binding.items) {
      const pkg = JSON.parse(
          fs.readFileSync(
            path.join(
              manifest.snapshot,
              profile.packageDirectory,
              item.lessonVersion + '.json',
            ),
            'utf8',
          ),
        ),
        oracle = oracles.find((x) => x.lessonVersion === item.lessonVersion);
      assert(oracle);
      const result = await runMemberChecks({
        packageInput: pkg,
        oracle,
        engine,
        candidateRoot: manifest.snapshot,
        assetFiles: [],
      });
      const checks = [];
      for (const check of result.results) {
        const id = item.lessonVersion + '--member--' + check.id,
          file = evidence(id, check);
        cases.push({ id, outcome: check.outcome, evidenceRefs: [file] });
        checks.push({
          id: check.id,
          outcome: check.outcome,
          caseIds: [id],
          evidenceFiles: [file],
        });
      }
      assert.deepEqual(
        checks.map((x) => x.id),
        MEMBER_CHECK_IDS,
      );
      const reportFile = evidence(item.lessonVersion + '-member', {
        schemaVersion: 'r6-member-execution-1',
        lessonVersion: item.lessonVersion,
        contentDigest: item.contentDigest,
        checks,
      });
      memberReports.push({
        lessonVersion: item.lessonVersion,
        contentDigest: item.contentDigest,
        reportFile,
      });
      if (checks.some((x) => x.outcome !== 'PASS'))
        throw Error(
          'Member prerequisite failed; dependent workload not executed',
        );
    }
    await runServiceFamily(http, oracles, execute, async () => {
      cleanup = {
        ownedBrowserContextsClosed: false,
        sharedBrowserDisconnected: false,
      };
      cleanup = await runServiceBrowser(http, oracles, execute, evidence);
    });
  }
} catch (error) {
  const file = evidence('prerequisite-failure', {
    code: typeof error.code === 'string' ? error.code : null,
    message: String(error.message).slice(0, 1000),
  });
  cases.push({
    id: 'prerequisite-failure',
    outcome: 'FAIL',
    evidenceRefs: [file],
  });
} finally {
  if (http) evidence('http-transcript', http.transcript);
}
if (mode === 'proof')
  for (const rep of h.representatives)
    for (const id of FAMILY_IDS)
      if (
        !familyScenarios.some(
          (x) => x.lessonVersion === rep.lessonVersion && x.id === id,
        )
      ) {
        const caseId = rep.lessonVersion + '--' + id,
          file = evidence(caseId, {
            reason: 'Prerequisite incomplete; no execution claim',
          });
        cases.push({ id: caseId, outcome: 'NOT_RUN', evidenceRefs: [file] });
        familyScenarios.push({
          lessonVersion: rep.lessonVersion,
          contentDigest: rep.contentDigest,
          id,
          outcome: 'NOT_RUN',
          caseIds: [caseId],
          evidenceFiles: [file],
        });
      }
const familyReportFile = evidence('family-report', {
  schemaVersion: 'r6-family-execution-1',
  evidenceInstallationId: h.installationId,
  namespace: h.namespace,
  representatives: h.representatives.map(
    ({ lessonVersion, contentDigest }) => ({ lessonVersion, contentDigest }),
  ),
  scenarios: familyScenarios,
});
const report = {
  schemaVersion: 'r6-executed-report-1',
  candidateId: h.candidateId,
  sourceDigest: h.sourceDigest,
  artifactDigest: h.artifactDigest,
  buildId: h.buildId,
  corpusVersion: h.corpusVersion,
  corpusDigest: h.corpusDigest,
  profile: h.profile,
  profileDigest: h.profileDigest,
  runnerManifestDigest: h.runnerManifestDigest,
  evidenceInstallationId: h.installationId,
  namespace: h.namespace,
  startedAt,
  finishedAt: Date.now(),
  testSourceHashes: binding?.testSourceHashes ?? {},
  memberReports,
  familyReportFile,
  cases,
  cleanup,
};
fs.writeFileSync(
  path.join(output, 'report.json'),
  JSON.stringify(report, null, 2),
  { flag: 'wx', mode: 0o600 },
);
if (
  cases.some((x) => x.outcome !== 'PASS') ||
  !cleanup.ownedBrowserContextsClosed ||
  !cleanup.sharedBrowserDisconnected
)
  process.exitCode = 1;
