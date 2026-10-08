import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  inspectExecutedCorpusReport,
  buildCorpusProofReceipt,
} from '../scripts/readiness-corpus-proof-issuer.mjs';
import {
  CORPUS_MEMBER_CHECKS,
  CORPUS_FAMILY_SCENARIOS,
  inspectCorpusProof,
} from '../lib/pilot/corpus-proof.ts';

function reportFixture(fn) {
  const output = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-corpus-proof-unit-'),
  );
  fs.chmodSync(output, 0o700);
  const h = (letter) => 'sha256:' + letter.repeat(64);
  const identity = {
    candidateId: 'unit-candidate',
    sourceDigest: h('a'),
    artifactDigest: h('b'),
    buildId: 'unit-candidate',
    corpusVersion: 'unit-corpus',
    corpusDigest: h('c'),
    profile: 'draft-corpus',
    profileDigest: h('d'),
    runnerManifestDigest: h('e'),
    evidenceInstallationId: 'unit-install',
    namespace: 'unit-namespace',
  };
  const items = [1, 2, 3].map((i) => ({
    lessonVersion: 'unit-' + i,
    contentDigest: h(String(i)),
  }));
  const write = (file, value) =>
    fs.writeFileSync(path.join(output, file), JSON.stringify(value));
  const step = (id) => ({
    id,
    outcome: 'PASS',
    caseIds: ['unit-case'],
    evidenceFiles: ['case.json'],
  });
  const members = items.map((item) => ({
    schemaVersion: 'r6-member-execution-1',
    ...item,
    checks: CORPUS_MEMBER_CHECKS.map(step),
  }));
  const family = {
    schemaVersion: 'r6-family-execution-1',
    evidenceInstallationId: identity.evidenceInstallationId,
    namespace: identity.namespace,
    representatives: items,
    scenarios: items.flatMap((item) =>
      CORPUS_FAMILY_SCENARIOS.map((id) => ({ ...item, ...step(id) })),
    ),
  };
  const report = {
    schemaVersion: 'r6-executed-report-1',
    ...identity,
    startedAt: 1000,
    finishedAt: 2000,
    testSourceHashes: { 'tests/readiness-r6/service-run.mjs': 'a'.repeat(64) },
    memberReports: items.map((item, i) => ({
      ...item,
      reportFile: `member-${i}.json`,
    })),
    familyReportFile: 'family.json',
    cases: [{ id: 'unit-case', outcome: 'PASS', evidenceRefs: ['case.json'] }],
    cleanup: {
      ownedBrowserContextsClosed: true,
      sharedBrowserDisconnected: true,
    },
  };
  const context = {
    identity,
    items,
    output,
    startedAt: 900,
    finishedAt: 2100,
    testSourceHashes: report.testSourceHashes,
    exitCode: 0,
  };
  const save = () => {
    members.forEach((m, i) => write(`member-${i}.json`, m));
    write('family.json', family);
  };
  write('case.json', {
    label:
      'Synthetic report-validator unit fixture. No real execution or proof.',
  });
  save();
  try {
    fn({
      output,
      identity,
      items,
      report,
      context,
      members,
      family,
      save,
      write,
    });
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

test('[R6-E-004/014] inspected member reports retain every member and all39 shared scenarios', () => {
  reportFixture(({ report, context, items, identity }) => {
    const value = inspectExecutedCorpusReport(report, context);
    assert.equal(value.members.length, 3);
    assert.equal(value.familyEvidence.scenarios.length, 39);
    assert.equal(
      value.members.every((m) => m.memberChecks.length === 5),
      true,
    );
    for (const member of value.members) {
      const receipt = buildCorpusProofReceipt(
        identity,
        member,
        value.familyEvidence,
        {
          receiptId: 'unit-receipt',
          issuerId: 'unit-issuer',
          issuedAt: '2026-09-27T00:00:00.000Z',
        },
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(inspectCorpusProof(receipt, items))),
        receipt,
      );
      assert.equal(
        receipt.targetInstallationId,
        identity.evidenceInstallationId,
      );
    }
  });
});

test('[R6-E-004/014] asserted PASS cannot replace child exit, source, identity, cases or cleanup', () => {
  reportFixture(({ report, context }) => {
    assert.throws(
      () => inspectExecutedCorpusReport(report, { ...context, exitCode: 1 }),
      /PROOF_EXECUTION_INVALID/,
    );
    for (const mutate of [
      (r) => {
        r.candidateId = 'foreign';
      },
      (r) => {
        r.runnerManifestDigest = 'sha256:' + 'f'.repeat(64);
      },
      (r) => {
        r.testSourceHashes = {};
      },
      (r) => {
        r.startedAt = 800;
      },
      (r) => {
        r.finishedAt = 2200;
      },
      (r) => {
        r.memberReports.pop();
      },
      (r) => {
        r.memberReports[1] = r.memberReports[0];
      },
      (r) => {
        r.cases[0].outcome = 'FAIL';
      },
      (r) => {
        r.cases = [];
      },
      (r) => {
        r.cleanup.ownedBrowserContextsClosed = false;
      },
      (r) => {
        r.cleanup.sharedBrowserDisconnected = false;
      },
      (r) => {
        r.extra = true;
      },
    ]) {
      const altered = structuredClone(report);
      mutate(altered);
      assert.throws(
        () => inspectExecutedCorpusReport(altered, context),
        /PROOF_EXECUTION_INVALID/,
      );
    }
  });
});

test('[R6-E-004/014] incomplete member checks or a missing, foreign or unexecuted shared case refuses all issuance', () => {
  reportFixture(({ report, context, members, family, save }) => {
    const original = structuredClone({ members, family });
    for (const mutate of [
      () => {
        members[0].checks.pop();
      },
      () => {
        members[0].checks[1] = members[0].checks[0];
      },
      () => {
        members[0].checks[0].caseIds = ['missing'];
      },
      () => {
        members[0].checks[0].outcome = 'NOT_RUN';
      },
      () => {
        family.scenarios.pop();
      },
      () => {
        family.scenarios[1] = family.scenarios[0];
      },
      () => {
        family.scenarios[0].contentDigest = 'sha256:' + 'f'.repeat(64);
      },
      () => {
        family.scenarios[0].outcome = 'BLOCKED';
      },
      () => {
        family.namespace = 'foreign';
      },
      () => {
        family.representatives.reverse();
      },
    ]) {
      mutate();
      save();
      assert.throws(
        () => inspectExecutedCorpusReport(report, context),
        /PROOF_EXECUTION_INVALID/,
      );
      members.splice(0, members.length, ...structuredClone(original.members));
      Object.assign(family, structuredClone(original.family));
      save();
    }
  });
});

test('[R6-E-014] report evidence cannot escape, follow symlinks or claim unrelated case files', () => {
  reportFixture(({ output, report, context, members, save, write }) => {
    fs.symlinkSync('case.json', path.join(output, 'alias.json'));
    write('unrelated.json', { label: 'not executed by the case' });
    for (const filename of [
      '../case.json',
      '/tmp/case.json',
      'alias.json',
      '.private',
      'unrelated.json',
      'missing.json',
    ]) {
      members[0].checks[0].evidenceFiles = [filename];
      save();
      assert.throws(
        () => inspectExecutedCorpusReport(report, context),
        /PROOF_EXECUTION_INVALID/,
      );
    }
  });
});
