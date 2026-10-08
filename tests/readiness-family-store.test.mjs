import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { createLibsqlD1Database } from '../lib/platform/libsql-d1.ts';
import * as schema from '../db/pilot-schema.ts';
import * as store from '../lib/pilot/story-store.ts';
import { curriculumDigest } from '../lib/curriculum/digest.ts';
const manifest = JSON.parse(
  fs.readFileSync(
    new URL('../content/curriculum/forest-01-v4.json', import.meta.url),
    'utf8',
  ),
);
const clock = Date.parse('2026-09-27T00:00:00Z');
async function database(callback, { movingClock = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-store-unit-')),
    client = createClient({ url: `file:${path.join(dir, 'fresh.db')}` });
  try {
    for (const sql of [
      schema.PILOT_AUTH_MIGRATION_SQL,
      schema.PILOT_DATA_MIGRATION_SQL,
      schema.PILOT_LEARNING_MIGRATION_SQL,
      schema.PILOT_CURRICULUM_MIGRATION_SQL,
      schema.PILOT_CURRICULUM_RUNTIME_MIGRATION_SQL,
      schema.PILOT_FAMILY_STORY_MIGRATION_SQL,
    ])
      await client.executeMultiple(sql);
    const people = [
      ['op', 'operator'],
      ['p', 'parent'],
      ['c', 'child'],
      ['p2', 'parent'],
      ['c2', 'child'],
      ['t', 'teacher'],
    ];
    for (const [id, role] of people) {
      await client.execute({
        sql: 'INSERT INTO pilot_auth_user(id,name,email,email_verified,created_at,updated_at,username,display_username,role,must_change_password,disabled) VALUES(?,?,?,0,0,0,?,?,?,0,0)',
        args: [id, id, `${id}@example.test`, id, id, role],
      });
      await client.execute({
        sql: 'INSERT INTO pilot_auth_session(id,expires_at,token,created_at,updated_at,user_id) VALUES(?,?,?,?,?,?)',
        args: [
          `s-${id}`,
          clock + 864000000,
          `private-unit-token-${id}`,
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
      "UPDATE pilot_installation SET installation_id='install',created_at=0 WHERE id=1",
    );
    const db = createLibsqlD1Database(client),
      content = await curriculumDigest(manifest),
      trust = {
        candidateId: 'candidate',
        sourceDigest: content,
        artifactDigest: content,
        buildId: 'build',
        issuers: [],
        archiveIssuers: [],
      },
      config = {
        pilotMode: true,
        testMode: true,
        testContentAllowed: true,
        testRunId: 'r3-unit',
        testToken: 'private-unit',
        candidateId: 'candidate',
        candidateExplicitlyBound: true,
        curriculumTestNow: String(clock),
        curriculumTrust: trust,
        storyCapability: {
          installationId: 'install',
          contentDigest: content,
          namespace: 'r3-unit',
          childIds: ['c'],
          parentIds: ['p'],
        },
      };
    if (movingClock) {
      let tick = clock;
      Object.defineProperty(config, 'curriculumTestNow', {
        get: () => String(tick++),
      });
    }
    const context = (id) => ({
      config,
      db,
      user: {
        id,
        name: id,
        role: people.find((p) => p[0] === id)[1],
        disabled: false,
        mustChangePassword: false,
      },
      session: { id: `s-${id}` },
    });
    const op = context('op'),
      parent = context('p'),
      child = context('c');
    await store.bootstrapStory(op, { fixture: 'family-story' }, manifest);
    await client.execute({
      sql: 'INSERT INTO pilot_onboarding VALUES(?,?,?,?,?,?)',
      args: ['c', 'Learner', 'some', 1, clock, 'p'],
    });
    await callback({ client, context, op, parent, child, config, manifest });
  } finally {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
async function approved(env) {
  const proposed = await store.proposeStory(env.parent, 'c', {
    lessonVersion: 'forest-01-v4',
  });
  const approved = await store.approveStory(env.parent, 'c', {
    proposalId: proposed.proposal.proposalId,
    sourceDigest: proposed.proposal.sourceDigest,
  });
  return {
    proposal: proposed.proposal,
    plan: approved.plan,
    assignmentId: approved.plan.items[0].assignmentId,
  };
}
async function opened(env) {
  const a = await approved(env),
    ack = await store.startStory(env.child, a.assignmentId, {
      requestId: 'start-1',
    });
  return { ...a, runId: ack.runId };
}
test('R3 moving clock publication and audit share one operation timestamp', () =>
  database(
    async (e) => {
      const rows = (
        await e.client.execute(
          'SELECT p.created_at AS fact,a.created_at AS audit FROM pilot_curriculum_publication p JOIN pilot_curriculum_publication_audit a ON a.publication_id=p.id',
        )
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].fact, rows[0].audit);
    },
    { movingClock: true },
  ));
test('R3 moving clock bootstrap import and audit share one operation timestamp', () =>
  database(
    async (e) => {
      const rows = (
        await e.client.execute(
          "SELECT p.imported_at AS fact,a.created_at AS audit FROM pilot_curriculum_package p JOIN pilot_curriculum_audit a ON a.lesson_version=p.lesson_version WHERE a.action='import'",
        )
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].fact, rows[0].audit);
    },
    { movingClock: true },
  ));
test('R3 moving clock plan, start and action write groups retain matching timestamps', () =>
  database(
    async (e) => {
      const r = await opened(e);
      await store.advanceStory(e.child, r.runId, {
        eventId: 'moving-event',
        expectedRevision: 0,
        stepId: 'welcome',
        type: 'continue',
        payload: {},
      });
      const plan = (
        await e.client.execute(
          "SELECT p.approved_at AS fact,a.created_at AS assignment,s.created_at AS schedule,s.due_at AS due,u.created_at AS audit FROM pilot_learning_plan p JOIN pilot_learning_plan_item i ON i.plan_id=p.id JOIN pilot_curriculum_assignment a ON a.plan_item_id=i.id JOIN pilot_learning_schedule s ON s.assignment_id=a.id AND s.kind='initial' JOIN pilot_curriculum_learning_audit u ON u.plan_id=p.id",
        )
      ).rows;
      assert.equal(plan.length, 1);
      for (const key of ['assignment', 'schedule', 'due', 'audit'])
        assert.equal(plan[0][key], plan[0].fact);
      const start = (
        await e.client.execute(
          "SELECT r.created_at AS fact,u.created_at AS audit FROM pilot_curriculum_learning_run r JOIN pilot_curriculum_learning_audit u ON u.run_id=r.id AND u.action='run-start'",
        )
      ).rows;
      assert.equal(start.length, 1);
      assert.equal(start[0].fact, start[0].audit);
      const action = (
        await e.client.execute(
          'SELECT e.server_at AS fact,u.created_at AS audit,r.updated_at AS updated FROM pilot_curriculum_learning_event e JOIN pilot_curriculum_learning_audit u ON u.event_id=e.id JOIN pilot_curriculum_learning_run r ON r.id=e.run_id',
        )
      ).rows;
      assert.equal(action.length, 1);
      assert.equal(action[0].fact, action[0].audit);
      assert.equal(action[0].fact, action[0].updated);
      await store.getStoryRun(e.child, r.runId);
    },
    { movingClock: true },
  ));
test('R3 fresh0005 schema and synthetic ordinary plan/start replay enforce ownership', () =>
  database(async (e) => {
    const a = await approved(e);
    const again = await store.approveStory(e.parent, 'c', {
      proposalId: a.proposal.proposalId,
      sourceDigest: a.proposal.sourceDigest,
    });
    assert.equal(again.plan.planId, a.plan.planId);
    assert.equal(
      (await e.client.execute('SELECT * FROM pilot_curriculum_assignment')).rows
        .length,
      1,
    );
    const r = await store.startStory(e.child, a.assignmentId, {
      requestId: 'start-1',
    });
    assert.deepEqual(
      await store.startStory(e.child, a.assignmentId, { requestId: 'start-1' }),
      r,
    );
    assert.equal(
      (
        await store.startStory(e.child, a.assignmentId, {
          requestId: 'start-later',
        })
      ).runId,
      r.runId,
    );
    await assert.rejects(
      () => store.startStory(e.parent, a.assignmentId, { requestId: 'bad' }),
      { code: 'FORBIDDEN' },
    );
    await assert.rejects(() => store.getStoryRun(e.context('c2'), r.runId), {
      code: 'NOT_FOUND',
    });
    const view = await store.getStoryRun(e.child, r.runId);
    assert.equal(view.state.soundReview, 'synthetic');
    assert.equal(JSON.stringify(view).includes('correctChoiceId'), false);
    assert.equal(view.available, true);
    assert.deepEqual(
      (await e.client.execute('PRAGMA foreign_key_check')).rows,
      [],
    );
  }));
test('R3 action lost response and two-tab stale identity preserve exactly one event', () =>
  database(async (e) => {
    const r = await opened(e);
    const action = {
      eventId: 'event-1',
      expectedRevision: 0,
      stepId: 'welcome',
      type: 'continue',
      payload: {},
    };
    const ack = await store.advanceStory(e.child, r.runId, action);
    assert.equal(
      (await store.advanceStory(e.child, r.runId, action)).replayed,
      true,
    );
    assert.deepEqual(
      (await store.advanceStory(e.child, r.runId, action)).ack,
      ack.ack,
    );
    await assert.rejects(
      () =>
        store.advanceStory(e.child, r.runId, { ...action, eventId: 'event-2' }),
      { code: 'STALE_REVISION' },
    );
    await assert.rejects(
      () =>
        store.advanceStory(e.child, r.runId, {
          ...action,
          payload: { changed: true },
        }),
      { code: 'EVENT_CONFLICT' },
    );
    assert.equal(
      (await e.client.execute('SELECT * FROM pilot_curriculum_learning_event'))
        .rows.length,
      1,
    );
    assert.equal((await store.getStoryRun(e.parent, r.runId)).revision, 1);
  }));
test('R3 final audit failure rolls back plan and run event projection', () =>
  database(async (e) => {
    const p = await store.proposeStory(e.parent, 'c', {
      lessonVersion: 'forest-01-v4',
    });
    await e.client.execute(
      "CREATE TRIGGER unit_fail_final BEFORE INSERT ON pilot_curriculum_learning_audit BEGIN SELECT RAISE(ABORT,'unit-final-fault');END",
    );
    await assert.rejects(
      () =>
        store.approveStory(e.parent, 'c', {
          proposalId: p.proposal.proposalId,
          sourceDigest: p.proposal.sourceDigest,
        }),
      { code: 'STORAGE_UNAVAILABLE' },
    );
    for (const table of [
      'pilot_learning_plan',
      'pilot_learning_plan_item',
      'pilot_curriculum_assignment',
      'pilot_learning_schedule',
      'pilot_curriculum_learning_audit',
    ])
      assert.equal(
        (await e.client.execute(`SELECT * FROM ${table}`)).rows.length,
        0,
      );
    await e.client.execute('DROP TRIGGER unit_fail_final');
    const r = await opened(e);
    await e.client.execute(
      "CREATE TRIGGER unit_fail_final BEFORE INSERT ON pilot_curriculum_learning_audit WHEN NEW.action='run-action' BEGIN SELECT RAISE(ABORT,'unit-final-fault');END",
    );
    await assert.rejects(
      () =>
        store.advanceStory(e.child, r.runId, {
          eventId: 'e-1',
          expectedRevision: 0,
          stepId: 'welcome',
          type: 'continue',
          payload: {},
        }),
      { code: 'STORAGE_UNAVAILABLE' },
    );
    assert.equal((await store.getStoryRun(e.child, r.runId)).revision, 0);
    assert.equal(
      (await e.client.execute('SELECT * FROM pilot_curriculum_learning_event'))
        .rows.length,
      0,
    );
  }));
test('R3 withdrawal stops writes but keeps historic evidence and exact ack replay', () =>
  database(async (e) => {
    const r = await opened(e);
    const body = {
      eventId: 'e-1',
      expectedRevision: 0,
      stepId: 'welcome',
      type: 'continue',
      payload: {},
    };
    await store.advanceStory(e.child, r.runId, body);
    const pub = (
        await e.client.execute('SELECT * FROM pilot_curriculum_publication')
      ).rows[0],
      envelope = JSON.parse(pub.request_json),
      input = {
        ...envelope.request,
        requestId: 'withdraw',
        expectedRevision: 1,
        predecessorId: pub.id,
        status: 'withdrawn',
      };
    await store.publishStory(e.op, 'forest-01-v4', input);
    const history = await store.getStoryRun(e.parent, r.runId);
    assert.equal(history.available, false);
    assert.equal(history.revision, 1);
    assert.equal(
      (await store.advanceStory(e.child, r.runId, body)).replayed,
      true,
    );
    await assert.rejects(
      () =>
        store.advanceStory(e.child, r.runId, {
          eventId: 'e-2',
          expectedRevision: 1,
          stepId: 'familiarity',
          type: 'audio-unavailable',
          payload: { questionId: 'fam-mu' },
        }),
      { code: 'LESSON_UNAVAILABLE' },
    );
  }));
test('R3 revoked parent membership makes child history unavailable before answer', () =>
  database(async (e) => {
    const r = await opened(e);
    await e.client.execute(
      "DELETE FROM pilot_parent_child WHERE parent_id='p' AND child_id='c'",
    );
    const view = await store.getStoryRun(e.child, r.runId);
    assert.equal(view.available, false);
  }));
test('R3-E014 full story late audio failure and exact24hour delayed schedule survive persisted replay', () =>
  database(async (e) => {
    const r = await opened(e);
    let serial = 0;
    async function act(type, payload = {}) {
      const v = await store.getStoryRun(e.child, r.runId);
      return store.advanceStory(e.child, r.runId, {
        eventId: `route-${serial++}`,
        expectedRevision: v.revision,
        stepId: v.state.stepId,
        type,
        payload,
      });
    }
    await act('continue');
    await act('answer', { questionId: 'fam-mu', choiceId: 'mu' });
    await act('audio-unavailable', { questionId: 'fam-mu' });
    await act('continue');
    await act('answer', { questionId: 'fam-lin', choiceId: 'lin' });
    await act('continue');
    assert.equal(
      (await store.getStoryRun(e.child, r.runId)).state.introPlan.mode,
      'mixed',
    );
    await act('continue');
    await act('continue');
    await act('place-component', { componentId: 'mu-a', slot: 'left' });
    await act('place-component', { componentId: 'mu-b', slot: 'right' });
    await act('continue');
    await act('answer', { questionId: 'find-mu', choiceId: 'mu' });
    await act('continue');
    await act('answer', { questionId: 'find-lin', choiceId: 'lin' });
    await act('continue');
    await act('continue');
    await act('continue');
    for (const [questionId, choiceId] of [
      ['check-mu-sound', 'mu'],
      ['check-lin-sound', 'lin'],
      ['check-mu-reading', 'audio-mu'],
      ['check-lin-reading', 'audio-lin'],
    ]) {
      await act('answer', { questionId, choiceId });
      await act('continue');
    }
    const v = await store.getStoryRun(e.parent, r.runId);
    assert.equal(v.recap.familiarity.unavailable, 1);
    assert.equal(v.recap.immediate.independent, 4);
    const schedules = (
      await e.client.execute(
        "SELECT * FROM pilot_learning_schedule WHERE kind='delayed-review'",
      )
    ).rows;
    assert.equal(schedules.length, 1);
    assert.equal(Number(schedules[0].due_at), clock + 86400000);
    e.config.curriculumTestNow = String(clock + 86400000 - 1);
    await assert.rejects(() => act('start-review'), { code: 'REVIEW_NOT_DUE' });
    e.config.curriculumTestNow = String(clock + 86400000);
    await act('start-review');
    for (const [questionId, choiceId] of [
      ['review-mu-sound', 'mu'],
      ['review-lin-sound', 'lin'],
    ]) {
      await act('answer', { questionId, choiceId });
      await act('continue');
    }
    assert.equal(
      (await store.getStoryRun(e.parent, r.runId)).recap.delayed.independent,
      2,
    );
    assert.equal(
      (
        await e.client.execute(
          "SELECT * FROM pilot_learning_schedule WHERE kind='delayed-review'",
        )
      ).rows.length,
      1,
    );
  }));
test('R3-E011 supervising parent role changed after preflight cannot commit child start', () =>
  database(async (e) => {
    const a = await approved(e),
      original = e.child.db.batch.bind(e.child.db);
    let changed = false;
    e.child.db.batch = async (statements) => {
      if (!changed) {
        changed = true;
        await e.client.execute(
          "UPDATE pilot_auth_user SET role='teacher' WHERE id='p'",
        );
      }
      return original(statements);
    };
    await assert.rejects(
      () =>
        store.startStory(e.child, a.assignmentId, { requestId: 'role-race' }),
      { code: 'LESSON_UNAVAILABLE' },
    );
    assert.equal(
      (await e.client.execute('SELECT * FROM pilot_curriculum_learning_run'))
        .rows.length,
      0,
    );
    assert.equal(
      (
        await e.client.execute(
          "SELECT * FROM pilot_curriculum_learning_audit WHERE action='run-start'",
        )
      ).rows.length,
      0,
    );
  }));
test('R3-E007 publication replay returns original ack with missing current trust; malformed refs400', () =>
  database(async (e) => {
    const pub = (
        await e.client.execute('SELECT * FROM pilot_curriculum_publication')
      ).rows[0],
      request = JSON.parse(pub.request_json).request,
      ack = JSON.parse(pub.ack_json);
    e.config.curriculumTrust = null;
    assert.deepEqual(
      await store.publishStory(e.op, 'forest-01-v4', request),
      ack,
    );
    await assert.rejects(
      () =>
        store.publishStory(e.op, 'forest-01-v4', {
          ...request,
          requestId: 'bad-ref',
          expectedRevision: 1,
          predecessorId: pub.id,
          status: 'withdrawn',
          reviewId: { id: 'object' },
        }),
      { code: 'INVALID_REQUEST', status: 400 },
    );
    const next = await store.publishStory(e.op, 'forest-01-v4', {
      ...request,
      requestId: 'negative-no-trust',
      expectedRevision: 1,
      predecessorId: pub.id,
      status: 'withdrawn',
    });
    assert.equal(next.status, 'withdrawn');
    assert.deepEqual(
      await store.publishStory(e.op, 'forest-01-v4', request),
      ack,
    );
  }));
test('R3 stale proposal setup changes and expired snapshot are not approved', () =>
  database(async (e) => {
    const p = await store.proposeStory(e.parent, 'c', {
      lessonVersion: 'forest-01-v4',
    });
    await e.client.execute(
      "UPDATE pilot_onboarding SET nickname='Changed',updated_at=updated_at+1 WHERE child_id='c'",
    );
    await assert.rejects(
      () =>
        store.approveStory(e.parent, 'c', {
          proposalId: p.proposal.proposalId,
          sourceDigest: p.proposal.sourceDigest,
        }),
      { code: 'PLACEMENT_STALE' },
    );
    const fresh = await store.proposeStory(e.parent, 'c', {
      lessonVersion: 'forest-01-v4',
    });
    e.config.curriculumTestNow = String(clock + 86400000);
    await assert.rejects(
      () =>
        store.approveStory(e.parent, 'c', {
          proposalId: fresh.proposal.proposalId,
          sourceDigest: fresh.proposal.sourceDigest,
        }),
      { code: 'PLACEMENT_STALE' },
    );
    const renewed = await store.proposeStory(e.parent, 'c', {
      lessonVersion: 'forest-01-v4',
    });
    assert.notEqual(renewed.proposal.proposalId, fresh.proposal.proposalId);
    assert.equal(
      (
        await store.approveStory(e.parent, 'c', {
          proposalId: renewed.proposal.proposalId,
          sourceDigest: renewed.proposal.sourceDigest,
        })
      ).plan.available,
      true,
    );
  }));
