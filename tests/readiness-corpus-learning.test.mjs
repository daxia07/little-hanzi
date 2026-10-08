import {
  startStory,
  getStoryRun,
  advanceStory,
  approveStory,
} from '../lib/pilot/story-store.ts';
import { withdrawOwnedCorpus } from '../scripts/readiness-corpus-bootstrap.mjs';
import { inspectCorpusEventPolicy } from '../lib/pilot/corpus-learning-policy.ts';
import { inspectCorpusPlacementSource } from '../lib/pilot/corpus-family-policy.ts';
import { curriculumDigest as H } from '../lib/curriculum/digest.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withOwnedCorpusFixture,
  bootstrapOwnedCorpus,
} from '../scripts/readiness-corpus-bootstrap.mjs';
import {
  proposeCorpus,
  approveCorpus,
} from '../lib/pilot/corpus-family-store.ts';
import { saveOnboarding } from '../lib/pilot/learning.ts';
import {
  startCorpus,
  getCorpusRun,
  advanceCorpus,
  corpusPlans,
  corpusPractice,
  corpusProgress,
} from '../lib/pilot/corpus-learning-store.ts';
async function assigned(f) {
  const release = await bootstrapOwnedCorpus(f.handle),
    item = f.manifest.items[0],
    at = Date.now();
  f.config.curriculumTestNow = String(at);
  await saveOnboarding(
    f.db,
    'r6-parent',
    'r6-child',
    { nickname: 'Synthetic learner', experience: 'new', audioReady: true },
    at,
  );
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
  const { plan } = await approveCorpus(f.context('r6-parent'), 'r6-child', {
    proposalId: proposal.proposalId,
    sourceDigest: proposal.sourceDigest,
  });
  const a = (await f.client.execute('SELECT * FROM pilot_corpus_assignment'))
      .rows[0],
    s = (await f.client.execute('SELECT * FROM pilot_corpus_schedule')).rows[0];
  return { a, s, plan };
}
test('actual assigned initial start durable ACK and authoritative current-only GET', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    const { a, s } = await assigned(f);
    const body = { requestId: 'initial-start', scheduleId: s.id };
    const ack = await startCorpus(f.context('r6-child'), a.id, body);
    assert.equal(ack.assignmentId, a.id);
    assert.equal(ack.scheduleId, s.id);
    assert.equal(ack.revision, 0);
    assert.deepEqual(await startCorpus(f.context('r6-child'), a.id, body), ack);
    assert.deepEqual(
      await startCorpus(f.context('r6-child'), a.id, {
        ...body,
        requestId: 'later-reuse',
      }),
      ack,
    );
    const run = await getCorpusRun(f.context('r6-child'), ack.runId);
    assert.equal(run.schemaVersion, 'r6-story-view-1');
    assert.equal(run.soundReview, 'synthetic');
    assert.equal(run.available, true);
    assert.equal(run.state.stepId, 'welcome');
    assert.equal(run.lesson.playback.cues.length, 0);
    assert.equal(
      (
        await f.client.execute(
          "SELECT count(*) n FROM pilot_corpus_learning_audit WHERE action='run-start'",
        )
      ).rows[0].n,
      1,
    );
  }));
test('actual saved event retry does not duplicate or regress authoritative revision', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    const { a, s } = await assigned(f),
      ack = await startCorpus(f.context('r6-child'), a.id, {
        requestId: 'initial-start',
        scheduleId: s.id,
      });
    const action = {
      eventId: 'event-one',
      expectedRevision: 0,
      occurrenceId: null,
      type: 'continue',
      payload: {},
    };
    const first = await advanceCorpus(f.context('r6-child'), ack.runId, action);
    assert.equal(first.ack.revision, 1);
    assert.equal(first.replayed, false);
    const retry = await advanceCorpus(f.context('r6-child'), ack.runId, action);
    assert.equal(retry.replayed, true);
    assert.deepEqual(retry.ack, first.ack);
    assert.equal(
      (await getCorpusRun(f.context('r6-child'), ack.runId)).revision,
      1,
    );
    assert.equal(
      (await f.client.execute('SELECT count(*) n FROM pilot_corpus_event'))
        .rows[0].n,
      1,
    );
  }));
async function finishUnavailable(f, runId) {
  for (let n = 0; n < 50; n++) {
    const run = await getCorpusRun(f.context('r6-child'), runId);
    if (run.state.completedAt) return run;
    const action = {
      eventId: 'progress-' + runId + '-' + n,
      expectedRevision: run.revision,
      occurrenceId: run.question?.occurrenceId ?? null,
      type:
        run.question && run.state.questionStatus === 'open'
          ? 'audio-unavailable'
          : 'continue',
      payload: {},
    };
    await advanceCorpus(f.context('r6-child'), runId, action);
  }
  throw new Error('bounded completion route did not finish');
}
test('actual completion atomically binds both review slots and unavailable recap; delayed runs share seed', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    const { a, s } = await assigned(f),
      ack = await startCorpus(f.context('r6-child'), a.id, {
        requestId: 'initial-start',
        scheduleId: s.id,
      }),
      run = await finishUnavailable(f, ack.runId);
    const slots = (
      await f.client.execute(
        'SELECT * FROM pilot_corpus_schedule ORDER BY due_at',
      )
    ).rows;
    assert.equal(slots.length, 3);
    const completed = Date.parse(run.state.completedAt);
    for (const [kind, delay] of [
      ['review-24h', 86400000],
      ['review-7d', 604800000],
    ]) {
      const slot = slots.find((s) => s.kind === kind);
      assert.equal(slot.due_at, completed + delay);
      assert.equal(slot.initial_run_id, ack.runId);
      assert.equal(slot.initial_completed_at, completed);
      assert.ok(slot.completion_event_id);
    }
    const row = (
      await f.client.execute('SELECT * FROM pilot_corpus_run WHERE id=?', [
        ack.runId,
      ])
    ).rows[0];
    const review = slots.find((s) => s.kind === 'review-24h');
    await assert.rejects(
      () =>
        startCorpus(f.context('r6-child'), a.id, {
          requestId: 'early',
          scheduleId: review.id,
        }),
      (e) => e.code === 'REVIEW_NOT_DUE',
    );
    f.config.curriculumTestNow = String(review.due_at);
    await assert.rejects(
      () =>
        startCorpus(f.context('r6-child'), a.id, {
          requestId: 'expired-due',
          scheduleId: review.id,
        }),
      (e) => e.code === 'UNAUTHORIZED',
    );
    // Renew only this marked synthetic fixture session, never a service auth bypass.
    await f.client.execute({
      sql: "UPDATE pilot_auth_session SET expires_at=? WHERE user_id='r6-child'",
      args: [review.due_at + 86400000],
    });
    const later = await startCorpus(f.context('r6-child'), a.id, {
        requestId: 'due',
        scheduleId: review.id,
      }),
      laterRow = (
        await f.client.execute('SELECT * FROM pilot_corpus_run WHERE id=?', [
          later.runId,
        ])
      ).rows[0];
    assert.equal(laterRow.seed, row.seed);
    assert.equal(
      (await getCorpusRun(f.context('r6-child'), later.runId)).state.phase,
      'review-24h',
    );
    await finishUnavailable(f, later.runId);
    assert.equal(
      (await f.client.execute('SELECT count(*) n FROM pilot_corpus_schedule'))
        .rows[0].n,
      3,
    );
  }));
test('actual final constraint rolls back event/run/audit, and lost ACK readback keeps one event', async () => {
  let fault = false,
    lost = false;
  await withOwnedCorpusFixture(
    'draft-corpus',
    async (f) => {
      const { a, s } = await assigned(f),
        ack = await startCorpus(f.context('r6-child'), a.id, {
          requestId: 'start',
          scheduleId: s.id,
        }),
        action = {
          eventId: 'event-one',
          expectedRevision: 0,
          occurrenceId: null,
          type: 'continue',
          payload: {},
        };
      fault = true;
      await assert.rejects(
        () => advanceCorpus(f.context('r6-child'), ack.runId, action),
        (e) => e.code === 'STORAGE_UNAVAILABLE',
      );
      assert.equal(fault, false);
      assert.equal(
        (await f.client.execute('SELECT count(*) n FROM pilot_corpus_event'))
          .rows[0].n,
        0,
      );
      assert.equal(
        (await getCorpusRun(f.context('r6-child'), ack.runId)).revision,
        0,
      );
      lost = true;
      const saved = await advanceCorpus(
        f.context('r6-child'),
        ack.runId,
        action,
      );
      assert.equal(lost, false);
      assert.equal(saved.replayed, true);
      assert.equal(saved.ack.revision, 1);
      assert.equal(
        (
          await f.client.execute(
            "SELECT count(*) n FROM pilot_corpus_learning_audit WHERE action='run-action'",
          )
        ).rows[0].n,
        1,
      );
    },
    {
      instrumentClient(client) {
        const batch = client.batch.bind(client);
        client.batch = async (statements, ...args) => {
          const event = statements.some((s) =>
            (typeof s === 'string' ? s : s.sql).includes(
              'INSERT INTO pilot_corpus_event',
            ),
          );
          if (event && fault) {
            fault = false;
            return batch(
              [
                ...statements,
                'INSERT INTO pilot_installation SELECT * FROM pilot_installation',
              ],
              ...args,
            );
          }
          const r = await batch(statements, ...args);
          if (event && lost) {
            lost = false;
            throw new Error('SYNTHETIC lost acknowledgment');
          }
          return r;
        };
      },
    },
  );
});
test('actual same revision competition commits one event and refuses stale successor', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    const { a, s } = await assigned(f),
      ack = await startCorpus(f.context('r6-child'), a.id, {
        requestId: 'start',
        scheduleId: s.id,
      });
    const result = await Promise.allSettled(
      ['one', 'two'].map((eventId) =>
        advanceCorpus(f.context('r6-child'), ack.runId, {
          eventId,
          expectedRevision: 0,
          occurrenceId: null,
          type: 'continue',
          payload: {},
        }),
      ),
    );
    assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      result.find((r) => r.status === 'rejected').reason.code,
      'STALE_REVISION',
    );
    assert.equal(
      (await getCorpusRun(f.context('r6-child'), ack.runId)).revision,
      1,
    );
    assert.equal(
      (await f.client.execute('SELECT count(*) n FROM pilot_corpus_event'))
        .rows[0].n,
      1,
    );
  }));
test(
  'actual session revocation while batch held refuses all new effects',
  { timeout: 10000 },
  async () => {
    let hold = false,
      release,
      arrived;
    const entered = new Promise((r) => {
      arrived = r;
    });
    const gate = new Promise((r) => {
      release = r;
    });
    await withOwnedCorpusFixture(
      'draft-corpus',
      async (f) => {
        const { a, s } = await assigned(f),
          ack = await startCorpus(f.context('r6-child'), a.id, {
            requestId: 'start',
            scheduleId: s.id,
          });
        hold = true;
        const pending = advanceCorpus(f.context('r6-child'), ack.runId, {
          eventId: 'late',
          expectedRevision: 0,
          occurrenceId: null,
          type: 'continue',
          payload: {},
        });
        pending.catch(() => {});
        await entered;
        await f.client.execute(
          "UPDATE pilot_auth_user SET disabled=1 WHERE id='r6-child'",
        );
        release();
        await assert.rejects(pending, (e) => e.code === 'UNAUTHORIZED');
        assert.equal(
          (await f.client.execute('SELECT count(*) n FROM pilot_corpus_event'))
            .rows[0].n,
          0,
        );
        assert.equal(
          (await f.client.execute('SELECT revision FROM pilot_corpus_run'))
            .rows[0].revision,
          0,
        );
      },
      {
        instrumentClient(client) {
          const batch = client.batch.bind(client);
          client.batch = async (statements, ...args) => {
            if (
              hold &&
              statements.some((s) =>
                (typeof s === 'string' ? s : s.sql).includes(
                  'INSERT INTO pilot_corpus_event',
                ),
              )
            ) {
              hold = false;
              arrived();
              await gate;
            }
            return batch(statements, ...args);
          };
        },
      },
    ).finally(() => release());
  },
);
for (const [name, alter] of [
  [
    'missing capability',
    (a) => {
      a.configuration.capability = null;
    },
  ],
  [
    'missing trust',
    (a) => {
      a.configuration.trust = null;
    },
  ],
  [
    'capability excludes scope member',
    (a) => {
      a.configuration.capability.childIds = ['foreign-child'];
    },
  ],
])
  test('rehashed persisted positive policy/source refuses ' + name, async () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      const { a, s } = await assigned(f),
        ack = await startCorpus(f.context('r6-child'), a.id, {
          requestId: 'start',
          scheduleId: s.id,
        });
      await advanceCorpus(f.context('r6-child'), ack.runId, {
        eventId: 'event',
        expectedRevision: 0,
        occurrenceId: null,
        type: 'continue',
        payload: {},
      });
      const event = (
          await f.client.execute('SELECT result_json FROM pilot_corpus_event')
        ).rows[0],
        policy = JSON.parse(event.result_json).policy;
      alter(policy.authority);
      policy.authorityDigest = await H(policy.authority);
      await assert.rejects(
        () => inspectCorpusEventPolicy(policy),
        (e) => e.code === 'INVALID_REQUEST',
      );
      const source = JSON.parse(
        (
          await f.client.execute(
            'SELECT source_json FROM pilot_corpus_proposal',
          )
        ).rows[0].source_json,
      );
      alter(source.authority);
      source.authorityDigest = await H(source.authority);
      await assert.rejects(
        () => inspectCorpusPlacementSource(source),
        (e) => e.code === 'INVALID_REQUEST',
      );
    }),
  );
test('current approved plan and Continue coexist with older due work; historical origins remain attributed', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    const { a, s } = await assigned(f),
      first = await startCorpus(f.context('r6-child'), a.id, {
        requestId: 'first',
        scheduleId: s.id,
      });
    await finishUnavailable(f, first.runId);
    const due = (
      await f.client.execute(
        "SELECT due_at FROM pilot_corpus_schedule WHERE kind='review-24h'",
      )
    ).rows[0].due_at;
    f.config.curriculumTestNow = String(due);
    await f.client.execute({
      sql: 'UPDATE pilot_auth_session SET expires_at=?',
      args: [due + 86400000],
    });
    const before = (
        await f.client.execute(
          'SELECT * FROM pilot_corpus_proposal ORDER BY selection_ordinal DESC',
        )
      ).rows[0],
      item = f.manifest.items[1],
      release = (
        await f.client.execute('SELECT * FROM pilot_corpus_publication')
      ).rows[0];
    const { proposal } = await proposeCorpus(
      f.context('r6-parent'),
      'r6-child',
      {
        corpusVersion: f.manifest.corpusVersion,
        selection: {
          lessonVersion: item.lessonVersion,
          contentDigest: item.contentDigest,
          releaseId: release.id,
          releaseRevision: release.revision,
        },
        predecessorProposalId: before.id,
        expectedSourceDigest: before.source_digest,
      },
    );
    const { plan } = await approveCorpus(f.context('r6-parent'), 'r6-child', {
      proposalId: proposal.proposalId,
      sourceDigest: proposal.sourceDigest,
    });
    const assignment = (
        await f.client.execute({
          sql: 'SELECT * FROM pilot_corpus_assignment WHERE plan_item_id=?',
          args: [plan.items[0].planItemId],
        })
      ).rows[0],
      slot = (
        await f.client.execute({
          sql: "SELECT * FROM pilot_corpus_schedule WHERE assignment_id=? AND kind='initial'",
          args: [assignment.id],
        })
      ).rows[0],
      second = await startCorpus(f.context('r6-child'), assignment.id, {
        requestId: 'second',
        scheduleId: slot.id,
      });
    const practice = await corpusPractice(
      f.context('r6-child'),
      'r6-child',
      f.manifest.corpusVersion,
    );
    assert.equal(practice.primary.kind, 'continue');
    assert.equal(practice.primary.runId, second.runId);
    assert.ok(
      practice.items.some(
        (i) =>
          i.assignmentId === a.id && i.kind === 'review-24h' && i.available,
      ),
    );
    assert.ok(
      practice.items.every(
        (i) => i.title && i.targets.length === 2 && i.installationId,
      ),
    );
    assert.equal(
      (
        await corpusPlans(
          f.context('r6-parent'),
          'r6-child',
          f.manifest.corpusVersion,
        )
      ).plan.planId,
      plan.planId,
    );
    await finishUnavailable(f, second.runId);
    const remaining = await corpusPractice(
      f.context('r6-child'),
      'r6-child',
      f.manifest.corpusVersion,
    );
    assert.equal(remaining.primary.kind, 'review');
    assert.equal(remaining.primary.assignmentId, a.id);
    const original = assignment.installation_id;
    await f.client.execute(
      "UPDATE pilot_installation SET installation_id='restored-current' WHERE id=1",
    );
    f.config.curriculumTestNow = String(due);
    const parent = f.context('r6-parent');
    parent.corpus = {
      ...parent.corpus,
      fixtureBinding: {
        ...parent.corpus.fixtureBinding,
        installationId: 'restored-current',
      },
    };
    const history = await corpusPlans(
      parent,
      'r6-child',
      f.manifest.corpusVersion,
    );
    assert.equal(history.plan, null);
    assert.equal(history.history.length, 2);
    assert.ok(
      history.history.every(
        (p) => p.installationId === original && !p.available,
      ),
    );
    const progress = await corpusProgress(parent, 'r6-child');
    assert.equal(progress.length, 1);
    assert.equal(progress[0].installationId, original);
    assert.ok(progress[0].visits.every((v) => v.installationId === original));
    assert.ok(progress[0].visits.some((v) => v.recap !== null));
  }));

test('stored IDs dispatch exact R6 grammar; old ACK after withdrawal remains receipt only', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    const { a, s, plan } = await assigned(f),
      ack = await startStory(f.context('r6-child'), a.id, {
        requestId: 'dispatch-start',
        scheduleId: s.id,
      }),
      input = {
        eventId: 'dispatch-event',
        expectedRevision: 0,
        occurrenceId: null,
        type: 'continue',
        payload: {},
      };
    const first = await advanceStory(f.context('r6-child'), ack.runId, input);
    assert.equal(
      (await getStoryRun(f.context('r6-parent'), ack.runId)).schemaVersion,
      'r6-story-view-1',
    );
    await assert.rejects(
      () => advanceStory(f.context('r6-parent'), ack.runId, input),
      (e) => e.code === 'FORBIDDEN',
    );
    const pub = (
      await f.client.execute('SELECT * FROM pilot_corpus_publication')
    ).rows[0];
    await withdrawOwnedCorpus(f.handle, {
      requestId: 'withdraw',
      expectedRevision: 1,
      predecessorPublicationId: pub.id,
    });
    assert.deepEqual(
      await startStory(f.context('r6-child'), a.id, {
        requestId: 'dispatch-start',
        scheduleId: s.id,
      }),
      ack,
    );
    const replay = await advanceStory(f.context('r6-child'), ack.runId, input);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.ack, first.ack);
    const report = await getStoryRun(f.context('r6-parent'), ack.runId);
    assert.equal(report.available, false);
    assert.equal(report.revision, 1);
    await assert.rejects(
      () =>
        advanceStory(f.context('r6-child'), ack.runId, {
          eventId: 'new',
          expectedRevision: 1,
          occurrenceId: report.question?.occurrenceId ?? null,
          type: 'audio-unavailable',
          payload: {},
        }),
      (e) => e.code === 'LESSON_UNAVAILABLE',
    );
    const proposal = (
      await f.client.execute({
        sql: 'SELECT source_digest FROM pilot_corpus_proposal WHERE id=?',
        args: [plan.proposalId],
      })
    ).rows[0];
    assert.equal(
      (
        await approveStory(f.context('r6-parent'), 'r6-child', {
          proposalId: plan.proposalId,
          sourceDigest: proposal.source_digest,
        })
      ).plan.planId,
      plan.planId,
    );
  }));
test(
  'current available GET refuses a withdrawal during its final protected read',
  { timeout: 10000 },
  async () => {
    const queries = [];
    let capture = false,
      target = null,
      targetCount = 0,
      matches = 0,
      hold = false,
      release,
      arrived;
    const entered = new Promise((r) => {
        arrived = r;
      }),
      gate = new Promise((r) => {
        release = r;
      });
    await withOwnedCorpusFixture(
      'draft-corpus',
      async (f) => {
        const { a, s } = await assigned(f),
          ack = await startCorpus(f.context('r6-child'), a.id, {
            requestId: 'start',
            scheduleId: s.id,
          });
        capture = true;
        await getCorpusRun(f.context('r6-child'), ack.runId);
        capture = false;
        target = queries.at(-1);
        targetCount = queries.filter((q) => q === target).length;
        assert.ok(target.startsWith('SELECT'));
        hold = true;
        const pending = getCorpusRun(f.context('r6-child'), ack.runId);
        pending.catch(() => {});
        await entered;
        const pub = (
          await f.client.execute('SELECT * FROM pilot_corpus_publication')
        ).rows[0];
        await withdrawOwnedCorpus(f.handle, {
          requestId: 'late-read-withdraw',
          expectedRevision: 1,
          predecessorPublicationId: pub.id,
        });
        release();
        await assert.rejects(pending, (e) => e.code === 'LESSON_UNAVAILABLE');
        assert.equal(matches, targetCount);
      },
      {
        instrumentClient(client) {
          const execute = client.execute.bind(client);
          client.execute = async (statement, ...args) => {
            const sql =
              typeof statement === 'string' ? statement : statement.sql;
            if (capture) queries.push(sql);
            if (hold && sql === target && ++matches === targetCount) {
              hold = false;
              arrived();
              await gate;
            }
            return execute(statement, ...args);
          };
        },
      },
    ).finally(() => release());
  },
);
