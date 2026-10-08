/** Author recovery fixture: real owned stores and checked-in literal oracle. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  bootstrapOwnedCorpus,
  withdrawOwnedCorpus,
} from '../../scripts/readiness-corpus-bootstrap.mjs';
import { saveOnboarding } from '../../lib/pilot/learning.ts';
import {
  proposeCorpus,
  approveCorpus,
} from '../../lib/pilot/corpus-family-store.ts';
import {
  startCorpus,
  getCorpusRun,
  advanceCorpus,
} from '../../lib/pilot/corpus-learning-store.ts';
import { literalNextAction } from '../readiness-r6/learning-support.mjs';

export async function populateCorpusVisits(f, { withdraw = true } = {}) {
  const release = await bootstrapOwnedCorpus(f.handle);
  let at = Math.max(Date.now(), f.clock);
  await f.client.execute({
    sql: 'UPDATE pilot_auth_session SET expires_at=?',
    args: [at + 9 * 86400000],
  });
  f.config.curriculumTestNow = String(at);
  await saveOnboarding(
    f.db,
    'r6-parent',
    'r6-child',
    { nickname: 'Recovery fixture', experience: 'some', audioReady: true },
    at,
  );
  const item = f.manifest.items[0];
  const oracle = JSON.parse(
    fs.readFileSync(
      new URL(
        '../fixtures/curriculum/corpus-draft/oracles.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ).items.find((x) => x.lessonVersion === item.lessonVersion);
  assert.equal(oracle.contentDigest, item.contentDigest);
  const { proposal } = await proposeCorpus(f.context('r6-parent'), 'r6-child', {
    corpusVersion: f.manifest.corpusVersion,
    selection: {
      lessonVersion: item.lessonVersion,
      contentDigest: item.contentDigest,
      releaseId: release.recordId,
      releaseRevision: release.revision,
    },
    predecessorProposalId: null,
    expectedSourceDigest: null,
  });
  await approveCorpus(f.context('r6-parent'), 'r6-child', {
    proposalId: proposal.proposalId,
    sourceDigest: proposal.sourceDigest,
  });
  const assignment = (
    await f.client.execute('SELECT * FROM pilot_corpus_assignment')
  ).rows[0];
  const runIds = [];
  for (const phase of ['initial', 'review-24h', 'review-7d']) {
    const slot = (
      await f.client.execute({
        sql: 'SELECT * FROM pilot_corpus_schedule WHERE assignment_id=? AND kind=?',
        args: [assignment.id, phase],
      })
    ).rows[0];
    assert(slot);
    at = Math.max(at, Number(slot.due_at));
    f.config.curriculumTestNow = String(at);
    const { runId } = await startCorpus(f.context('r6-child'), assignment.id, {
      requestId: 'recovery-start-' + phase,
      scheduleId: slot.id,
    });
    runIds.push(runId);
    for (let n = 0; n < 150; n++) {
      const view = await getCorpusRun(f.context('r6-child'), runId);
      if (view.state.completedAt) {
        assert.equal(view.recap.check.independent, 2);
        break;
      }
      const action = literalNextAction(
        view,
        oracle,
        'recovery-action-' + phase + '-' + n,
      );
      f.config.curriculumTestNow = String(++at);
      await advanceCorpus(f.context('r6-child'), runId, action);
      assert(n < 149, 'finite actual lesson');
    }
  }
  if (withdraw) {
    f.config.curriculumTestNow = String(++at);
    await withdrawOwnedCorpus(f.handle, {
      requestId: 'recovery-withdraw',
      expectedRevision: release.revision,
      predecessorPublicationId: release.recordId,
    });
  }
  return { assignmentId: assignment.id, runIds, release, at };
}
