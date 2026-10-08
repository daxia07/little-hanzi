import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import {
  validateCorpusRuntimeControl as valid,
  corpusRuntimeActors,
  corpusRuntimeUsername,
  corpusAppOrigin,
  corpusControlSessionExpiry,
  corpusHandoffLocation,
  stopCorpusRuntimeChild,
  corpusRuntimeFailure,
} from '../scripts/readiness-corpus-runtime-controls.mjs';
test('fixed synthetic login names satisfy unchanged auth policy without changing actor IDs', () => {
  const actors = corpusRuntimeActors().roles;
  const usernames = actors.map(([id]) => corpusRuntimeUsername(id));
  assert.equal(new Set(usernames).size, 24);
  for (const username of usernames) {
    assert.match(username, /^[a-zA-Z0-9_.]+$/);
    assert.ok(username.length >= 3 && username.length <= 30);
  }
  assert.equal(corpusRuntimeUsername('r6-operator'), 'r6_operator');
  assert.throws(() => corpusRuntimeUsername('foreign'));
  assert.equal(actors[0][0], 'r6-operator');
});
test('known CAS refusals are409 and only the actual SQLite terminal trigger has its dedicated code', () => {
  assert.deepEqual(corpusRuntimeFailure(new Error('PUBLICATION_STALE')), {
    status: 409,
    code: 'PUBLICATION_STALE',
  });
  assert.deepEqual(corpusRuntimeFailure(new Error('SNAPSHOT_STALE')), {
    status: 409,
    code: 'SNAPSHOT_STALE',
  });
  const actual = new Error(
    'SQLITE_CONSTRAINT_TRIGGER: R6_RUNNER_FINAL_CONSTRAINT',
  );
  actual.code = 'SQLITE_CONSTRAINT_TRIGGER';
  assert.deepEqual(corpusRuntimeFailure(actual), {
    status: 503,
    code: 'CORPUS_TERMINAL_CONSTRAINT',
  });
  assert.deepEqual(
    corpusRuntimeFailure(new Error('R6_RUNNER_FINAL_CONSTRAINT')),
    { status: 400, code: 'CORPUS_CONTROL_REJECTED' },
  );
});
test('ordinary authentication uses its actual URL while evidence retains proxy origin', () => {
  assert.equal(
    corpusAppOrigin(
      { origin: 'http://synthetic.invalid' },
      'http://127.0.0.1:1234',
      true,
    ),
    'http://127.0.0.1:1234',
  );
  assert.equal(
    corpusAppOrigin(
      { origin: 'http://127.0.0.1:4567' },
      'http://127.0.0.1:1234',
      false,
    ),
    'http://127.0.0.1:4567',
  );
});
test('fixed built control sessions survive seven days without renewal and expire at fourteen', () => {
  const initial = 1790000000000,
    day = 86400000;
  assert.ok(corpusControlSessionExpiry(initial, true) > initial + 7 * day);
  assert.equal(corpusControlSessionExpiry(initial, true), initial + 14 * day);
  assert.equal(corpusControlSessionExpiry(initial, false), initial + day);
});
test('credential handoff belongs to private work, not report output', () => {
  assert.equal(
    corpusHandoffLocation('/private/owned-work', '/public/report-output'),
    '/private/owned-work/handoff.json',
  );
});
test('shutdown refuses unobserved exit after escalation and observes an actual owned child exit', async () => {
  const unresolved = new EventEmitter();
  unresolved.exitCode = null;
  unresolved.signalCode = null;
  const signals = [];
  unresolved.kill = (signal) => signals.push(signal);
  await assert.rejects(
    stopCorpusRuntimeChild(unresolved, { termMs: 5, killMs: 5 }),
    /PROCESS_EXIT_UNCONFIRMED/,
  );
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(unresolved.listenerCount('exit'), 0);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
  });
  try {
    await stopCorpusRuntimeChild(child, { termMs: 1000, killMs: 1000 });
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  }
});
test('shared credentials cannot use the direct author handle as a built credential-copy authority', async () => {
  const { withOwnedCorpusFixture, shareBuiltCorpusCredentials } =
    await import('../scripts/readiness-corpus-bootstrap.mjs');
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    await assert.rejects(
      shareBuiltCorpusCredentials(f.handle, f.handle),
      /CORPUS_BUILT_HANDLE_REQUIRED/,
    );
  });
});
test('two real held publication batches admit one and normalize the changed-head loser', async () => {
  const {
    withOwnedCorpusFixture,
    bootstrapOwnedCorpus,
    prepareOwnedCorpus,
    publishOwnedCorpus,
  } = await import('../scripts/readiness-corpus-bootstrap.mjs');
  let armed = false,
    waiting = 0,
    release;
  const gate = new Promise((r) => {
    release = r;
  });
  await withOwnedCorpusFixture(
    'draft-corpus',
    async (f) => {
      const head = await bootstrapOwnedCorpus(f.handle),
        a = await prepareOwnedCorpus(f.handle),
        b = await prepareOwnedCorpus(f.handle);
      armed = true;
      const results = await Promise.allSettled(
        [a, b].map((prep, i) =>
          publishOwnedCorpus(f.handle, {
            requestId: 'held-concurrent-' + i,
            snapshotId: prep.snapshotId,
            expectedRevision: head.revision,
            predecessorPublicationId: head.recordId,
          }),
        ),
      );
      assert.equal(waiting, 2);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const loser = results.find((r) => r.status === 'rejected');
      assert.equal(loser.reason.message, 'PUBLICATION_STALE');
      assert.equal(
        (
          await f.client.execute(
            'SELECT count(*) n FROM pilot_corpus_publication',
          )
        ).rows[0].n,
        2,
      );
    },
    {
      instrumentClient(client) {
        const original = client.batch.bind(client);
        client.batch = async (statements, ...args) => {
          if (
            armed &&
            statements.some((x) =>
              (typeof x === 'string' ? x : x.sql).includes(
                'INSERT INTO pilot_corpus_publication(',
              ),
            )
          ) {
            waiting++;
            if (waiting === 2) release();
            await gate;
          }
          return original(statements, ...args);
        };
      },
    },
  );
});
test('runner permits only closed fault stages/modes and refuses caller SQL/config', () => {
  assert.equal(
    valid('/fault', { stage: 'action', mode: 'final-constraint' }),
    true,
  );
  for (const b of [
    { stage: 'action', mode: 'fake-success' },
    { stage: 'anything', mode: 'none' },
    { stage: 'action', mode: 'none', sql: 'DROP TABLE x' },
  ])
    assert.throws(() => valid('/fault', b));
});
test('clock and restore reject unsafe/future values before effects', () => {
  assert.equal(valid('/clock', { at: 1790000000000 }), true);
  for (const at of [NaN, Infinity, -1, 1.5])
    assert.throws(() => valid('/clock', { at }));
  assert.throws(() =>
    valid('/restore', { archiveId: 'owned', variant: 'format7' }),
  );
  assert.throws(() =>
    valid('/verification', { operation: 'release-real', requestId: 'r' }),
  );
});
test('closed inspect supports named resources without path/URL or foreign kind', () => {
  assert.equal(valid('/inspect', { kind: 'run', runId: 'opaque-run' }), true);
  assert.throws(() => valid('/inspect', { kind: 'run', runId: '../secret' }));
  assert.throws(() => valid('/inspect', { kind: 'users' }));
  assert.throws(() => valid('/restart', { url: 'http://foreign' }));
});
test('ten fixed linked families and four extra personas remain exact and disjoint', () => {
  const { families, roles } = corpusRuntimeActors();
  assert.equal(families.length, 10);
  assert.equal(roles.length, 24);
  assert.equal(new Set(roles.map((a) => a[0])).size, 24);
  assert.deepEqual(families[0], {
    index: 1,
    parentId: 'r6-parent-01',
    childId: 'r6-child-01',
  });
  assert.equal(families.at(-1).childId, 'r6-child-10');
});

test('real owned libSQL terminal approval fault rolls back every plan effect and disarms for retry', async () => {
  const { withOwnedCorpusFixture, bootstrapOwnedCorpus } =
    await import('../scripts/readiness-corpus-bootstrap.mjs');
  const { installCorpusRuntimeFault } =
    await import('../scripts/readiness-corpus-runtime-controls.mjs');
  const { saveOnboarding } = await import('../lib/pilot/learning.ts');
  const { proposeCorpus, approveCorpus } =
    await import('../lib/pilot/corpus-family-store.ts');
  let rawBatchError;
  await withOwnedCorpusFixture(
    'draft-corpus',
    async (f) => {
      const release = await bootstrapOwnedCorpus(f.handle),
        item = f.manifest.items[0];
      await saveOnboarding(
        f.db,
        'r6-parent',
        'r6-child',
        {
          nickname: 'Synthetic runner check',
          experience: 'new',
          audioReady: true,
        },
        Date.now(),
      );
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
          predecessorProposalId: null,
          expectedSourceDigest: null,
        },
      );
      const input = {
        proposalId: proposal.proposalId,
        sourceDigest: proposal.sourceDigest,
      };
      await installCorpusRuntimeFault(f.client, {
        stage: 'approval',
        mode: 'final-constraint',
      });
      await assert.rejects(
        approveCorpus(f.context('r6-parent'), 'r6-child', input),
      );
      assert.deepEqual(
        corpusRuntimeFailure(rawBatchError),
        { status: 503, code: 'CORPUS_TERMINAL_CONSTRAINT' },
        JSON.stringify({
          code: rawBatchError?.code,
          message: rawBatchError?.message,
        }),
      );
      for (const table of [
        'pilot_corpus_plan',
        'pilot_corpus_plan_item',
        'pilot_corpus_assignment',
        'pilot_corpus_schedule',
        'pilot_corpus_learning_audit',
      ])
        assert.equal(
          (await f.client.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,
          0,
          table,
        );
      await installCorpusRuntimeFault(f.client, {
        stage: 'approval',
        mode: 'none',
      });
      const { plan } = await approveCorpus(
        f.context('r6-parent'),
        'r6-child',
        input,
      );
      assert.ok(plan.planId);
      assert.equal(
        (await f.client.execute('SELECT count(*) n FROM pilot_corpus_schedule'))
          .rows[0].n,
        1,
      );
    },
    {
      instrumentClient(client) {
        const original = client.batch.bind(client);
        client.batch = async (...args) => {
          try {
            return await original(...args);
          } catch (error) {
            rawBatchError = error;
            throw error;
          }
        };
      },
    },
  );
});
test('accepted response loss recognizes actual ordinary corpus mutation routes', async () => {
  const { corpusMutationStage } =
    await import('../scripts/readiness-corpus-runtime-controls.mjs');
  assert.equal(
    corpusMutationStage('/api/pilot/children/r6-child-01/placement/approve'),
    'approval',
  );
  assert.equal(
    corpusMutationStage('/api/pilot/children/r6-child-01/catalog/proposals'),
    'proposal',
  );
  assert.equal(
    corpusMutationStage('/api/pilot/curriculum/assignments/assignment/start'),
    'start',
  );
  assert.equal(
    corpusMutationStage('/api/pilot/curriculum/learning-runs/run/actions'),
    'action',
  );
});
test('only ordinary-negative counts inspection has a closed target selector', () => {
  assert.equal(
    valid('/inspect', { kind: 'counts', target: 'ordinary-negative' }),
    true,
  );
  for (const body of [
    { kind: 'head', target: 'ordinary-negative' },
    { kind: 'run', runId: 'x', target: 'ordinary-negative' },
    { kind: 'counts', target: 'foreign' },
  ])
    assert.throws(() => valid('/inspect', body));
});
test('publication hold control is a closed stage and operation', () => {
  assert.equal(
    valid('/hold', { stage: 'publication-before-commit', operation: 'arm' }),
    true,
  );
  for (const body of [
    { stage: 'publication-before-commit', operation: 'execute' },
    { stage: 'any-sql', operation: 'arm' },
    { stage: 'publication-before-commit', operation: 'arm', sql: 'SELECT 1' },
  ])
    assert.throws(() => valid('/hold', body));
});
test('two captured publication inputs retain same predecessor and cannot release early or admit a third', async () => {
  const { createCorpusPublicationBarrier } =
    await import('../scripts/readiness-corpus-runtime-controls.mjs');
  const b = createCorpusPublicationBarrier();
  try {
    b.arm();
    const first = b.wait({
      snapshotId: 'snapshot-a',
      expectedRevision: 1,
      predecessorPublicationId: 'head-a',
    });
    assert.throws(() => b.release(), /NOT_READY/);
    const second = b.wait({
      snapshotId: 'snapshot-b',
      expectedRevision: 1,
      predecessorPublicationId: 'head-a',
    });
    assert.equal(b.status().waiting, 2);
    await assert.rejects(b.wait({ snapshotId: 'third' }), /FULL/);
    assert.equal(b.release().released, true);
    assert.deepEqual(await first, {
      snapshotId: 'snapshot-a',
      expectedRevision: 1,
      predecessorPublicationId: 'head-a',
    });
    assert.deepEqual(await second, {
      snapshotId: 'snapshot-b',
      expectedRevision: 1,
      predecessorPublicationId: 'head-a',
    });
    assert.equal(b.status().waiting, 0);
  } finally {
    b.destroy();
  }
});
