import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registryCoverageForSnapshot } from '../lib/pilot/curriculum.ts';
const d = 'sha256:' + 'a'.repeat(64);
test('LB02 legacy reviewed counter cannot infer real R6 source from simulated ordinary approval', async () => {
  const p = JSON.parse(
    await readFile(
      new URL(
        '../content/curriculum/corpus/corpus-path-01-v1.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const snapshot = {
    state: [{ revision: 2 }],
    packages: [
      {
        lesson_version: p.lessonVersion,
        content_digest: d,
        test_run_id: null,
        imported_at: 0,
      },
    ],
    reviews: [
      {
        lesson_version: p.lessonVersion,
        review_id: 'simulated-r6-review',
        decision: 'approved',
        test_run_id: null,
        review_sequence: 1,
      },
    ],
    manifests: new Map([[p.lessonVersion, p]]),
  };
  const result = registryCoverageForSnapshot(snapshot);
  assert.equal(result.counts.machineValidDistinct, 2);
  assert.equal(result.counts.humanReviewedDistinct, 0);
  assert.equal(result.counts.starterReleasedDistinct, 0);
});
import { withCorpusFixture } from './helpers/corpus-store-fixture.mjs';
import {
  recordCorpusSource,
  registerCorpusBatch,
  registerCorpus,
  listCorpora,
} from '../lib/pilot/corpus-store.ts';
const sourceRequest = (item) => ({
  requestId: 'source-' + item.lessonVersion,
  lessonVersion: item.lessonVersion,
  contentDigest: item.contentDigest,
  classification: 'unverified-draft',
  sourceRefs: ['pending-source'],
  licenseRefs: ['pending-license'],
  reviewRefs: [],
  identityReviews: [],
  predecessorEvidenceId: null,
  expectedEvidenceDigest: null,
});
test('E001/E002 real DB immutable registration requires all source roots and exact batch/package identity', async () =>
  withCorpusFixture(async (f) => {
    const c = f.context();
    await assert.rejects(
      registerCorpus(c, { corpus: f.manifest }),
      /CORPUS_BINDING/,
    );
    const absent = await f.client.execute(
      'SELECT count(*) AS count FROM pilot_corpus',
    );
    assert.equal(absent.rows[0].count, 0);
    for (const item of f.manifest.items)
      await recordCorpusSource(
        c,
        f.manifest.corpusVersion,
        sourceRequest(item),
      );
    const batch = await registerCorpusBatch(c, f.manifest.corpusVersion, {
      requestId: 'batch-request',
      batch: f.batch,
    });
    assert.equal(batch.items.length, 10);
    const ack = await registerCorpus(c, { corpus: f.manifest });
    assert.equal(ack.corpusVersion, f.manifest.corpusVersion);
    assert.deepEqual(await registerCorpus(c, { corpus: f.manifest }), ack);
    const rows = await f.client.execute(
      'SELECT count(*) AS count FROM pilot_corpus_character',
    );
    assert.equal(rows.rows[0].count, 20);
    const page = await listCorpora(c);
    assert.equal(page.items[0].packageCount, 10);
    assert.equal(page.items[0].corpusDigest, ack.corpusDigest);
    assert.equal(page.nextCursor, null);
    await assert.rejects(
      registerCorpus(c, { corpus: { ...f.manifest, corpusId: 'changed' } }),
      /CORPUS_CONFLICT/,
    );
  }));
test('E002 real DB original source replay survives successor; fixture lineage cannot promote and actor revocation prevents next write', async () =>
  withCorpusFixture(async (f) => {
    const c = f.context(),
      item = f.manifest.items[0],
      request = sourceRequest(item),
      ack = await recordCorpusSource(c, f.manifest.corpusVersion, request);
    assert.deepEqual(
      await recordCorpusSource(c, f.manifest.corpusVersion, request),
      ack,
    );
    const original = (
      await f.client.execute({
        sql: 'SELECT * FROM pilot_corpus_source_evidence WHERE id=?',
        args: [ack.recordId],
      })
    ).rows[0];
    const next = {
      ...request,
      requestId: 'source-next',
      predecessorEvidenceId: ack.recordId,
      expectedEvidenceDigest: original.evidence_digest,
    };
    await recordCorpusSource(c, f.manifest.corpusVersion, next);
    assert.deepEqual(
      await recordCorpusSource(c, f.manifest.corpusVersion, request),
      ack,
    );
    assert.equal(
      (
        await f.client.execute(
          'SELECT count(*) AS count FROM pilot_corpus_source_evidence',
        )
      ).rows[0].count,
      2,
    );
    await assert.rejects(
      recordCorpusSource(c, f.manifest.corpusVersion, {
        ...next,
        requestId: 'branch',
      }),
      /SOURCE_STALE/,
    );
    await f.client.execute(
      "UPDATE pilot_auth_user SET role='teacher' WHERE id='r6-op'",
    );
    await assert.rejects(
      recordCorpusSource(c, f.manifest.corpusVersion, {
        ...request,
        requestId: 'revoked',
      }),
      /UNAUTHORIZED/,
    );
  }));

test('E009 held exact replay cannot return after current actor session is revoked', async () =>
  withCorpusFixture(async (f) => {
    const c = f.context(),
      version = f.manifest.corpusVersion;
    for (const item of f.manifest.items)
      await recordCorpusSource(c, version, sourceRequest(item));
    const batchRequest = { requestId: 'batch-held', batch: f.batch };
    await registerCorpusBatch(c, version, batchRequest);
    await registerCorpus(c, { corpus: f.manifest });
    for (const [table, invoke] of [
      [
        'pilot_corpus_source_evidence',
        (ctx) =>
          recordCorpusSource(ctx, version, sourceRequest(f.manifest.items[0])),
      ],
      [
        'pilot_corpus_batch',
        (ctx) => registerCorpusBatch(ctx, version, batchRequest),
      ],
      ['pilot_corpus', (ctx) => registerCorpus(ctx, { corpus: f.manifest })],
    ]) {
      await f.client.execute(
        'UPDATE pilot_auth_session SET expires_at=' +
          (Date.now() + 86400000) +
          " WHERE id='session-r6-op'",
      );
      let held = false;
      const db = Object.create(f.db);
      db.prepare = (sql) => {
        const statement = f.db.prepare(sql);
        const wrapped = Object.create(statement);
        wrapped.first = async (...args) => {
          const row = await statement.first(...args);
          if (!held && sql.startsWith('SELECT * FROM ' + table + ' WHERE')) {
            held = true;
            await f.client.execute(
              "UPDATE pilot_auth_session SET expires_at=0 WHERE id='session-r6-op'",
            );
          }
          return row;
        };
        return wrapped;
      };
      await assert.rejects(invoke({ ...c, db }), /UNAUTHORIZED/, table);
      assert.equal(held, true);
    }
  }));

import { corpusCoverage } from '../lib/pilot/corpus-coverage.ts';
test('E002/E008 real fixture coverage stays real-zero and pages authenticated current metadata', async () =>
  withCorpusFixture(async (f) => {
    const c = f.context(),
      v = f.manifest.corpusVersion;
    for (const i of f.manifest.items)
      await recordCorpusSource(c, v, sourceRequest(i));
    await registerCorpusBatch(c, v, { requestId: 'batch', batch: f.batch });
    await registerCorpus(c, { corpus: f.manifest });
    const first = await corpusCoverage(c, v, { limit: 7 });
    assert.equal(first.items.length, 7);
    assert.equal(first.counts.fixture, 20);
    assert.equal(first.counts.reviewedReady, 0);
    assert.equal(first.counts.prospectiveStarter, 0);
    assert.equal(first.counts.committedStarter, 0);
    assert.equal(first.snapshot, null);
    assert.equal(first.release, null);
    assert.ok(first.nextCursor);
    const second = await corpusCoverage(c, v, {
      limit: 7,
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 7);
    assert.equal(
      new Set([...first.items, ...second.items].map((i) => i.coverageIdentity))
        .size,
      14,
    );
    await assert.rejects(
      corpusCoverage(f.context('r6-other'), v, {
        limit: 7,
        cursor: first.nextCursor,
      }),
      /CURSOR_FOREIGN/,
    );
    const original = (
      await f.client.execute({
        sql: 'SELECT * FROM pilot_corpus_source_evidence WHERE lesson_version=?',
        args: [f.manifest.items[0].lessonVersion],
      })
    ).rows[0];
    await recordCorpusSource(c, v, {
      ...sourceRequest(f.manifest.items[0]),
      requestId: 'changed-source',
      predecessorEvidenceId: original.id,
      expectedEvidenceDigest: original.evidence_digest,
    });
    await assert.rejects(
      corpusCoverage(c, v, { limit: 7, cursor: first.nextCursor }),
      /CURSOR_STALE/,
    );
  }));

import { parseCorpusBindings } from '../lib/pilot/corpus-config.ts';
test('R6 optional configuration is deny-by-default and rejects malformed restricting bindings', () => {
  assert.deepEqual(parseCorpusBindings({}), {
    ownerIds: [],
    fixtureBinding: null,
    capability: null,
  });
  assert.deepEqual(
    parseCorpusBindings({ HANZI_CORPUS_OWNER_IDS: '["named-parent"]' })
      .ownerIds,
    ['named-parent'],
  );
  for (const bindings of [
    { HANZI_CORPUS_OWNER_IDS: '["x","x"]' },
    { HANZI_CORPUS_FIXTURE_BINDING: '{}' },
    { HANZI_CORPUS_CAPABILITY: '{}' },
  ])
    assert.throws(() => parseCorpusBindings(bindings), /STORAGE_UNAVAILABLE/);
});
test('E001 real registration metadata batch rolls back every table on final SQL constraint failure', async () =>
  withCorpusFixture(async (f) => {
    const c = f.context(),
      v = f.manifest.corpusVersion;
    for (const i of f.manifest.items)
      await recordCorpusSource(c, v, sourceRequest(i));
    await registerCorpusBatch(c, v, {
      requestId: 'atomic-batch',
      batch: f.batch,
    });
    const before = (
      await f.client.execute(
        'SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1',
      )
    ).rows[0].revision;
    const db = Object.create(f.db);
    db.batch = (statements) =>
      f.db.batch([
        ...statements,
        f.db.prepare(
          'INSERT INTO pilot_installation SELECT * FROM pilot_installation',
        ),
      ]);
    await assert.rejects(
      registerCorpus({ ...c, db }, { corpus: f.manifest }),
      /STORAGE_UNAVAILABLE/,
    );
    for (const table of [
      'pilot_corpus',
      'pilot_corpus_item',
      'pilot_corpus_character',
      'pilot_corpus_search_term',
    ])
      assert.equal(
        (await f.client.execute('SELECT count(*) AS n FROM ' + table)).rows[0]
          .n,
        0,
        table,
      );
    assert.equal(
      (
        await f.client.execute(
          'SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1',
        )
      ).rows[0].revision,
      before,
    );
  }));

test('configured owner account allowlist is bounded to frozen twenty accounts', () => {
  assert.throws(
    () =>
      parseCorpusBindings({
        HANZI_CORPUS_OWNER_IDS: JSON.stringify(
          Array.from({ length: 21 }, (_, i) => 'owner-' + i),
        ),
      }),
    /STORAGE_UNAVAILABLE/,
  );
});

test('E001 supported long title and word English register without widening eighty-scalar user queries', async () =>
  withCorpusFixture(
    async (f) => {
      const c = f.context(),
        v = f.manifest.corpusVersion;
      for (const i of f.manifest.items)
        await recordCorpusSource(c, v, sourceRequest(i));
      await registerCorpusBatch(c, v, {
        requestId: 'long-batch',
        batch: f.batch,
      });
      await registerCorpus(c, { corpus: f.manifest });
      assert.equal(
        (
          await f.client.execute(
            'SELECT count(*) AS n FROM pilot_corpus_search_term',
          )
        ).rows[0].n > 0,
        true,
      );
    },
    { longDisplay: true },
  ));

test('current installation switch refuses held writes and scoped metadata reads', async () =>
  withCorpusFixture(async (f) => {
    const c = f.context(),
      v = f.manifest.corpusVersion;
    for (const i of f.manifest.items)
      await recordCorpusSource(c, v, sourceRequest(i));
    await registerCorpusBatch(c, v, {
      requestId: 'scope-batch',
      batch: f.batch,
    });
    await registerCorpus(c, { corpus: f.manifest });
    const db = Object.create(f.db);
    db.batch = async (statements) => {
      await f.client.execute(
        "UPDATE pilot_installation SET installation_id='changed-install' WHERE id=1",
      );
      return f.db.batch(statements);
    };
    const old = (
      await f.client.execute({
        sql: 'SELECT * FROM pilot_corpus_source_evidence WHERE lesson_version=?',
        args: [f.manifest.items[0].lessonVersion],
      })
    ).rows[0];
    await assert.rejects(
      recordCorpusSource({ ...c, db }, v, {
        ...sourceRequest(f.manifest.items[0]),
        requestId: 'held-switch',
        predecessorEvidenceId: old.id,
        expectedEvidenceDigest: old.evidence_digest,
      }),
      /STORAGE_UNAVAILABLE/,
    );
    assert.equal(
      (
        await f.client.execute(
          'SELECT count(*) AS n FROM pilot_corpus_source_evidence',
        )
      ).rows[0].n,
      10,
    );
    for (const [table, invoke] of [
      ['pilot_corpus', (ctx) => listCorpora(ctx)],
      ['pilot_corpus_item', (ctx) => corpusCoverage(ctx, v)],
    ]) {
      await f.client.execute(
        "UPDATE pilot_installation SET installation_id='r6-author-install' WHERE id=1",
      );
      let switched = false;
      const readDb = Object.create(f.db);
      readDb.prepare = (sql) => {
        const st = f.db.prepare(sql),
          w = Object.create(st);
        w.all = async (...args) => {
          const r = await st.all(...args);
          if (!switched && sql.includes('FROM ' + table + ' ')) {
            switched = true;
            await f.client.execute(
              "UPDATE pilot_installation SET installation_id='changed-install' WHERE id=1",
            );
          }
          return r;
        };
        return w;
      };
      await assert.rejects(invoke({ ...c, db: readDb }), /STORAGE_UNAVAILABLE/);
      assert.equal(switched, true);
    }
  }));
