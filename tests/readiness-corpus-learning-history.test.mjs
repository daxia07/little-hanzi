import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  withOwnedCorpusFixture,
  bootstrapOwnedCorpus,
  withdrawOwnedCorpus,
} from '../scripts/readiness-corpus-bootstrap.mjs';
import {
  proposeCorpus,
  approveCorpus,
} from '../lib/pilot/corpus-family-store.ts';
import {
  startCorpus,
  getCorpusRun,
  advanceCorpus,
} from '../lib/pilot/corpus-learning-store.ts';
import { saveOnboarding } from '../lib/pilot/learning.ts';
import {
  ownedCorpusArchiveSource,
  archiveHash,
  corpusDigest,
} from './helpers/corpus-archive-fixture.mjs';
import { FOREST_LESSON } from '../lib/preview/content.ts';
import { canonicalPackage as json } from '../lib/curriculum/digest.ts';
import * as archive from '../scripts/pilot-corpus-backup.mjs';
const owned = ownedCorpusArchiveSource();
after(owned.close);
let saved;
await withOwnedCorpusFixture('draft-corpus', async (f) => {
  const release = await bootstrapOwnedCorpus(f.handle);
  let at = Math.max(Date.now(), f.clock);
  // Persist normal owned synthetic sessions valid through the explicitly advanced
  // seven-day test clock. These are real auth rows, not an authorization bypass.
  await f.client.execute({
    sql: 'UPDATE pilot_auth_session SET expires_at=?',
    args: [at + 9 * 86400000],
  });
  f.config.curriculumTestNow = String(at);
  await saveOnboarding(
    f.db,
    'r6-parent',
    'r6-child',
    { nickname: 'Archive fixture', experience: 'some', audioReady: true },
    at,
  );
  const member = f.manifest.items[0];
  const proposal = (
    await proposeCorpus(f.context('r6-parent'), 'r6-child', {
      corpusVersion: f.manifest.corpusVersion,
      selection: {
        lessonVersion: member.lessonVersion,
        contentDigest: member.contentDigest,
        releaseId: release.recordId,
        releaseRevision: release.revision,
      },
      predecessorProposalId: null,
      expectedSourceDigest: null,
    })
  ).proposal;
  await approveCorpus(f.context('r6-parent'), 'r6-child', {
    proposalId: proposal.proposalId,
    sourceDigest: proposal.sourceDigest,
  });
  const assignment = (
    await f.client.execute('SELECT * FROM pilot_corpus_assignment')
  ).rows[0];
  const document = JSON.parse(
    fs.readFileSync(
      new URL(
        '../content/curriculum/corpus/' + member.lessonVersion + '.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const child = f.context('r6-child');
  for (const phase of ['initial', 'review-24h', 'review-7d']) {
    const schedule = (
      await f.client.execute({
        sql: 'SELECT * FROM pilot_corpus_schedule WHERE assignment_id=? AND kind=?',
        args: [assignment.id, phase],
      })
    ).rows[0];
    assert(schedule);
    at = Math.max(at, Number(schedule.due_at));
    f.config.curriculumTestNow = String(at);
    const input = {
      requestId: 'archive-start-' + phase,
      scheduleId: schedule.id,
    };
    const ack = await startCorpus(child, String(assignment.id), input);
    assert.deepEqual(
      await startCorpus(child, String(assignment.id), input),
      ack,
    );
    assert.deepEqual(
      await startCorpus(child, String(assignment.id), {
        ...input,
        requestId: 'archive-reopen-' + phase,
      }),
      ack,
    );
    let view = await getCorpusRun(child, ack.runId),
      last = null;
    for (let n = 0; !view.state.completedAt; n++) {
      assert(n < 150, 'finite actual learning driver');
      const question = view.question;
      let type = 'continue',
        payload = {};
      if (question && !view.canContinue) {
        const hanzi = document.characters.find(
          (c) => c.characterId === question.characterId,
        ).hanzi;
        type = 'answer';
        payload = {
          choiceId: question.choices.find((c) => c.hanzi === hanzi).choiceId,
        };
        if (
          phase === 'initial' &&
          view.state.stepId === 'familiarity' &&
          view.state.questionIndex === 0
        ) {
          if (!question.attempts)
            payload = {
              choiceId: question.choices.find((c) => c.hanzi !== hanzi)
                .choiceId,
            };
          else if (!question.hintLevel) {
            type = 'help';
            payload = {};
          }
        } else if (phase === 'initial' && view.state.stepId === 'familiarity') {
          type = 'audio-unavailable';
          payload = {};
        }
      }
      const action = {
        eventId: 'archive-' + phase + '-' + (view.revision + 1),
        expectedRevision: view.revision,
        occurrenceId: question?.occurrenceId ?? null,
        type,
        payload,
      };
      f.config.curriculumTestNow = String(++at);
      const result = await advanceCorpus(child, ack.runId, action);
      assert.equal(result.replayed, false);
      last = { action, ack: result.ack };
      view = await getCorpusRun(child, ack.runId);
    }
    const retry = await advanceCorpus(child, ack.runId, last.action);
    assert.equal(retry.replayed, true);
    assert.deepEqual(retry.ack, last.ack);
  }
  f.config.curriculumTestNow = String(++at);
  await withdrawOwnedCorpus(f.handle, {
    requestId: 'archive-finished-withdraw',
    expectedRevision: 1,
    predecessorPublicationId: release.recordId,
  });
  await f.client.execute(
    "UPDATE pilot_installation SET installation_id='new-after-learning' WHERE id=1",
  );
  await f.client.execute(
    "UPDATE pilot_auth_user SET disabled=1 WHERE id='r6-op'",
  );
  const tables = {};
  for (const [table, columns] of Object.entries(archive.corpusColumns())) {
    tables[table] = (
      await f.client.execute(`SELECT ${columns.join(',')} FROM ${table}`)
    ).rows.map((r) => Object.fromEntries(columns.map((k) => [k, r[k]])));
  }
  saved = {
    format: 'pilot-admin-backup-6',
    createdAt: new Date(at).toISOString(),
    candidateId: f.config.candidateId,
    sourceInstallationId: 'new-after-learning',
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
  process.env.CORPUS_LEARNING_HISTORY_BASELINE === 'selection'
    ? archive.validateCorpusSelectionHistory(p, { source: owned.source })
    : archive.validateCorpusLearningHistory(p, { source: owned.source });
test('[R6-E-011/013] actual saved three-visit history and original receipts survive withdrawal and a new installation', async () => {
  const bytes = json(saved),
    result = await validate(saved);
  assert.equal(json(result), bytes);
  assert.equal(Object.keys(result.tables).length, 67);
  assert.equal(result.tables.pilot_corpus_run.length, 3);
  assert.equal(result.tables.pilot_corpus_schedule.length, 3);
  assert.equal(
    result.tables.pilot_corpus_event.length,
    result.tables.pilot_corpus_run.reduce((n, r) => n + r.revision, 0),
  );
  assert.equal(
    result.tables.pilot_corpus_learning_audit.length,
    4 + result.tables.pilot_corpus_event.length,
  );
  assert(
    result.tables.pilot_corpus_run.every(
      (r) => r.installation_id !== 'new-after-learning',
    ),
  );
  assert.equal(result.tables.pilot_corpus_owner_decision.length, 0);
  assert.equal(result.tables.pilot_corpus_proof_receipt.length, 0);
});
test('[R6-E-013] full history rejects altered scored state, missing completion effects and extra audit/event facts', async () => {
  for (const mutate of [
    (p) => p.tables.pilot_corpus_event.pop(),
    (p) => p.tables.pilot_corpus_learning_audit.pop(),
    (p) => p.tables.pilot_corpus_schedule.pop(),
    (p) => p.tables.pilot_corpus_schedule[1].due_at++,
    (p) => {
      const r = p.tables.pilot_corpus_run[0],
        v = JSON.parse(r.run_json);
      v.state.assisted = !v.state.assisted;
      r.run_json = json(v);
    },
    (p) => {
      const a = structuredClone(p.tables.pilot_corpus_learning_audit.at(-1));
      a.id = 'extra-learning-audit';
      p.tables.pilot_corpus_learning_audit.push(a);
    },
  ]) {
    const p = structuredClone(saved);
    mutate(p);
    await assert.rejects(() => validate(p), /BACKUP_CORPUS_INVALID/);
  }
});
test('[R6-E-005/013] complete history rejects a rehashed event with missing verification capability or foreign eligibility', async () => {
  for (const change of [
    (policy) => {
      policy.authority.configuration.capability = null;
      policy.authorityDigest = corpusDigest(policy.authority);
    },
    (policy) => {
      policy.packageEligibilityDigest = 'sha256:' + 'f'.repeat(64);
    },
  ]) {
    const p = structuredClone(saved),
      event = p.tables.pilot_corpus_event[0],
      value = JSON.parse(event.result_json);
    change(value.policy);
    event.result_json = json(value);
    await assert.rejects(() => validate(p), /BACKUP_CORPUS_INVALID/);
  }
});
test('[R6-E-013] a replay-consistent entire delayed visit moved after withdrawal is still unauthorized history', async () => {
  const p = structuredClone(saved),
    row = p.tables.pilot_corpus_run.find((r) => r.phase === 'review-7d');
  const withdrawn = p.tables.pilot_corpus_publication.find(
    (r) => r.status === 'withdrawn',
  );
  const delta = withdrawn.created_at - row.created_at + 1,
    v = JSON.parse(row.run_json);
  const shift = (value) => new Date(Date.parse(value) + delta).toISOString();
  row.created_at += delta;
  row.updated_at += delta;
  row.completed_at += delta;
  v.createdAt = shift(v.createdAt);
  v.updatedAt = shift(v.updatedAt);
  v.state.completedAt = shift(v.state.completedAt);
  for (const e of v.events) e.serverTime = shift(e.serverTime);
  row.run_json = json(v);
  for (const event of p.tables.pilot_corpus_event.filter(
    (e) => e.run_id === row.id,
  )) {
    event.server_at += delta;
    const value = JSON.parse(event.result_json);
    value.event.serverTime = shift(value.event.serverTime);
    event.result_json = json(value);
  }
  for (const audit of p.tables.pilot_corpus_learning_audit.filter(
    (a) => a.run_id === row.id,
  ))
    audit.created_at += delta;
  await assert.rejects(() => validate(p), /BACKUP_CORPUS_INVALID/);
});
