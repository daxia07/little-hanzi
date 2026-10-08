import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  withOwnedCorpusFixture,
  bootstrapOwnedCorpus,
  withdrawOwnedCorpus,
} from '../scripts/readiness-corpus-bootstrap.mjs';
import {
  proposeCorpus,
  approveCorpus,
} from '../lib/pilot/corpus-family-store.ts';
import { saveOnboarding } from '../lib/pilot/learning.ts';
import {
  ownedCorpusArchiveSource,
  archiveHash,
  corpusDigest,
} from './helpers/corpus-archive-fixture.mjs';
import { FOREST_LESSON } from '../lib/preview/content.ts';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
import * as archive from '../scripts/pilot-corpus-backup.mjs';
const owned = ownedCorpusArchiveSource();
after(owned.close);
let saved;
await withOwnedCorpusFixture('draft-corpus', async (f) => {
  const release = await bootstrapOwnedCorpus(f.handle),
    at = Date.now();
  f.config.curriculumTestNow = String(at);
  await saveOnboarding(
    f.db,
    'r6-parent',
    'r6-child',
    { nickname: 'Fixture student', experience: 'some', audioReady: true },
    at,
  );
  let predecessor = null,
    expected = null;
  for (const item of f.manifest.items.slice(0, 2)) {
    const { proposal } = await proposeCorpus(
      f.context('r6-parent'),
      'r6-child',
      {
        corpusVersion: f.manifest.corpusVersion,
        selection: {
          lessonVersion: item.lessonVersion,
          contentDigest: item.contentDigest,
          releaseId: release.recordId,
          releaseRevision: release.revision,
        },
        predecessorProposalId: predecessor,
        expectedSourceDigest: expected,
      },
    );
    const approval = {
      proposalId: proposal.proposalId,
      sourceDigest: proposal.sourceDigest,
    };
    const first = await approveCorpus(
      f.context('r6-parent'),
      'r6-child',
      approval,
    );
    assert.deepEqual(
      await approveCorpus(f.context('r6-parent'), 'r6-child', approval),
      first,
    );
    predecessor = proposal.proposalId;
    expected = proposal.sourceDigest;
  }
  f.config.curriculumTestNow = String(at + 1);
  await saveOnboarding(
    f.db,
    'r6-parent',
    'r6-child',
    { nickname: 'Later setup', experience: 'new', audioReady: false },
    at + 1,
  );
  await withdrawOwnedCorpus(f.handle, {
    requestId: 'selection-history-withdraw',
    expectedRevision: 1,
    predecessorPublicationId: release.recordId,
  });
  await f.client.execute(
    "UPDATE pilot_installation SET installation_id='fresh-after-selection' WHERE id=1",
  );
  await f.client.execute(
    "UPDATE pilot_auth_user SET disabled=1 WHERE id='r6-op'",
  );
  const tables = {};
  for (const [table, columns] of Object.entries(archive.corpusColumns()))
    tables[table] = (
      await f.client.execute(`SELECT ${columns.join(',')} FROM ${table}`)
    ).rows.map((r) => Object.fromEntries(columns.map((k) => [k, r[k]])));
  saved = {
    format: 'pilot-admin-backup-6',
    createdAt: new Date(Math.max(Date.now(), at + 1)).toISOString(),
    candidateId: f.config.candidateId,
    sourceInstallationId: 'fresh-after-selection',
    migrations: owned.source.migrations,
    schemaDigest: archiveHash(owned.source.schema),
    schema: owned.source.schema,
    contentIdentities: {
      legacy: {
        'forest-01-v1': {
          lessonId: 'forest-01',
          algorithm: 's2-json-stringify-sha256-v1',
          digest: archiveHash(FOREST_LESSON),
        },
      },
      curriculum: Object.fromEntries(
        tables.pilot_curriculum_package.map((r) => [
          r.lesson_version,
          {
            lessonId: r.lesson_id,
            canonicalizationVersion: r.canonicalization_version,
            digest: r.content_digest,
          },
        ]),
      ),
    },
    tables,
  };
});
const validate = (p) =>
  process.env.CORPUS_SELECTION_HISTORY_BASELINE === 'authority'
    ? archive.validateCorpusAuthorityHistory(p, { source: owned.source })
    : archive.validateCorpusSelectionHistory(p, { source: owned.source });
test('[R6-E-010/013] real same-time logical selections and one-time approvals preserve historical scopes after withdrawal and new setup', async () => {
  const bytes = JSON.stringify(saved),
    result = await validate(saved);
  assert.equal(JSON.stringify(result), bytes);
  assert.deepEqual(
    result.tables.pilot_corpus_proposal.map((p) => p.selection_ordinal),
    [1, 2],
  );
  assert.equal(
    result.tables.pilot_corpus_proposal[0].created_at,
    result.tables.pilot_corpus_proposal[1].created_at,
  );
  for (const table of [
    'pilot_corpus_plan',
    'pilot_corpus_plan_item',
    'pilot_corpus_assignment',
    'pilot_corpus_schedule',
  ])
    assert.equal(result.tables[table].length, 2);
  assert.equal(result.tables.pilot_corpus_learning_audit.length, 2);
});
test('[R6-E-010/013] full selection history rejects missing atomic effects and broken predecessor links', async () => {
  for (const mutate of [
    (p) => p.tables.pilot_corpus_plan_item.pop(),
    (p) => p.tables.pilot_corpus_assignment.pop(),
    (p) => p.tables.pilot_corpus_schedule.pop(),
    (p) => p.tables.pilot_corpus_learning_audit.pop(),
    (p) => {
      p.tables.pilot_corpus_proposal[1].predecessor_source_digest =
        'sha256:' + '0'.repeat(64);
    },
    (p) => {
      p.tables.pilot_corpus_schedule[0].due_at++;
    },
  ]) {
    const p = structuredClone(saved);
    mutate(p);
    await assert.rejects(() => validate(p), /BACKUP_CORPUS_INVALID/);
  }
});
test('[R6-E-010/013] full selection history rejects rewritten original ACK and rehashed foreign authority or selected package', async () => {
  for (const mutate of [
    (p) => {
      const row = p.tables.pilot_corpus_plan[0],
        ack = JSON.parse(row.ack_json);
      ack.approvedAt = new Date(row.approved_at + 1).toISOString();
      row.ack_json = canonicalPackage(ack);
    },
    (p) => {
      const row = p.tables.pilot_corpus_proposal[0],
        source = JSON.parse(row.source_json);
      source.authority.scope.members[0].parentId = 'r6-parent-2';
      source.authorityDigest = corpusDigest(source.authority);
      row.source_json = canonicalPackage(source);
      row.source_digest = corpusDigest(source);
    },
    (p) => {
      const row = p.tables.pilot_corpus_proposal[0],
        source = JSON.parse(row.source_json);
      source.packageEligibilityDigest = 'sha256:' + 'b'.repeat(64);
      row.source_json = canonicalPackage(source);
      row.source_digest = corpusDigest(source);
    },
  ]) {
    const p = structuredClone(saved);
    mutate(p);
    await assert.rejects(() => validate(p), /BACKUP_CORPUS_INVALID/);
  }
});
test('[R6-E-010/013] internally consistent approval effects after withdrawal do not become historical authority', async () => {
  const p = structuredClone(saved),
    plan = p.tables.pilot_corpus_plan[1],
    withdrawn = p.tables.pilot_corpus_publication.find(
      (row) => row.status === 'withdrawn',
    );
  plan.approved_at = withdrawn.created_at + 1;
  const ack = JSON.parse(plan.ack_json);
  ack.approvedAt = new Date(plan.approved_at).toISOString();
  plan.ack_json = canonicalPackage(ack);
  const item = p.tables.pilot_corpus_plan_item.find(
      (row) => row.plan_id === plan.id,
    ),
    assignment = p.tables.pilot_corpus_assignment.find(
      (row) => row.plan_item_id === item.id,
    ),
    schedule = p.tables.pilot_corpus_schedule.find(
      (row) => row.assignment_id === assignment.id,
    ),
    audit = p.tables.pilot_corpus_learning_audit.find(
      (row) => row.plan_id === plan.id,
    );
  assignment.created_at = plan.approved_at;
  schedule.created_at = plan.approved_at;
  schedule.due_at = plan.approved_at;
  audit.created_at = plan.approved_at;
  await assert.rejects(() => validate(p), /BACKUP_CORPUS_INVALID/);
});
