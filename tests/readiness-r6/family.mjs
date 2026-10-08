/** Independent fresh libSQL family boundaries; HTTP/browser/scale NOT RUN. */
import test from 'node:test';
import assert from 'node:assert/strict';
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
import { recordCorpusSource } from '../../lib/pilot/corpus-store.ts';
import {
  readCurrentCorpusAuthority,
  readCorpusPackageAuthority,
} from '../../lib/pilot/corpus-authority.ts';
import { corpusPrefixUpperBound } from '../../lib/pilot/corpus-family-policy.ts';
const options = { timeout: 120000 };
async function setup(f) {
  const release = await bootstrapOwnedCorpus(f.handle);
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
  return release;
}
const selected = (i) => ({
  lessonVersion: i.lessonVersion,
  contentDigest: i.contentDigest,
  releaseId: i.releaseId,
  releaseRevision: i.releaseRevision,
});
const request = (v, i, p = null) => ({
  corpusVersion: v,
  selection: selected(i),
  predecessorProposalId: p?.proposalId ?? null,
  expectedSourceDigest: p?.sourceDigest ?? null,
});
async function tables(f) {
  const out = {};
  for (const t of [
    'pilot_corpus_plan',
    'pilot_corpus_plan_item',
    'pilot_corpus_assignment',
    'pilot_corpus_schedule',
    'pilot_corpus_learning_audit',
  ])
    out[t] = (
      await f.client.execute('SELECT * FROM ' + t + ' ORDER BY id')
    ).rows;
  return out;
}

test(
  'FC01 indexed pages/mixed literal search and encrypted bound cursors',
  options,
  async () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      await setup(f);
      const c = f.context('r6-parent'),
        v = f.manifest.corpusVersion,
        first = await readCorpusCatalog(c, 'r6-child', v, { limit: 3 });
      assert.equal(first.items.length, 3);
      assert.ok(first.nextCursor.startsWith('c1.'));
      const items = [...first.items];
      let cursor = first.nextCursor,
        pages = 1;
      while (cursor) {
        const p = await readCorpusCatalog(c, 'r6-child', v, {
          limit: 3,
          cursor,
        });
        assert.ok(p.items.length <= 3);
        items.push(...p.items);
        cursor = p.nextCursor;
        assert.ok(++pages <= 5);
      }
      assert.equal(items.length, 10);
      assert.equal(new Set(items.map((i) => i.lessonVersion)).size, 10);
      assert.deepEqual(
        items.map((i) => i.lessonVersion),
        f.manifest.items.map((i) => i.lessonVersion),
      );
      const mixed = await readCorpusCatalog(c, 'r6-child', v, { q: 'wood 木' });
      assert.deepEqual(
        mixed.items.map((i) => i.lessonVersion),
        [f.manifest.items[0].lessonVersion],
      );
      assert.deepEqual(
        (await readCorpusCatalog(c, 'r6-child', v, { q: 'zzzznotaword' }))
          .items,
        [],
      );
      assert.ok(
        !/correctChoiceId|expectedAnswerHanzi|instructionEnglish/u.test(
          JSON.stringify(first),
        ),
      );
      await assert.rejects(
        () =>
          readCorpusCatalog(c, 'r6-child', v, {
            limit: 2,
            cursor: first.nextCursor,
          }),
        (e) => e.code === 'CURSOR_STALE',
      );
      await assert.rejects(
        () =>
          readCorpusCatalog(f.context('r6-parent-2'), 'r6-child-2', v, {
            limit: 3,
            cursor: first.nextCursor,
          }),
        (e) => e.code === 'CURSOR_FOREIGN',
      );
      const damaged = first.nextCursor.slice(0, -3) + 'AAA';
      await assert.rejects(
        () =>
          readCorpusCatalog(c, 'r6-child', v, { limit: 3, cursor: damaged }),
        (e) => e.code === 'CURSOR_INVALID',
      );
      await assert.rejects(
        () => readCorpusCatalog(c, 'r6-child', v, { limit: 51 }),
        (e) => e.status === 400,
      );
    }),
);

test(
  'FC02 child/teacher assigned-only, actual grant revoke and held late parent link revoke',
  options,
  async () => {
    let armed = false,
      fired = 0,
      fixture;
    await withOwnedCorpusFixture(
      'draft-corpus',
      async (f) => {
        fixture = f;
        await setup(f);
        const c = f.context('r6-parent'),
          v = f.manifest.corpusVersion,
          item = (await readCorpusCatalog(c, 'r6-child', v)).items[0];
        assert.deepEqual(
          (await readCorpusCatalog(f.context('r6-child'), 'r6-child', v)).items,
          [],
        );
        await f.client.execute({
          sql: 'INSERT INTO pilot_teacher_grant VALUES(?,?,?,?)',
          args: ['r6-child', 'r6-teacher', 'r6-parent', f.clock],
        });
        assert.deepEqual(
          (await readCorpusCatalog(f.context('r6-teacher'), 'r6-child', v))
            .items,
          [],
        );
        const p = (await proposeCorpus(c, 'r6-child', request(v, item)))
          .proposal;
        await approveCorpus(c, 'r6-child', {
          proposalId: p.proposalId,
          sourceDigest: p.sourceDigest,
        });
        assert.equal(
          (await readCorpusCatalog(f.context('r6-child'), 'r6-child', v)).items
            .length,
          1,
        );
        assert.equal(
          (await readCorpusCatalog(f.context('r6-teacher'), 'r6-child', v))
            .items.length,
          1,
        );
        await f.client.execute(
          "DELETE FROM pilot_teacher_grant WHERE teacher_id='r6-teacher'",
        );
        await assert.rejects(
          () => readCorpusCatalog(f.context('r6-teacher'), 'r6-child', v),
          (e) => e.code === 'NOT_FOUND',
        );
        await assert.rejects(
          () => readCorpusCatalog(f.context(), 'r6-child', v),
          (e) => e.code === 'FORBIDDEN',
        );
        armed = true;
        await assert.rejects(
          () => readCorpusCatalog(c, 'r6-child', v),
          (e) => ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED'].includes(e.code),
        );
        assert.equal(fired, 1);
      },
      {
        instrumentClient(client) {
          const execute = client.execute.bind(client);
          client.execute = async (statement) => {
            const r = await execute(statement);
            if (
              armed &&
              String(
                typeof statement === 'string' ? statement : statement.sql,
              ).includes('SELECT item.* FROM pilot_corpus_item')
            ) {
              armed = false;
              fired++;
              await fixture.client.execute(
                "DELETE FROM pilot_parent_child WHERE parent_id='r6-parent'",
              );
            }
            return r;
          };
        },
      },
    );
  },
);

test(
  'FC03 same-time proposal CAS, exact replay, stale old body and expiry never append',
  options,
  async () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      await setup(f);
      const c = f.context('r6-parent'),
        v = f.manifest.corpusVersion,
        items = (await readCorpusCatalog(c, 'r6-child', v)).items;
      f.config.curriculumTestNow = f.clock + 60000;
      const bodies = items.slice(0, 2).map((i) => request(v, i)),
        results = await Promise.allSettled(
          bodies.map((b) => proposeCorpus(c, 'r6-child', b)),
        );
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const win = results.findIndex((r) => r.status === 'fulfilled'),
        p = results[win].value.proposal;
      assert.equal(p.selectionOrdinal, 1);
      assert.deepEqual(
        (await proposeCorpus(c, 'r6-child', bodies[win])).proposal,
        p,
      );
      const second = (
        await proposeCorpus(c, 'r6-child', request(v, items[2], p))
      ).proposal;
      assert.equal(second.selectionOrdinal, 2);
      const rows = (
        await f.client.execute(
          'SELECT * FROM pilot_corpus_proposal ORDER BY selection_ordinal',
        )
      ).rows;
      assert.equal(rows[0].created_at, rows[1].created_at);
      await assert.rejects(
        () => proposeCorpus(c, 'r6-child', bodies[win]),
        (e) => e.code === 'PLACEMENT_STALE',
      );
      assert.equal(
        (
          await f.client.execute(
            'SELECT count(*) AS n FROM pilot_corpus_proposal',
          )
        ).rows[0].n,
        2,
      );
      const expires = Number(rows[1].expires_at);
      await f.client.execute({
        sql: 'INSERT INTO pilot_auth_session(id,expires_at,token,created_at,updated_at,user_id) VALUES(?,?,?,?,?,?)',
        args: [
          'independent-renewed-parent',
          expires + 86400000,
          'SYNTHETIC-PRIVATE-RENEWED',
          expires - 1000,
          expires - 1000,
          'r6-parent',
        ],
      });
      c.session.id = 'independent-renewed-parent';
      f.config.curriculumTestNow = expires;
      await assert.rejects(
        () => proposeCorpus(c, 'r6-child', request(v, items[2], p)),
        (e) => e.code === 'PLACEMENT_STALE',
      );
      assert.equal(
        (
          await f.client.execute(
            'SELECT count(*) AS n FROM pilot_corpus_proposal',
          )
        ).rows[0].n,
        2,
      );
    }),
);

test(
  'FC04 actual approval terminal rollback; one exact commit; original replay after withdrawal',
  options,
  async () => {
    let armed = false,
      fired = 0,
      engineCode;
    await withOwnedCorpusFixture(
      'draft-corpus',
      async (f) => {
        const release = await setup(f),
          c = f.context('r6-parent'),
          v = f.manifest.corpusVersion,
          item = (await readCorpusCatalog(c, 'r6-child', v)).items[0],
          p = (await proposeCorpus(c, 'r6-child', request(v, item))).proposal,
          input = { proposalId: p.proposalId, sourceDigest: p.sourceDigest },
          before = await tables(f);
        armed = true;
        await assert.rejects(
          () => approveCorpus(c, 'r6-child', input),
          (e) => e.code === 'STORAGE_UNAVAILABLE' && e.status === 503,
        );
        assert.equal(fired, 1);
        assert.ok(engineCode?.startsWith('SQLITE_CONSTRAINT'));
        assert.deepEqual(await tables(f), before);
        const plan = (await approveCorpus(c, 'r6-child', input)).plan;
        for (const rows of Object.values(await tables(f)))
          assert.equal(rows.length, 1);
        assert.deepEqual(
          (await approveCorpus(c, 'r6-child', input)).plan,
          plan,
        );
        await withdrawOwnedCorpus(f.handle, {
          requestId: 'independent-family-withdraw',
          expectedRevision: 1,
          predecessorPublicationId: release.recordId,
        });
        const replay = (await approveCorpus(c, 'r6-child', input)).plan;
        assert.equal(replay.planId, plan.planId);
        assert.equal(replay.approvedAt, plan.approvedAt);
        assert.equal(replay.items[0].available, false);
        for (const rows of Object.values(await tables(f)))
          assert.equal(rows.length, 1);
      },
      {
        instrumentClient(client) {
          const batch = client.batch.bind(client);
          client.batch = async (statements, mode) => {
            if (
              armed &&
              statements.some((s) =>
                String(s.sql).includes('pilot_corpus_plan('),
              )
            ) {
              armed = false;
              fired++;
              try {
                return await batch(
                  [
                    ...statements,
                    {
                      sql: 'INSERT INTO pilot_installation SELECT * FROM pilot_installation WHERE id=1',
                      args: [],
                    },
                  ],
                  mode,
                );
              } catch (e) {
                engineCode = typeof e.code === 'string' ? e.code : null;
                throw e;
              }
            }
            return batch(statements, mode);
          };
        },
      },
    );
  },
);

test(
  'FC05 selected companion source correction invalidates old cursor/selection while other package remains',
  options,
  async () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      await setup(f);
      const c = f.context('r6-parent'),
        v = f.manifest.corpusVersion,
        page = await readCorpusCatalog(c, 'r6-child', v, { limit: 3 }),
        first = page.items[0],
        a = await readCurrentCorpusAuthority(c, v),
        p = await readCorpusPackageAuthority(c, a, first.lessonVersion),
        source = (
          await f.client.execute({
            sql: 'SELECT * FROM pilot_corpus_source_evidence WHERE id=?',
            args: [p.sourceIds[1].id],
          })
        ).rows[0];
      await recordCorpusSource(f.context(), v, {
        requestId: 'independent-companion-correction',
        lessonVersion: first.lessonVersion,
        contentDigest: first.contentDigest,
        classification: 'unverified-draft',
        sourceRefs: ['SYNTHETIC-CORRECTED'],
        licenseRefs: ['SYNTHETIC'],
        reviewRefs: [],
        identityReviews: [],
        predecessorEvidenceId: source.id,
        expectedEvidenceDigest: source.evidence_digest,
      });
      await assert.rejects(
        () =>
          readCorpusCatalog(c, 'r6-child', v, {
            limit: 3,
            cursor: page.nextCursor,
          }),
        (e) => e.code === 'CURSOR_STALE',
      );
      await assert.rejects(
        () => proposeCorpus(c, 'r6-child', request(v, first)),
        (e) => e.code === 'PLACEMENT_UNAVAILABLE',
      );
      const current = await readCorpusCatalog(c, 'r6-child', v, { limit: 50 });
      assert.equal(current.items.length, 9);
      assert.ok(
        current.items.every((i) => i.lessonVersion !== first.lessonVersion),
      );
      assert.ok(
        current.items.some(
          (i) => i.lessonVersion === page.items[1].lessonVersion,
        ),
      );
    }),
);

test('FC06 supplementary Han indexed prefix boundary', options, async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    const probes = [
      ['木', '木𠀀', true],
      ['木', '朩', false],
      ['𠀀', '𠀀木', true],
      ['木', '林', false],
    ];
    for (const [prefix, term, expected] of probes) {
      assert.equal(term.startsWith(prefix), expected);
      const upper = corpusPrefixUpperBound(prefix);
      assert.ok(upper !== null);
      const result = await f.client.execute({
        sql: 'SELECT (? >= ? AND ? < ?) AS matched',
        args: [term, prefix, term, upper],
      });
      assert.equal(Number(result.rows[0].matched), Number(expected));
    }
    assert.equal(corpusPrefixUpperBound('木'), '朩');
    assert.equal(
      corpusPrefixUpperBound(String.fromCodePoint(0xd7ff)),
      String.fromCodePoint(0xe000),
    );
    assert.equal(
      corpusPrefixUpperBound('木' + String.fromCodePoint(0x10ffff)),
      '朩',
    );
    assert.equal(corpusPrefixUpperBound(String.fromCodePoint(0x10ffff)), null);
  }),
);
