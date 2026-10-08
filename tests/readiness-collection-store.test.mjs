import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { createLibsqlD1Database } from '../lib/platform/libsql-d1.ts';
import * as legacy from '../lib/pilot/story-store.ts';
import * as collection from '../lib/pilot/collection-store.ts';
import {
  canonicalPackage,
  curriculumDigest,
} from '../lib/curriculum/digest.ts';
const manifest = JSON.parse(
  fs.readFileSync(
    new URL(
      '../content/collections/little-hanzi-path-1-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const clock = Date.parse('2026-09-27T00:00:00Z');
async function fixture(
  fn,
  {
    duplicateTargets = false,
    registerCollection = true,
    seedAuthority = true,
  } = {},
) {
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        '../content/collections/little-hanzi-path-1-v1.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  if (duplicateTargets) {
    const p = JSON.parse(
      fs.readFileSync(
        new URL(
          '../content/curriculum/collection/path-01-v1.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    p.lessonVersion = 'path-02-v1';
    p.lessonId = 'path-02';
    p.placement.sequence = 2;
    manifest.items[1].contentDigest = await curriculumDigest(p);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-owned-unit-'));
  fs.writeFileSync(path.join(root, '.hanzi-qa-owned'), 'r5-author-unit');
  const client = createClient({ url: 'file:' + path.join(root, 'fresh.db') });
  try {
    for (const f of fs
      .readdirSync(new URL('../db/pilot-migrations/', import.meta.url))
      .filter((f) => /^000[0-6].*\.sql$/.test(f))
      .sort())
      await client.executeMultiple(
        fs.readFileSync(
          new URL('../db/pilot-migrations/' + f, import.meta.url),
          'utf8',
        ),
      );
    for (const [id, role] of [
      ['op', 'operator'],
      ['p', 'parent'],
      ['c', 'child'],
      ['p2', 'parent'],
      ['c2', 'child'],
      ['t', 'teacher'],
    ]) {
      await client.execute({
        sql: 'INSERT INTO pilot_auth_user(id,name,email,email_verified,created_at,updated_at,username,display_username,role,must_change_password,disabled) VALUES(?,?,?,0,0,0,?,?,?,0,0)',
        args: [id, id, id + '@example.test', id, id, role],
      });
      await client.execute({
        sql: 'INSERT INTO pilot_auth_session(id,expires_at,token,created_at,updated_at,user_id) VALUES(?,?,?,?,?,?)',
        args: [
          's-' + id,
          clock + 30 * 86400000,
          'synthetic-private-' + id,
          0,
          0,
          id,
        ],
      });
    }
    await client.execute(
      "INSERT INTO pilot_parent_child VALUES('p','c',0,'op'),('p2','c2',0,'op')",
    );
    await client.execute(
      "UPDATE pilot_installation SET installation_id='r5-install',created_at=0 WHERE id=1",
    );
    await client.execute(
      "INSERT INTO pilot_onboarding VALUES('c','Synthetic learner','confident',1,0,'p')",
    );
    const digest = await curriculumDigest(manifest),
      config = {
        pilotMode: true,
        testMode: true,
        testContentAllowed: true,
        testRunId: 'r5-unit',
        testToken: 'private-author-only',
        candidateId: 'candidate',
        candidateExplicitlyBound: true,
        curriculumTestNow: String(clock),
        curriculumTrust: {
          candidateId: 'candidate',
          sourceDigest: digest,
          artifactDigest: digest,
          buildId: 'build',
          issuers: [],
          archiveIssuers: [],
        },
        collectionCapability: {
          installationId: 'r5-install',
          collectionVersion: manifest.collectionVersion,
          collectionDigest: digest,
          namespace: 'r5-unit',
          childIds: ['c'],
          parentIds: ['p'],
        },
      };
    const db = createLibsqlD1Database(client),
      context = (id) => ({
        db,
        config,
        user: {
          id,
          role:
            id === 'op'
              ? 'operator'
              : id.startsWith('p')
                ? 'parent'
                : id === 't'
                  ? 'teacher'
                  : 'child',
        },
        session: { id: 's-' + id },
      });
    // Explicit synthetic verification fixture facts: no human review or ordinary release assertion.
    if (seedAuthority)
      for (const entry of manifest.items) {
        let p = JSON.parse(
          fs.readFileSync(
            new URL(
              '../content/curriculum/collection/' +
                entry.lessonVersion +
                '.json',
              import.meta.url,
            ),
            'utf8',
          ),
        );
        if (duplicateTargets && entry.sequence === 2) {
          p = JSON.parse(
            fs.readFileSync(
              new URL(
                '../content/curriculum/collection/path-01-v1.json',
                import.meta.url,
              ),
              'utf8',
            ),
          );
          p.lessonVersion = 'path-02-v1';
          p.lessonId = 'path-02';
          p.placement.sequence = 2;
        }
        assert.equal(await curriculumDigest(p), entry.contentDigest);
        await client.execute({
          sql: 'INSERT INTO pilot_curriculum_package VALUES(?,?,?,?,?,?,?,?,?)',
          args: [
            p.lessonVersion,
            p.lessonId,
            entry.contentDigest,
            's3-json-1',
            canonicalPackage(p),
            'import-' + p.lessonVersion,
            'op',
            clock,
            'r5-unit',
          ],
        });
        const pub = 'pub-' + p.lessonVersion;
        await client.execute({
          sql: 'INSERT INTO pilot_curriculum_publication VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          args: [
            pub,
            p.lessonVersion,
            entry.contentDigest,
            1,
            null,
            'publication-' + p.lessonVersion,
            entry.contentDigest,
            canonicalPackage({ syntheticFixture: true }),
            canonicalPackage({ syntheticFixture: true }),
            'released',
            'verification',
            entry.contentDigest,
            null,
            null,
            null,
            'candidate',
            digest,
            'r5-install',
            'op',
            clock,
            'r5-unit',
          ],
        });
        await client.execute({
          sql: 'INSERT INTO pilot_curriculum_trial_member VALUES(?,?,?,?)',
          args: [pub, 'c', 'p', p.lessonVersion],
        });
        await client.execute({
          sql: 'INSERT INTO pilot_curriculum_publication_state VALUES(?,?,?,?)',
          args: ['r5-install', p.lessonVersion, 1, pub],
        });
      }
    if (registerCollection) {
      await client.execute({
        sql: 'INSERT INTO pilot_collection VALUES(?,?,?,?,?,?,?)',
        args: [
          manifest.collectionVersion,
          manifest.collectionId,
          digest,
          's3-json-1',
          canonicalPackage(manifest),
          'op',
          clock,
        ],
      });
      for (const entry of manifest.items)
        await client.execute({
          sql: 'INSERT INTO pilot_collection_item VALUES(?,?,?,?,?,?,?,?)',
          args: [
            manifest.collectionVersion,
            digest,
            entry.sequence - 1,
            entry.lessonVersion,
            entry.contentDigest,
            manifest.trackId,
            entry.sequence,
            '[]',
          ],
        });
    }
    await fn({
      client,
      config,
      context,
      parent: context('p'),
      child: context('c'),
      operator: context('op'),
      manifest,
    });
  } finally {
    client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('R5-E003 explicit collection library exposes ten safe ordered eligible lessons instead of V4 fallback', () =>
  fixture(async (e) => {
    const result = await legacy.storyLibrary(
      e.parent,
      'c',
      manifest.collectionVersion,
    );
    assert.equal(result.items.length, 10);
    assert.deepEqual(
      result.items.map((x) => x.lessonVersion),
      manifest.items.map((x) => x.lessonVersion),
    );
    assert(!JSON.stringify(result).includes('correctChoiceId'));
    assert(!JSON.stringify(result).includes('pairedStory'));
  }));
test('R5-E004 alternative selection makes earlier approval stale without partial assignment', () =>
  fixture(async (e) => {
    const body = {
      collectionVersion: manifest.collectionVersion,
      lessonVersion: null,
      predecessorProposalId: null,
      expectedSourceDigest: null,
    };
    const first = await legacy.proposeStory(e.parent, 'c', body);
    assert.equal(first.proposal.lessonVersion, 'path-01-v1');
    const second = await legacy.proposeStory(e.parent, 'c', {
      ...body,
      lessonVersion: 'path-02-v1',
      predecessorProposalId: first.proposal.proposalId,
      expectedSourceDigest: first.proposal.sourceDigest,
    });
    assert.notEqual(first.proposal.sourceDigest, second.proposal.sourceDigest);
    await assert.rejects(
      legacy.approveStory(e.parent, 'c', {
        proposalId: first.proposal.proposalId,
        sourceDigest: first.proposal.sourceDigest,
      }),
      (x) => x.status === 409,
    );
    assert.equal(
      (
        await e.client.execute(
          'SELECT count(*) n FROM pilot_collection_assignment',
        )
      ).rows[0].n,
      0,
    );
    const a = await legacy.approveStory(e.parent, 'c', {
      proposalId: second.proposal.proposalId,
      sourceDigest: second.proposal.sourceDigest,
    });
    assert.equal(a.plan.items[0].lessonVersion, 'path-02-v1');
  }));

test('R5-E001 ten packages with repeated target pairs cannot be registered as the twenty-character collection', () =>
  fixture(
    async (e) => {
      await assert.rejects(
        collection.importCollection(e.operator, { collection: e.manifest }),
        (x) => x.status === 400,
      );
      assert.equal(
        (await e.client.execute('SELECT count(*) n FROM pilot_collection'))
          .rows[0].n,
        0,
      );
    },
    { duplicateTargets: true, registerCollection: false },
  ));
async function approved(e, lessonVersion = null) {
  const p = await legacy.proposeStory(e.parent, 'c', {
    collectionVersion: manifest.collectionVersion,
    lessonVersion,
    predecessorProposalId: null,
    expectedSourceDigest: null,
  });
  const a = await legacy.approveStory(e.parent, 'c', {
    proposalId: p.proposal.proposalId,
    sourceDigest: p.proposal.sourceDigest,
  });
  return {
    proposal: p.proposal,
    plan: a.plan,
    assignmentId: a.plan.items[0].assignmentId,
  };
}
async function action(e, runId, type, payload = {}) {
  const view = await legacy.getStoryRun(e.child, runId);
  return legacy.advanceStory(e.child, runId, {
    eventId: 'event-' + crypto.randomUUID(),
    expectedRevision: view.revision,
    occurrenceId: view.question?.occurrenceId ?? null,
    type,
    payload,
  });
}
async function completeWithoutSound(e, runId) {
  for (let i = 0; i < 80; i++) {
    const v = await legacy.getStoryRun(e.child, runId);
    if (v.state.completedAt) return v;
    if (v.question?.status === 'open')
      await action(e, runId, 'audio-unavailable');
    else await action(e, runId, 'continue');
  }
  assert.fail('Bounded run never completed');
}
test('R5-E008 separate +24h/+7d schedules and visits persist exact completion, shared seed and duplicate identities', () =>
  fixture(async (e) => {
    const a = await approved(e),
      practice = await legacy.storyPractice(
        e.child,
        'c',
        manifest.collectionVersion,
      ),
      initial = practice.items[0],
      start = await legacy.startStory(e.child, a.assignmentId, {
        requestId: 'start-initial',
        scheduleId: initial.scheduleId,
      });
    const finished = await completeWithoutSound(e, start.runId),
      slots = (
        await legacy.storyPractice(e.child, 'c', manifest.collectionVersion)
      ).items;
    assert.deepEqual(
      slots.map((x) => x.kind),
      ['review-24h', 'review-7d'],
    );
    assert.equal(
      Date.parse(slots[0].dueAt),
      Date.parse(finished.state.completedAt) + 86400000,
    );
    assert.equal(
      Date.parse(slots[1].dueAt),
      Date.parse(finished.state.completedAt) + 604800000,
    );
    await assert.rejects(
      legacy.startStory(e.child, a.assignmentId, {
        requestId: 'early',
        scheduleId: slots[0].scheduleId,
      }),
      (x) => x.code === 'REVIEW_NOT_DUE',
    );
    e.config.curriculumTestNow = String(Date.parse(slots[0].dueAt));
    const review = await legacy.startStory(e.child, a.assignmentId, {
      requestId: 'review-24h',
      scheduleId: slots[0].scheduleId,
    });
    assert.equal(
      (await legacy.getStoryRun(e.child, review.runId)).state.phase,
      'review-24h',
    );
    await completeWithoutSound(e, review.runId);
    e.config.curriculumTestNow = String(Date.parse(slots[1].dueAt));
    const later = await legacy.startStory(e.child, a.assignmentId, {
      requestId: 'review-7d',
      scheduleId: slots[1].scheduleId,
    });
    await completeWithoutSound(e, later.runId);
    assert.deepEqual(
      await legacy.startStory(e.child, a.assignmentId, {
        requestId: 'start-initial',
        scheduleId: initial.scheduleId,
      }),
      start,
    );
    const rows = (
      await e.client.execute(
        'SELECT seed,phase FROM pilot_collection_run ORDER BY created_at',
      )
    ).rows;
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((x) => x.seed)).size, 1);
    assert.equal(
      (
        await e.client.execute(
          'SELECT count(*) n FROM pilot_collection_schedule',
        )
      ).rows[0].n,
      3,
    );
    assert.equal(
      (await legacy.getStoryRun(e.child, start.runId)).state.completedAt,
      finished.state.completedAt,
    );
  }));
test('R5-E006/007 same-visible late audio failure removes credit preserving first facts; old occurrence and exact duplicate cannot mutate next', () =>
  fixture(async (e) => {
    const a = await approved(e),
      s = (await legacy.storyPractice(e.child, 'c', manifest.collectionVersion))
        .items[0],
      start = await legacy.startStory(e.child, a.assignmentId, {
        requestId: 'start-late',
        scheduleId: s.scheduleId,
      });
    await action(e, start.runId, 'continue');
    const v = await legacy.getStoryRun(e.child, start.runId),
      correct = v.question.choices.find((x) => x.hanzi === '木');
    assert(correct);
    const answer = {
        eventId: 'first-answer',
        expectedRevision: v.revision,
        occurrenceId: v.question.occurrenceId,
        type: 'answer',
        payload: { choiceId: correct.choiceId },
      },
      saved = await legacy.advanceStory(e.child, start.runId, answer);
    assert.equal(
      (await legacy.getStoryRun(e.child, start.runId)).recap.familiarity
        .independent,
      1,
    );
    await action(e, start.runId, 'audio-unavailable');
    const failed = await legacy.getStoryRun(e.child, start.runId);
    assert.equal(failed.recap.familiarity.independent, 0);
    assert.equal(failed.recap.familiarity.firstResponses, 1);
    assert.equal(failed.recap.familiarity.unavailable, 1);
    await action(e, start.runId, 'continue');
    const next = await legacy.getStoryRun(e.child, start.runId);
    await assert.rejects(
      legacy.advanceStory(e.child, start.runId, {
        eventId: 'late-old',
        expectedRevision: next.revision,
        occurrenceId: v.question.occurrenceId,
        type: 'audio-unavailable',
        payload: {},
      }),
      (x) => x.status === 409,
    );
    const replay = await legacy.advanceStory(e.child, start.runId, answer);
    assert.deepEqual(replay.ack, saved.ack);
    assert.equal(replay.replayed, true);
    assert.equal(
      (await legacy.getStoryRun(e.child, start.runId)).revision,
      next.revision,
    );
    assert.equal(
      (await legacy.getStoryRun(e.child, start.runId)).lesson.playback.cues
        .length,
      1,
    );
  }));
test('R5-E005 held approval source change is a conflict with no partial plan, not a storage outage', () =>
  fixture(async (e) => {
    const p = (
      await legacy.proposeStory(e.parent, 'c', {
        collectionVersion: manifest.collectionVersion,
        lessonVersion: null,
        predecessorProposalId: null,
        expectedSourceDigest: null,
      })
    ).proposal;
    const base = e.parent.db,
      held = Object.create(base);
    held.batch = async (statements) => {
      await e.client.execute(
        "UPDATE pilot_onboarding SET experience='new',updated_at=1 WHERE child_id='c'",
      );
      return base.batch(statements);
    };
    await assert.rejects(
      legacy.approveStory({ ...e.parent, db: held }, 'c', {
        proposalId: p.proposalId,
        sourceDigest: p.sourceDigest,
      }),
      (x) => x.status === 409,
    );
    assert.equal(
      (await e.client.execute('SELECT count(*) n FROM pilot_collection_plan'))
        .rows[0].n,
      0,
    );
    assert.equal(
      (
        await e.client.execute(
          'SELECT count(*) n FROM pilot_collection_assignment',
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await e.client.execute(
          'SELECT count(*) n FROM pilot_collection_schedule',
        )
      ).rows[0].n,
      0,
    );
  }));
test('R5-E009 newer approved incomplete lesson preserves older due review and Continue primary', () =>
  fixture(async (e) => {
    const a = await approved(e),
      initial = (
        await legacy.storyPractice(e.child, 'c', manifest.collectionVersion)
      ).items[0],
      start = await legacy.startStory(e.child, a.assignmentId, {
        requestId: 'priority-a',
        scheduleId: initial.scheduleId,
      });
    const finished = await completeWithoutSound(e, start.runId);
    e.config.curriculumTestNow = String(
      Date.parse(finished.state.completedAt) + 86400000,
    );
    const p = await legacy.proposeStory(e.parent, 'c', {
      collectionVersion: manifest.collectionVersion,
      lessonVersion: 'path-02-v1',
      predecessorProposalId: a.proposal.proposalId,
      expectedSourceDigest: a.proposal.sourceDigest,
    });
    const plan = await legacy.approveStory(e.parent, 'c', {
      proposalId: p.proposal.proposalId,
      sourceDigest: p.proposal.sourceDigest,
    });
    let home = await legacy.storyPractice(
      e.child,
      'c',
      manifest.collectionVersion,
    );
    const next = home.items.find(
      (x) => x.assignmentId === plan.plan.items[0].assignmentId,
    );
    const b = await legacy.startStory(e.child, next.assignmentId, {
      requestId: 'priority-b',
      scheduleId: next.scheduleId,
    });
    home = await legacy.storyPractice(e.child, 'c', manifest.collectionVersion);
    assert.equal(home.primary.kind, 'continue');
    assert.equal(home.primary.runId, b.runId);
    assert(
      home.items.some(
        (x) =>
          x.assignmentId === a.assignmentId &&
          x.kind === 'review-24h' &&
          x.available,
      ),
    );
  }));
test('R5-E011 teacher current parent role and foreign child restrictions are rechecked', () =>
  fixture(async (e) => {
    const a = await approved(e);
    await e.client.execute(
      "INSERT INTO pilot_teacher_grant(child_id,teacher_id,granting_parent_id,created_at) VALUES('c','t','p',0)",
    );
    assert.equal(
      (await legacy.storyPlans(e.context('t'), 'c', manifest.collectionVersion))
        .history.length,
      1,
    );
    await assert.rejects(
      legacy.storyPlans(e.context('p2'), 'c', manifest.collectionVersion),
      (x) => x.status === 404,
    );
    await e.client.execute(
      "UPDATE pilot_auth_user SET role='teacher' WHERE id='p'",
    );
    await assert.rejects(
      legacy.storyPlans(e.context('t'), 'c', manifest.collectionVersion),
      (x) => x.status === 404,
    );
    assert.equal(a.plan.items.length, 1);
  }));
test('R5-E005 final audit SQL constraint rolls back all approval facts', () =>
  fixture(async (e) => {
    const p = (
      await legacy.proposeStory(e.parent, 'c', {
        collectionVersion: manifest.collectionVersion,
        lessonVersion: null,
        predecessorProposalId: null,
        expectedSourceDigest: null,
      })
    ).proposal;
    await e.client.execute(
      "CREATE TRIGGER owned_r5_final_constraint BEFORE INSERT ON pilot_collection_learning_audit BEGIN SELECT RAISE(ABORT,'OWNED_SYNTHETIC_FINAL'); END",
    );
    await assert.rejects(
      legacy.approveStory(e.parent, 'c', {
        proposalId: p.proposalId,
        sourceDigest: p.sourceDigest,
      }),
      (x) => x.status === 503,
    );
    for (const table of [
      'plan',
      'plan_item',
      'assignment',
      'schedule',
      'learning_audit',
    ])
      assert.equal(
        (
          await e.client.execute(
            'SELECT count(*) n FROM pilot_collection_' + table,
          )
        ).rows[0].n,
        0,
      );
  }));

test('R5-E001/002 closed bootstrap reuses normal registry validation and creates only scoped verification authority', () =>
  fixture(
    async (e) => {
      const packages = e.manifest.items.map((x) =>
        JSON.parse(
          fs.readFileSync(
            new URL(
              '../content/curriculum/collection/' + x.lessonVersion + '.json',
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      );
      const first = await collection.bootstrapCollection(
        e.operator,
        e.manifest,
        packages,
      );
      assert.equal(first.publications.length, 10);
      assert.deepEqual(
        await collection.bootstrapCollection(e.operator, e.manifest, packages),
        first,
      );
      assert.equal(
        (
          await e.client.execute(
            'SELECT count(*) n FROM pilot_curriculum_character',
          )
        ).rows[0].n,
        20,
      );
      assert.equal(
        (
          await e.client.execute(
            'SELECT count(*) n FROM pilot_curriculum_publication',
          )
        ).rows[0].n,
        10,
      );
      assert.equal(
        (
          await e.client.execute(
            "SELECT count(*) n FROM pilot_curriculum_publication WHERE scope_kind='verification' AND review_id IS NULL AND proof_id IS NULL AND owner_decision_id IS NULL AND test_run_id='r5-unit'",
          )
        ).rows[0].n,
        10,
      );
      e.config.collectionCapability = null;
      await assert.rejects(
        collection.bootstrapCollection(e.operator, e.manifest, packages),
        (x) => x.status === 404,
      );
      assert.equal(
        (await legacy.storyLibrary(e.parent, 'c', manifest.collectionVersion))
          .items.length,
        0,
      );
    },
    { seedAuthority: false, registerCollection: false },
  ));

test('R5 populated production-bootstrap fixture reaches every new table and all three schedule visits', async () => {
  const { withCollectionFixture, populateCollectionVisits } =
    await import('./helpers/collection-store-fixture.mjs');
  await withCollectionFixture(async (e) => {
    const facts = await populateCollectionVisits(e);
    assert.equal(facts.runIds.length, 3);
    for (const table of [
      'pilot_collection',
      'pilot_collection_item',
      'pilot_collection_proposal',
      'pilot_collection_plan',
      'pilot_collection_plan_item',
      'pilot_collection_assignment',
      'pilot_collection_schedule',
      'pilot_collection_run',
      'pilot_collection_event',
      'pilot_collection_learning_audit',
    ])
      assert(
        (await e.client.execute('SELECT count(*) n FROM ' + table)).rows[0].n >
          0,
        table,
      );
  });
});
