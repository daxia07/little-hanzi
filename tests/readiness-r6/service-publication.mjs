/** Real private publication admission and terminal SQL faults, never owner acceptance. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function runPublicationCases(http, execute) {
  await execute('C07-held-same-predecessor-publication', async () => {
    const beforeHead = await http.inspect({ kind: 'head' }),
      before = await http.inspect({ kind: 'counts' });
    const armed = await http.control('/hold', {
      stage: 'publication-before-commit',
      operation: 'arm',
    });
    assert.equal(armed.status, 200);
    assert.equal(armed.body.armed, true);
    const operations = [randomUUID(), randomUUID()].map((requestId) =>
      http.control('/verification', { operation: 'republish', requestId }),
    );
    const completion = Promise.allSettled(operations);
    let status;
    try {
      const deadline = performance.now() + 20000;
      do {
        status = await http.control('/hold', {
          stage: 'publication-before-commit',
          operation: 'status',
        });
        assert.equal(status.status, 200);
        if (status.body.waiting === 2) break;
        await pause(100);
      } while (performance.now() < deadline);
      assert.equal(
        status.body.waiting,
        2,
        'Both real republish calls must reach named captured-input barrier',
      );
      const release = await http.control('/hold', {
        stage: 'publication-before-commit',
        operation: 'release',
      });
      assert.equal(release.status, 200);
      assert.equal(release.body.released, true);
      const settled = await completion;
      assert(settled.every((r) => r.status === 'fulfilled'));
      const results = settled.map((r) => r.value);
      assert.deepEqual(
        results.map((r) => r.status).sort((a, b) => a - b),
        [200, 409],
      );
      const afterHead = await http.inspect({ kind: 'head' }),
        after = await http.inspect({ kind: 'counts' });
      assert.equal(afterHead.head.revision, beforeHead.head.revision + 1);
      assert.equal(afterHead.head.status, 'released');
      assert.notEqual(afterHead.head.id, beforeHead.head.id);
      assert.equal(
        after.counts.pilot_corpus_publication,
        before.counts.pilot_corpus_publication + 1,
      );
      assert.equal(
        after.counts.pilot_corpus_publication_audit,
        before.counts.pilot_corpus_publication_audit + 1,
      );
      return {
        capturedPredecessor: beforeHead.head.id,
        waiting: 2,
        statuses: results.map((r) => r.status),
        newHead: afterHead.head,
        committedPublications: 1,
        method:
          'Two actual private republish preparations held before publisher with immutable captured predecessor; not a hook inside application SQL.',
      };
    } finally {
      await completion;
    }
  });
  await execute('C08-publication-terminal-constraint', async () => {
    const beforeHead = await http.inspect({ kind: 'head' }),
      before = await http.inspect({ kind: 'counts' });
    assert.equal(
      (
        await http.control('/fault', {
          stage: 'publication',
          mode: 'final-constraint',
        })
      ).status,
      200,
    );
    let failed;
    try {
      failed = await http.control('/verification', {
        operation: 'republish',
        requestId: randomUUID(),
      });
      assert.equal(
        failed.status,
        503,
        'Named terminal SQL constraint must be observed',
      );
      assert.equal(
        failed.body.error?.code ?? failed.body.code,
        'CORPUS_TERMINAL_CONSTRAINT',
      );
    } finally {
      assert.equal(
        (await http.control('/fault', { stage: 'publication', mode: 'none' }))
          .status,
        200,
      );
    }
    const afterHead = await http.inspect({ kind: 'head' }),
      after = await http.inspect({ kind: 'counts' });
    assert.deepEqual(afterHead, beforeHead);
    for (const table of [
      'pilot_corpus_publication',
      'pilot_corpus_publication_state',
      'pilot_corpus_trial_member',
      'pilot_corpus_publication_audit',
    ])
      assert.equal(
        after.counts[table],
        before.counts[table],
        table + ' changed despite final audit constraint',
      );
    return {
      status: failed.status,
      code: failed.body.error?.code ?? failed.body.code ?? null,
      headUnchanged: true,
      publicationMemberAuditCountsUnchanged: true,
      limitation:
        'Fresh snapshot preparations may remain; zero publication transaction effects is asserted, not zero staging effects.',
    };
  });
  await execute('C08-publication-accepted-response-loss', async () => {
    const beforeHead = await http.inspect({ kind: 'head' }),
      before = await http.inspect({ kind: 'counts' }),
      requestId = randomUUID();
    assert.equal(
      (
        await http.control('/fault', {
          stage: 'publication',
          mode: 'accepted-response-loss',
        })
      ).status,
      200,
    );
    let transportError;
    try {
      await http.control('/verification', {
        operation: 'republish',
        requestId,
      });
      assert.fail(
        'Named accepted-response-loss unexpectedly returned acknowledgement',
      );
    } catch (error) {
      assert.notEqual(error.code, 'ERR_ASSERTION');
      transportError = {
        name: error.name,
        code: error.cause?.code ?? error.code ?? null,
      };
    } finally {
      assert.equal(
        (await http.control('/fault', { stage: 'publication', mode: 'none' }))
          .status,
        200,
      );
    }
    assert(transportError);
    const committedHead = await http.inspect({ kind: 'head' }),
      committed = await http.inspect({ kind: 'counts' });
    assert.equal(committedHead.head.revision, beforeHead.head.revision + 1);
    assert.equal(
      committed.counts.pilot_corpus_publication,
      before.counts.pilot_corpus_publication + 1,
    );
    assert.equal(
      committed.counts.pilot_corpus_publication_audit,
      before.counts.pilot_corpus_publication_audit + 1,
    );
    const replay = await http.control('/verification', {
      operation: 'republish',
      requestId,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.requestId, requestId);
    assert.equal(replay.body.recordId, committedHead.head.id);
    assert.deepEqual(await http.inspect({ kind: 'head' }), committedHead);
    assert.deepEqual(await http.inspect({ kind: 'counts' }), committed);
    const repeated = await http.control('/verification', {
      operation: 'republish',
      requestId,
    });
    assert.equal(repeated.status, 200);
    assert.deepEqual(repeated.body, replay.body);
    assert.deepEqual(await http.inspect({ kind: 'counts' }), committed);
    return {
      transportError,
      requestId,
      committedPublicationId: committedHead.head.id,
      exactOriginalReceipt: replay.body,
      onePublication: true,
      noSecondPreparation: true,
    };
  });
}
