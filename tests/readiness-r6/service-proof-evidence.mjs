/** Re-read the actual cached coordinator evidence, never an uploaded PASS report. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const scenarioIds = [
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
const H = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function readActualFamilyEvidence(http, binding) {
  const h = http.handoff,
    completed = await http.control('/verify-and-sign', {});
  assert.equal(completed.status, 200);
  assert.equal(completed.body.outcome, 'PASS');
  assert.equal(completed.body.receiptCount, binding.items.length);
  const root = fs.realpathSync(h.output);
  assert.equal(root, h.output);
  const artifacts = [];
  function read(relative, base = root) {
    assert.equal(typeof relative, 'string');
    assert(!path.isAbsolute(relative) && relative.length < 500);
    const parts = relative.split('/');
    assert(
      parts.every(
        (p) =>
          p !== '' &&
          p !== '.' &&
          p !== '..' &&
          !p.startsWith('.') &&
          !p.includes('\\'),
      ),
    );
    let current = base;
    for (const part of parts) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      assert(!stat.isSymbolicLink() && stat.uid === process.getuid());
    }
    assert.equal(fs.realpathSync(current), current);
    assert(current.startsWith(root + path.sep));
    const stat = fs.lstatSync(current);
    assert(stat.isFile() && stat.size > 0 && stat.size <= 20 * 1024 * 1024);
    const bytes = fs.readFileSync(current);
    artifacts.push({
      path: path.relative(root, current),
      bytes: bytes.length,
      sha256: H(bytes),
    });
    return { bytes, filename: current };
  }
  const mainFile = read(completed.body.reportFile),
    report = JSON.parse(mainFile.bytes);
  assert.equal(report.schemaVersion, 'r6-executed-report-1');
  for (const [key, value] of Object.entries(binding.identity))
    assert.equal(report[key], value);
  assert.equal(report.evidenceInstallationId, h.installationId);
  assert.equal(report.namespace, h.namespace);
  assert.deepEqual(report.testSourceHashes, binding.testSourceHashes);
  assert.equal(report.cleanup.ownedBrowserContextsClosed, true);
  assert.equal(report.cleanup.sharedBrowserDisconnected, true);
  assert(
    Number.isSafeInteger(report.startedAt) &&
      Number.isSafeInteger(report.finishedAt) &&
      report.finishedAt >= report.startedAt,
  );
  const base = path.dirname(mainFile.filename),
    cases = new Map();
  for (const item of report.cases) {
    assert.equal(item.outcome, 'PASS');
    assert(!cases.has(item.id));
    assert(Array.isArray(item.evidenceRefs) && item.evidenceRefs.length > 0);
    cases.set(item.id, item);
    for (const ref of item.evidenceRefs) read(ref, base);
  }
  const family = JSON.parse(read(report.familyReportFile, base).bytes);
  assert.equal(family.schemaVersion, 'r6-family-execution-1');
  assert.equal(family.evidenceInstallationId, h.installationId);
  assert.equal(family.namespace, h.namespace);
  assert.deepEqual(
    family.representatives,
    h.representatives.map(({ lessonVersion, contentDigest }) => ({
      lessonVersion,
      contentDigest,
    })),
  );
  assert.equal(family.scenarios.length, 39);
  const seen = new Set();
  for (const scenario of family.scenarios) {
    const rep = h.representatives.find(
      (r) => r.lessonVersion === scenario.lessonVersion,
    );
    assert(rep);
    assert.equal(scenario.contentDigest, rep.contentDigest);
    assert(scenarioIds.includes(scenario.id));
    assert.equal(scenario.outcome, 'PASS');
    const key = scenario.lessonVersion + '|' + scenario.id;
    assert(!seen.has(key));
    seen.add(key);
    assert(scenario.caseIds.length > 0 && scenario.evidenceFiles.length > 0);
    for (const id of scenario.caseIds)
      assert.equal(cases.get(id)?.outcome, 'PASS');
    for (const ref of scenario.evidenceFiles) read(ref, base);
  }
  for (const rep of h.representatives)
    for (const id of scenarioIds)
      assert(seen.has(rep.lessonVersion + '|' + id));
  return {
    actualCoordinatorReport: completed.body.reportFile,
    reportSha256: H(mainFile.bytes),
    actualCaseCount: report.cases.length,
    familyScenarioCount: 39,
    sharedRepresentatives: family.representatives,
    artifactHashes: [...new Map(artifacts.map((a) => [a.path, a])).values()],
    method:
      'Actual same-candidate cached coordinator tree re-read and hashed; no second journey run or 800 browser claims.',
  };
}
