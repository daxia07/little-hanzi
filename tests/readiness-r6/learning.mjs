/** Independent actual fresh libSQL learning cases. No HTTP/browser/restore certification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  withOwnedCorpusFixture,
  bootstrapOwnedCorpus,
  withdrawOwnedCorpus,
} from '../../scripts/readiness-corpus-bootstrap.mjs';
import {
  readCorpusCatalog,
  proposeCorpus,
  approveCorpus,
} from '../../lib/pilot/corpus-family-store.ts';
import {
  startCorpus,
  getCorpusRun,
  advanceCorpus,
  corpusPlans,
  corpusPractice,
  corpusProgress,
  isCorpusResource,
} from '../../lib/pilot/corpus-learning-store.ts';
import {
  startStory,
  getStoryRun,
  advanceStory,
} from '../../lib/pilot/story-store.ts';
import { inspectCorpusEventPolicy } from '../../lib/pilot/corpus-learning-policy.ts';
import { inspectCorpusPlacementSource } from '../../lib/pilot/corpus-family-policy.ts';
import {
  actionBody,
  literalNextAction,
  learningRows,
  assertUnchangedRows,
  independentSeed,
  assertClosedEventPolicy,
  assertSafeRun,
} from './learning-support.mjs';
import { canonical, digest, literalChoice } from './oracle.mjs';
const options = { timeout: 120000 };
const oracles = JSON.parse(
  readFileSync(
    new URL(
      '../fixtures/curriculum/corpus-draft/oracles.json',
      import.meta.url,
    ),
  ),
).items;
async function setup(f) {
  await bootstrapOwnedCorpus(f.handle);
  await f.client.execute({
    sql: 'INSERT INTO pilot_onboarding(child_id,nickname,experience,audio_ready,updated_at,updated_by) VALUES(?,?,?,?,?,?)',
    args: [
      'r6-child',
      'Independent synthetic learner',
      'new',
      1,
      f.clock,
      'r6-parent',
    ],
  });
  return assign(f);
}
async function assign(f, index = 0) {
  const items = (
      await readCorpusCatalog(
        f.context('r6-parent'),
        'r6-child',
        f.manifest.corpusVersion,
      )
    ).items,
    item = items[index];
  const prior = (
    await f.client.execute(
      'SELECT * FROM pilot_corpus_proposal ORDER BY selection_ordinal DESC LIMIT 1',
    )
  ).rows[0];
  const { proposal } = await proposeCorpus(f.context('r6-parent'), 'r6-child', {
    corpusVersion: f.manifest.corpusVersion,
    selection: {
      lessonVersion: item.lessonVersion,
      contentDigest: item.contentDigest,
      releaseId: item.releaseId,
      releaseRevision: item.releaseRevision,
    },
    predecessorProposalId: prior?.id ?? null,
    expectedSourceDigest: prior?.source_digest ?? null,
  });
  const { plan } = await approveCorpus(f.context('r6-parent'), 'r6-child', {
    proposalId: proposal.proposalId,
    sourceDigest: proposal.sourceDigest,
  });
  const a = (
    await f.client.execute({
      sql: 'SELECT * FROM pilot_corpus_assignment WHERE plan_item_id=?',
      args: [plan.items[0].planItemId],
    })
  ).rows[0];
  const s = (
    await f.client.execute({
      sql: "SELECT * FROM pilot_corpus_schedule WHERE assignment_id=? AND kind='initial'",
      args: [a.id],
    })
  ).rows[0];
  return {
    a,
    s,
    plan,
    proposal,
    oracle: oracles.find((o) => o.lessonVersion === item.lessonVersion),
  };
}
const open = (f, a, s, id = 'open') =>
  startCorpus(f.context('r6-child'), a.id, { requestId: id, scheduleId: s.id });
const view = (f, id) => getCorpusRun(f.context('r6-child'), id);
async function drive(f, id, oracle, { beforeCompletion } = {}) {
  for (let n = 0; n < 90; n++) {
    const v = await view(f, id);
    assertSafeRun(v);
    if (v.state.completedAt) {
      assert.equal(v.recap.check.independent, oracle.targets.length);
      assert.equal(v.recap.check.supported, 0);
      assert.equal(v.recap.check.unavailable, 0);
      return v;
    }
    if (
      beforeCompletion &&
      v.state.stepId === 'check' &&
      v.state.questionIndex === oracle.targets.length - 1 &&
      v.question?.status !== 'open'
    )
      return { v, body: literalNextAction(v, oracle, 'last-' + id) };
    const body = literalNextAction(v, oracle, id + '-' + v.revision);
    const saved = await advanceCorpus(f.context('r6-child'), id, body);
    if (body.type === 'answer') {
      assert.equal(saved.ack.result.outcome, 'correct');
      assert.equal(saved.ack.result.assisted, false);
    }
  }
  assert.fail('Actual store route exceeded90 transitions');
}
async function renew(f, at) {
  f.config.curriculumTestNow = String(at);
  // Only saved synthetic fixture sessions. Assert expiry separately before this explicit renewal.
  await f.client.execute({
    sql: 'UPDATE pilot_auth_session SET expires_at=?',
    args: [at + 86400000],
  });
}

test(
  'LC01/02/09 stored dispatch, closed caller grammar, receipt replay/current unavailable',
  options,
  async () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      const { a, s } = await setup(f),
        body = { requestId: 'start-original', scheduleId: s.id },
        ack = await startStory(f.context('r6-child'), a.id, body);
      const before = await learningRows(f.client);
      assert.deepEqual(
        await startCorpus(f.context('r6-child'), a.id, {
          ...body,
          requestId: 'other',
        }),
        ack,
      );
      assertUnchangedRows(before, await learningRows(f.client));
      assert.equal(await isCorpusResource(f.context(), 'run', ack.runId), true);
      assert.equal(await isCorpusResource(f.context(), 'run', 'absent'), false);
      await assert.rejects(
        () =>
          startStory(f.context('r6-child'), 'absent', {
            requestId: 'absent-start',
          }),
        (e) => e.code === 'NOT_FOUND',
      );
      await assert.rejects(
        () =>
          startCorpus(f.context('r6-child'), a.id, {
            ...body,
            adapterId: 'paired-story',
          }),
        (e) => e.code === 'INVALID_REQUEST',
      );
      const v = await getStoryRun(f.context('r6-child'), ack.runId);
      assertSafeRun(v);
      assert.equal(v.lesson.playback.cues.length, 0);
      const input = actionBody(v, 'first', 'continue'),
        first = await advanceStory(f.context('r6-child'), ack.runId, input);
      await assert.rejects(
        () =>
          advanceCorpus(f.context('r6-child'), ack.runId, {
            ...input,
            eventId: 'bad',
            score: 1,
          }),
        (e) => e.code === 'INVALID_REQUEST',
      );
      await assert.rejects(
        () =>
          advanceCorpus(f.context('r6-child'), ack.runId, {
            ...input,
            type: 'audio-unavailable',
          }),
        (e) => e.code === 'EVENT_CONFLICT',
      );
      const pub = (
        await f.client.execute('SELECT * FROM pilot_corpus_publication')
      ).rows[0];
      await withdrawOwnedCorpus(f.handle, {
        requestId: 'withdraw',
        expectedRevision: pub.revision,
        predecessorPublicationId: pub.id,
      });
      const frozen = await learningRows(f.client);
      assert.deepEqual(
        await startCorpus(f.context('r6-child'), a.id, body),
        ack,
      );
      const replay = await advanceCorpus(
        f.context('r6-child'),
        ack.runId,
        input,
      );
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.ack, first.ack);
      const now = await view(f, ack.runId);
      assert.equal(now.available, false);
      await assert.rejects(
        () =>
          advanceCorpus(
            f.context('r6-child'),
            ack.runId,
            actionBody(now, 'new', 'continue'),
          ),
        (e) => e.code === 'LESSON_UNAVAILABLE',
      );
      assertUnchangedRows(frozen, await learningRows(f.client));
      await f.client.execute(
        "UPDATE pilot_auth_user SET disabled=1 WHERE id='r6-child'",
      );
      await assert.rejects(
        () => advanceCorpus(f.context('r6-child'), ack.runId, input),
        (e) => e.code === 'UNAUTHORIZED',
      );
    }),
);

test(
  'LC03/06 literal full initial, terminal completion fault and separate exact due visits',
  options,
  async () => {
    let armed = false,
      fired = 0,
      engine;
    await withOwnedCorpusFixture(
      'draft-corpus',
      async (f) => {
        const { a, s, oracle } = await setup(f),
          ack = await open(f, a, s),
          last = await drive(f, ack.runId, oracle, { beforeCompletion: true }),
          before = await learningRows(f.client);
        assert.equal(last.v.state.stepId, 'check');
        assert.equal(last.v.state.questionIndex, oracle.targets.length - 1);
        armed = true;
        await assert.rejects(
          () => advanceCorpus(f.context('r6-child'), ack.runId, last.body),
          (e) => e.code === 'STORAGE_UNAVAILABLE',
        );
        assert.equal(fired, 1);
        assert.match(engine, /CONSTRAINT/u);
        assertUnchangedRows(before, await learningRows(f.client));
        const saved = await advanceCorpus(
          f.context('r6-child'),
          ack.runId,
          last.body,
        );
        assert.equal(saved.ack.result.outcome, 'completed');
        const done = await view(f, ack.runId),
          completed = Date.parse(done.state.completedAt),
          slots = (
            await f.client.execute(
              'SELECT * FROM pilot_corpus_schedule ORDER BY due_at',
            )
          ).rows;
        assert.equal(slots.length, 3);
        const initial = (
          await f.client.execute({
            sql: 'SELECT * FROM pilot_corpus_run WHERE id=?',
            args: [ack.runId],
          })
        ).rows[0];
        assert.equal(initial.seed, independentSeed(a.id));
        for (const [kind, offset] of [
          ['review-24h', 86400000],
          ['review-7d', 604800000],
        ]) {
          const slot = slots.find((x) => x.kind === kind);
          assert.equal(slot.due_at, completed + offset);
          assert.equal(slot.initial_run_id, ack.runId);
          assert.equal(slot.initial_completed_at, completed);
          await renew(f, slot.due_at - 1);
          await assert.rejects(
            () => open(f, a, slot, 'early-' + kind),
            (e) => e.code === 'REVIEW_NOT_DUE',
          );
          await renew(f, slot.due_at);
          const later = await open(f, a, slot, 'due-' + kind);
          const row = (
            await f.client.execute({
              sql: 'SELECT * FROM pilot_corpus_run WHERE id=?',
              args: [later.runId],
            })
          ).rows[0];
          assert.equal(row.seed, initial.seed);
          assert.equal((await view(f, later.runId)).state.phase, kind);
          await drive(f, later.runId, oracle);
          assert.equal(
            (
              await f.client.execute(
                'SELECT count(*) AS n FROM pilot_corpus_schedule',
              )
            ).rows[0].n,
            3,
          );
        }
        assert.equal(
          (await f.client.execute('SELECT count(*) AS n FROM pilot_corpus_run'))
            .rows[0].n,
          3,
        );
        const progress = await corpusProgress(
          f.context('r6-parent'),
          'r6-child',
        );
        assert.equal(progress[0].visits.filter((x) => x.completedAt).length, 3);
      },
      {
        instrumentClient(client) {
          const batch = client.batch.bind(client);
          client.batch = async (statements, ...args) => {
            if (
              armed &&
              statements.some((s) =>
                (typeof s === 'string' ? s : s.sql).includes(
                  'INSERT INTO pilot_corpus_event',
                ),
              )
            ) {
              armed = false;
              fired++;
              try {
                return await batch(
                  [
                    ...statements,
                    'INSERT INTO pilot_installation SELECT * FROM pilot_installation',
                  ],
                  ...args,
                );
              } catch (e) {
                engine = String(e.code);
                throw e;
              }
            }
            return batch(statements, ...args);
          };
        },
      },
    );
  },
);

test(
  'LC04 competing revision and actual late session batch guard',
  options,
  async () => {
    let armed = false,
      fired = 0,
      fixture;
    await withOwnedCorpusFixture(
      'draft-corpus',
      async (f) => {
        fixture = f;
        const { a, s, oracle } = await setup(f),
          ack = await open(f, a, s),
          v = await view(f, ack.runId);
        const r = await Promise.allSettled(
          ['one', 'two'].map((id) =>
            advanceCorpus(
              f.context('r6-child'),
              ack.runId,
              actionBody(v, id, 'continue'),
            ),
          ),
        );
        assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
        assert.equal(
          r.find((x) => x.status === 'rejected').reason.code,
          'STALE_REVISION',
        );
        const before = await learningRows(f.client),
          current = await view(f, ack.runId);
        armed = true;
        await assert.rejects(
          () =>
            advanceCorpus(
              f.context('r6-child'),
              ack.runId,
              literalNextAction(current, oracle, 'late'),
            ),
          (e) => e.code === 'UNAUTHORIZED',
        );
        assert.equal(fired, 1);
        assertUnchangedRows(before, await learningRows(f.client));
      },
      {
        instrumentClient(client) {
          const batch = client.batch.bind(client);
          client.batch = async (s, ...args) => {
            if (
              armed &&
              s.some((x) =>
                (typeof x === 'string' ? x : x.sql).includes(
                  'INSERT INTO pilot_corpus_event',
                ),
              )
            ) {
              armed = false;
              fired++;
              await fixture.client.execute(
                "UPDATE pilot_auth_user SET disabled=1 WHERE id='r6-child'",
              );
            }
            return batch(s, ...args);
          };
        },
      },
    );
  },
);

test(
  'LC05 preserved first/help facts and current late audio versus old occurrence',
  options,
  async () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      const { a, s, oracle } = await setup(f),
        ack = await open(f, a, s);
      await advanceCorpus(
        f.context('r6-child'),
        ack.runId,
        actionBody(await view(f, ack.runId), 'intro', 'continue'),
      );
      let v = await view(f, ack.runId);
      const correct = literalChoice(v.question, oracle),
        wrong = v.question.choices.find((c) => c.hanzi !== correct.hanzi);
      const bad = await advanceCorpus(
        f.context('r6-child'),
        ack.runId,
        actionBody(v, 'wrong', 'answer', { choiceId: wrong.choiceId }),
      );
      assert.equal(bad.ack.result.firstResponse, true);
      assert.equal(bad.ack.result.outcome, 'incorrect');
      await advanceCorpus(
        f.context('r6-child'),
        ack.runId,
        actionBody(await view(f, ack.runId), 'help', 'help'),
      );
      const good = await advanceCorpus(
        f.context('r6-child'),
        ack.runId,
        actionBody(await view(f, ack.runId), 'correct', 'answer', {
          choiceId: correct.choiceId,
        }),
      );
      assert.equal(good.ack.result.firstResponse, false);
      assert.equal(good.ack.result.assisted, true);
      v = await view(f, ack.runId);
      const earlier = (
          await f.client.execute(
            'SELECT result_json FROM pilot_corpus_event ORDER BY sequence',
          )
        ).rows.map((x) => x.result_json),
        oldOccurrence = v.question.occurrenceId;
      const audio = await advanceCorpus(
        f.context('r6-child'),
        ack.runId,
        actionBody(v, 'late-audio', 'audio-unavailable'),
      );
      assert.equal(audio.ack.result.outcome, 'unavailable');
      const rows = (
        await f.client.execute(
          'SELECT result_json FROM pilot_corpus_event ORDER BY sequence',
        )
      ).rows;
      assert.deepEqual(
        rows.slice(0, earlier.length).map((x) => x.result_json),
        earlier,
      );
      await advanceCorpus(
        f.context('r6-child'),
        ack.runId,
        actionBody(await view(f, ack.runId), 'next', 'continue'),
      );
      const before = await learningRows(f.client),
        newView = await view(f, ack.runId);
      await assert.rejects(
        () =>
          advanceCorpus(f.context('r6-child'), ack.runId, {
            ...actionBody(newView, 'stale-audio', 'audio-unavailable'),
            occurrenceId: oldOccurrence,
          }),
        (e) => e.status === 409,
      );
      assertUnchangedRows(before, await learningRows(f.client));
    }),
);

test(
  'LC07/08 approved ordinal preserves older due; historical origin is readable but unavailable',
  options,
  async () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      const first = await setup(f),
        one = await open(f, first.a, first.s);
      await drive(f, one.runId, first.oracle);
      const due = (
        await f.client.execute(
          "SELECT due_at FROM pilot_corpus_schedule WHERE kind='review-24h'",
        )
      ).rows[0].due_at;
      await renew(f, due);
      const second = await assign(f, 1),
        two = await open(f, second.a, second.s, 'second');
      const practice = await corpusPractice(
        f.context('r6-child'),
        'r6-child',
        f.manifest.corpusVersion,
      );
      assert.equal(practice.primary.kind, 'continue');
      assert.equal(practice.primary.runId, two.runId);
      assert(
        practice.items.some(
          (i) =>
            i.assignmentId === first.a.id &&
            i.kind === 'review-24h' &&
            i.available,
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
        second.plan.planId,
      );
      await approveCorpus(f.context('r6-parent'), 'r6-child', {
        proposalId: first.proposal.proposalId,
        sourceDigest: first.proposal.sourceDigest,
      });
      assert.equal(
        (
          await corpusPlans(
            f.context('r6-parent'),
            'r6-child',
            f.manifest.corpusVersion,
          )
        ).plan.planId,
        second.plan.planId,
      );
      const old = first.a.installation_id;
      await f.client.execute(
        "UPDATE pilot_installation SET installation_id='fresh-historical-boundary' WHERE id=1",
      );
      const c = f.context('r6-parent');
      c.corpus.fixtureBinding = {
        ...c.corpus.fixtureBinding,
        installationId: 'fresh-historical-boundary',
      };
      const history = await corpusPlans(
        c,
        'r6-child',
        f.manifest.corpusVersion,
      );
      assert.equal(history.plan, null);
      assert(
        history.history.every((p) => p.installationId === old && !p.available),
      );
      const progress = await corpusProgress(c, 'r6-child');
      assert.equal(progress[0].installationId, old);
      assert(progress[0].visits.every((v) => v.installationId === old));
      await assert.rejects(
        () =>
          advanceCorpus(f.context('r6-child'), one.runId, {
            eventId: 'new-history',
            expectedRevision: 0,
            occurrenceId: null,
            type: 'continue',
            payload: {},
          }),
        (e) => e.code === 'LESSON_UNAVAILABLE',
      );
    }),
);

test(
  'AL01 independent rehashed real saved policy and placement trust/cap removal refusal',
  options,
  async () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      const { a, s } = await setup(f),
        ack = await open(f, a, s);
      await advanceCorpus(
        f.context('r6-child'),
        ack.runId,
        actionBody(await view(f, ack.runId), 'event', 'continue'),
      );
      const policy = JSON.parse(
          (await f.client.execute('SELECT result_json FROM pilot_corpus_event'))
            .rows[0].result_json,
        ).policy,
        source = JSON.parse(
          (
            await f.client.execute(
              'SELECT source_json FROM pilot_corpus_proposal',
            )
          ).rows[0].source_json,
        );
      assertClosedEventPolicy(policy, {
        installationId: a.installation_id,
        releaseId: a.publication_id,
        corpusVersion: f.manifest.corpusVersion,
      });
      for (const mutate of [
        (x) => (x.configuration.trust = null),
        (x) => (x.configuration.capability = null),
        (x) => (x.configuration.capability.childIds = ['foreign-child']),
      ]) {
        for (const [original, inspect] of [
          [policy, inspectCorpusEventPolicy],
          [source, inspectCorpusPlacementSource],
        ]) {
          const altered = structuredClone(original);
          mutate(altered.authority);
          altered.authorityDigest = digest(altered.authority);
          await assert.rejects(
            () => inspect(altered),
            (e) => e.code === 'INVALID_REQUEST',
          );
        }
      }
      assert.equal(
        canonical(policy),
        canonical(
          JSON.parse(
            (
              await f.client.execute(
                'SELECT result_json FROM pilot_corpus_event',
              )
            ).rows[0].result_json,
          ).policy,
        ),
      );
    }),
);

test(
  'LC04 config mutation during final real pre-dispatch read refuses zero new effects',
  options,
  async () => {
    let capture = false,
      armed = false,
      dispatched = false,
      fired = 0,
      target,
      occurrence = 0,
      wanted,
      fixture;
    const queries = [];
    await withOwnedCorpusFixture(
      'draft-corpus',
      async (f) => {
        fixture = f;
        const { a, s, oracle } = await setup(f),
          ack = await open(f, a, s),
          initial = await view(f, ack.runId);
        f.config.curriculumTestNow = String(Date.now());
        capture = true;
        await advanceCorpus(
          f.context('r6-child'),
          ack.runId,
          actionBody(initial, 'capture', 'continue'),
        );
        capture = false;
        target = queries.at(-1);
        wanted = queries.filter((q) => q === target).length;
        assert.ok(target.startsWith('SELECT'));
        assert(wanted > 0);
        const current = await view(f, ack.runId),
          before = await learningRows(f.client),
          original = f.config.curriculumTrust.buildId;
        armed = true;
        dispatched = false;
        const observed = await advanceCorpus(
          f.context('r6-child'),
          ack.runId,
          literalNextAction(current, oracle, 'changed-config'),
        ).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        console.info(
          'LC04 boundary metadata',
          JSON.stringify({
            fired,
            wanted,
            occurrence,
            dispatched,
            refusal: observed.error?.code ?? null,
          }),
        );
        assert.equal(fired, 1, 'Intended pre-dispatch read must fire');
        assert.equal(observed.error?.code, 'PUBLICATION_STALE');
        assert.equal(fired, 1);
        assert.equal(dispatched, false);
        f.config.curriculumTrust.buildId = original;
        assertUnchangedRows(before, await learningRows(f.client));
      },
      {
        instrumentClient(client) {
          const execute = client.execute.bind(client),
            batch = client.batch.bind(client);
          client.execute = async (s, ...args) => {
            const sql = typeof s === 'string' ? s : s.sql;
            if (capture) queries.push(sql);
            const result = await execute(s, ...args);
            if (armed && sql === target && ++occurrence === wanted) {
              armed = false;
              fired++;
              fixture.config.curriculumTrust.buildId = 'changed-owned-build';
            }
            return result;
          };
          client.batch = async (s, ...args) => {
            if (
              s.some((x) =>
                (typeof x === 'string' ? x : x.sql).includes(
                  'INSERT INTO pilot_corpus_event',
                ),
              )
            ) {
              if (capture) capture = false;
              if (armed || fired) dispatched = true;
            }
            return batch(s, ...args);
          };
        },
      },
    );
  },
);
