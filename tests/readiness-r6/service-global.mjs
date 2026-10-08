/** Finite actual global cases; unavailable gates remain explicit. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { corpusProfile } from '../../scripts/readiness-corpus-profiles.mjs';
import { randomUUID } from 'node:crypto';
import { runServedAssets } from './service-assets.mjs';
import { runServiceAccess } from './service-access.mjs';
import { runServiceRecovery } from './service-recovery.mjs';
import { runServiceAdmin } from './service-admin.mjs';
import { runProofNegatives } from './service-proof-negatives.mjs';
import { runPublicationCases } from './service-publication.mjs';
import { readActualFamilyEvidence } from './service-proof-evidence.mjs';
export async function runServiceGlobal(
  http,
  binding,
  manifest,
  execute,
  evidence,
) {
  const h = http.handoff,
    op = h.accounts.find((x) => x.role === 'operator').id,
    v = encodeURIComponent(h.corpusVersion),
    family = h.families[0],
    child = '/api/pilot/children/' + family.childId,
    corpus = '/api/pilot/corpora/' + v;
  await execute('C14', () => readActualFamilyEvidence(http, binding));
  await runServiceAdmin(http, binding, manifest, execute);
  await execute('C01', async () => ({
    outcome: 'BLOCKED',
    reason:
      'No genuine human-reviewed1600 corpus; fixtures cannot certify real readiness',
  }));
  await execute('C02', async () => {
    const r = await http.request(op, 'GET', corpus + '/coverage');
    assert.equal(r.status, 200);
    for (const n of ['reviewedReady', 'prospectiveStarter', 'committedStarter'])
      assert.equal(r.body.counts[n], 0);
    return {
      fixtureCharacterCount: r.body.fixtureCharacterCount,
      realCounts: r.body.counts,
      genuineThresholdPositive: 'BLOCKED',
    };
  });
  await execute('C06', async () => {
    const inspected = await http.inspect({ kind: 'head' });
    assert.equal(inspected.head.id, h.bootstrap.recordId);
    assert.equal(inspected.head.status, 'released');
    const coverage = await http.request(op, 'GET', corpus + '/coverage');
    assert.equal(coverage.status, 200);
    assert.equal(coverage.body.verificationPackageCount, binding.items.length);
    return {
      head: inspected.head,
      machinePackages: coverage.body.verificationPackageCount,
      realReviewed: coverage.body.counts.reviewedReady,
    };
  });
  await execute('C07-proposal-CAS', async () => {
    const f = h.families[9];
    const route = '/api/pilot/children/' + f.childId;
    const setup = await http.request(f.parentId, 'PUT', route + '/onboarding', {
      nickname: 'Synthetic CAS learner',
      experience: 'new',
      audioReady: true,
    });
    assert.equal(setup.status, 200);
    const current = await http.request(
      f.parentId,
      'GET',
      route + '/placement?corpusVersion=' + v,
    );
    assert.equal(current.status, 200);
    const catalog = await http.request(
      f.parentId,
      'GET',
      route + '/catalog?corpusVersion=' + v + '&limit=2',
    );
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.items.length, 2);
    const predecessor = current.body.proposal;
    const requests = catalog.body.items.map((item) => ({
      corpusVersion: h.corpusVersion,
      selection: {
        lessonVersion: item.lessonVersion,
        contentDigest: item.contentDigest,
        releaseId: item.releaseId,
        releaseRevision: item.releaseRevision,
      },
      predecessorProposalId: predecessor?.proposalId ?? null,
      expectedSourceDigest: predecessor?.sourceDigest ?? null,
    }));
    const results = await Promise.all(
      requests.map((body) =>
        http.request(f.parentId, 'POST', route + '/catalog/proposals', body),
      ),
    );
    assert.deepEqual(
      results.map((r) => r.status).sort((a, b) => a - b),
      [200, 409],
    );
    const winner = results.find((r) => r.status === 200).body.proposal;
    const saved = await http.request(
      f.parentId,
      'GET',
      route + '/placement?corpusVersion=' + v,
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.proposal.proposalId, winner.proposalId);
    return {
      statuses: results.map((r) => r.status),
      currentProposalId: winner.proposalId,
      limitation:
        'Actual proposal CAS only; publication/member correction races require separate authority case.',
    };
  });
  await execute('C08-proposal-final-constraint', async () => {
    const f = h.families[8],
      route = '/api/pilot/children/' + f.childId;
    const setup = await http.request(f.parentId, 'PUT', route + '/onboarding', {
      nickname: 'Synthetic fault learner',
      experience: 'new',
      audioReady: true,
    });
    assert.equal(setup.status, 200);
    const current = await http.request(
      f.parentId,
      'GET',
      route + '/placement?corpusVersion=' + v,
    );
    assert.equal(current.status, 200);
    const catalog = await http.request(
      f.parentId,
      'GET',
      route + '/catalog?corpusVersion=' + v + '&limit=1',
    );
    assert.equal(catalog.status, 200);
    const item = catalog.body.items[0];
    assert(item);
    const before = await http.inspect({ kind: 'counts' });
    const armed = await http.control('/fault', {
      stage: 'proposal',
      mode: 'final-constraint',
    });
    assert.equal(armed.status, 200);
    let result;
    try {
      result = await http.request(
        f.parentId,
        'POST',
        route + '/catalog/proposals',
        {
          corpusVersion: h.corpusVersion,
          selection: {
            lessonVersion: item.lessonVersion,
            contentDigest: item.contentDigest,
            releaseId: item.releaseId,
            releaseRevision: item.releaseRevision,
          },
          predecessorProposalId: current.body.proposal?.proposalId ?? null,
          expectedSourceDigest: current.body.proposal?.sourceDigest ?? null,
        },
      );
      assert(
        result.status >= 400,
        'Armed terminal constraint unexpectedly acknowledged',
      );
    } finally {
      const disarmed = await http.control('/fault', {
        stage: 'proposal',
        mode: 'none',
      });
      assert.equal(disarmed.status, 200);
    }
    const after = await http.inspect({ kind: 'counts' });
    assert.deepEqual(
      after.counts,
      before.counts,
      'Terminal failure changed persisted domain table counts',
    );
    const saved = await http.request(
      f.parentId,
      'GET',
      route + '/placement?corpusVersion=' + v,
    );
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.proposal, current.body.proposal);
    return {
      status: result.status,
      code: result.body.error?.code ?? result.body.code ?? null,
      countsUnchanged: true,
      limitation:
        'Proposal terminal failure only; publication and accepted-response-loss require separate cases.',
    };
  });
  await execute('C11', async () => {
    const found = [],
      versions = new Set();
    let cursor;
    do {
      const r = await http.request(
        family.parentId,
        'GET',
        child +
          '/catalog?corpusVersion=' +
          v +
          '&limit=20' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      );
      assert.equal(r.status, 200);
      assert(r.body.items.length <= 20);
      for (const item of r.body.items) {
        assert(!versions.has(item.lessonVersion));
        versions.add(item.lessonVersion);
        found.push({
          lessonVersion: item.lessonVersion,
          contentDigest: item.contentDigest,
        });
      }
      cursor = r.body.nextCursor;
    } while (cursor);
    assert.deepEqual(found, binding.items);
    return { actualPackages: found.length, pageBound: 20, duplicates: 0 };
  });
  await execute('C12', async () => {
    const first = await http.request(
      family.parentId,
      'GET',
      child + '/catalog?corpusVersion=' + v + '&limit=1',
    );
    assert.equal(first.status, 200);
    assert(first.body.nextCursor);
    const tamper = await http.request(
      family.parentId,
      'GET',
      child +
        '/catalog?corpusVersion=' +
        v +
        '&limit=1&cursor=' +
        encodeURIComponent(first.body.nextCursor + 'x'),
    );
    assert.equal(tamper.status, 400);
    const foreign = await http.request(
      h.foreignParentId,
      'GET',
      child +
        '/catalog?corpusVersion=' +
        v +
        '&cursor=' +
        encodeURIComponent(first.body.nextCursor),
    );
    assert.equal(foreign.status, 404);
    return { tamperStatus: tamper.status, foreignStatus: foreign.status };
  });
  await execute('C13', async () => {
    const absent = await http.request(
      family.parentId,
      'GET',
      child + '/catalog?corpusVersion=' + v + '&q=definitelyabsentliteral',
    );
    assert.equal(absent.status, 200);
    assert.deepEqual(absent.body.items, []);
    const unknown = await http.request(
      family.parentId,
      'GET',
      child + '/catalog?corpusVersion=' + v + '&unknown=1',
    );
    assert.equal(unknown.status, 400);
    return { empty: true, unknownSelectorStatus: unknown.status };
  });
  await execute('C18', async () => {
    const backup = await http.control('/backup', {});
    assert.equal(backup.status, 200);
    assert.equal(backup.body.tableCount, 67);
    const failures = [];
    for (const variant of [
      'invalid-digest',
      'unknown-format',
      'final-constraint',
    ]) {
      const r = await http.control('/restore', {
        archiveId: backup.body.archiveId,
        variant,
      });
      assert(r.status >= 400);
      assert.equal(r.body.baseURL, null);
      assert.equal(r.body.installationId, null);
      assert.equal(r.body.counts, null);
      assert.equal(
        r.body.status,
        variant === 'final-constraint' ? 'NOT_COMMITTED' : 'REFUSED',
      );
      assert.equal(
        r.body.commit,
        variant === 'final-constraint' ? 'not-committed' : 'not-attempted',
      );
      assert.equal(typeof r.body.error?.code, 'string');
      failures.push({
        variant,
        status: r.status,
        commit: r.body.commit,
        error: r.body.error?.code ?? r.body.code,
      });
    }
    const lost = await http.control('/restore', {
      archiveId: backup.body.archiveId,
      variant: 'lost-ack',
    });
    assert.equal(lost.status, 200);
    assert.equal(lost.body.status, 'CONFIRMED');
    assert.equal(lost.body.commit, 'confirmed-after-uncertainty');
    assert.notEqual(lost.body.installationId, h.installationId);
    return {
      failures,
      lost: {
        commit: lost.body.commit,
        installationId: lost.body.installationId,
      },
    };
  });
  await execute('C18-encrypted-ops-pair', async () => {
    const r = await http.control('/ops-recovery', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'confirmed');
    assert.deepEqual(r.body.formats, [
      'pilot-admin-backup-6',
      'pilot-ops-backup-3',
    ]);
    assert.equal(r.body.sourceInstallationId, h.installationId);
    assert.notEqual(r.body.restoredInstallationId, h.installationId);
    assert.equal(Object.keys(r.body.learningCounts).length, 67);
    assert.equal(Object.keys(r.body.operationsCounts).length, 8);
    assert.equal(r.body.rowsMatch, true);
    assert.equal(r.body.restoredSessionCount, 0);
    for (const key of [
      'learningBytes',
      'operationsBytes',
      'encryptedBytes',
      'durationMs',
    ])
      assert(Number.isFinite(r.body[key]) && r.body[key] > 0, key);
    assert.equal(r.body.cleanup.clientsClosed, true);
    assert.equal(r.body.cleanup.directoryRemoved, true);
    assert.equal(r.body.sourceRefusal.destinationCount, 0);
    assert.equal(typeof r.body.sourceRefusal.code, 'string');
    assert(r.body.sourceRefusal.code.length > 0);
    return r.body;
  });
  await execute('C15', () =>
    runServiceRecovery(
      http,
      binding,
      JSON.parse(
        fs.readFileSync(
          path.join(manifest.snapshot, corpusProfile(h.profile).oraclePath),
          'utf8',
        ),
      ).items,
      evidence,
    ),
  );
  await execute('C17', () =>
    runServiceAccess(http, binding, manifest, evidence),
  );
  await execute('C19-assets', () => runServedAssets(h, manifest));
  await runPublicationCases(http, execute);
  await execute('C10', async () => {
    const r = await http.control('/verification', {
      operation: 'withdraw',
      requestId: randomUUID(),
    });
    assert.equal(r.status, 200);
    const catalog = await http.request(
      family.parentId,
      'GET',
      child + '/catalog?corpusVersion=' + v,
    );
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.body.items, []);
    const republish = await http.control('/verification', {
      operation: 'republish',
      requestId: randomUUID(),
    });
    assert.equal(republish.status, 200);
    const head = await http.inspect({ kind: 'head' });
    assert.notEqual(head.head.snapshotId, h.bootstrap.snapshotId);
    assert.equal(head.head.status, 'released');
    return { withdrawnEmpty: true, newPreparation: head.head.snapshotId };
  });
  await runProofNegatives(http, binding, execute, evidence);
  for (const id of ['C16', 'C19-regressions'])
    await execute(id, async () => ({
      outcome: 'NOT_RUN',
      reason:
        'Separate finite fixture/browser/benchmark or affected-legacy execution required; no case inferred from other increment',
    }));
}
