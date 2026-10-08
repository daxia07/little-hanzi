import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withOwnedCorpusFixture,
  bootstrapOwnedCorpus,
} from '../scripts/readiness-corpus-bootstrap.mjs';
import {
  readCorpusCatalog,
  proposeCorpus,
  approveCorpus,
} from '../lib/pilot/corpus-family-store.ts';
const setup = async (f) => {
  await bootstrapOwnedCorpus(f.handle);
  await f.client.execute({
    sql: 'INSERT INTO pilot_onboarding(child_id,nickname,experience,audio_ready,updated_at,updated_by) VALUES(?,?,?,?,?,?)',
    args: ['r6-child', 'Learner', 'new', 1, f.clock, 'r6-parent'],
  });
};
test('R6 owned machine verification catalog pages safely with opaque bound cursors, while real coverage remains zero', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    await setup(f);
    const c = f.context('r6-parent'),
      v = f.manifest.corpusVersion;
    const storedPlan = JSON.parse(
      (await f.client.execute('SELECT plan_json FROM pilot_corpus_snapshot'))
        .rows[0].plan_json,
    );
    assert.equal(storedPlan.lane, 'verification');
    assert.equal(storedPlan.counts.includedCharacterCount, 0);
    assert.equal(storedPlan.counts.fixtureCharacterCount, 20);
    assert.equal(storedPlan.counts.verificationPackageCount, 10);
    const first = await readCorpusCatalog(c, 'r6-child', v, { limit: 3 });
    assert.equal(first.items.length, 3);
    assert.ok(first.nextCursor?.startsWith('c1.'));
    assert.equal(JSON.stringify(first).includes('correctChoiceId'), false);
    const second = await readCorpusCatalog(c, 'r6-child', v, {
      limit: 3,
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 3);
    assert.equal(
      first.items.some((a) =>
        second.items.some((b) => a.lessonVersion === b.lessonVersion),
      ),
      false,
    );
    await assert.rejects(
      () =>
        readCorpusCatalog(c, 'r6-child', v, {
          limit: 4,
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
    assert.deepEqual(
      (await readCorpusCatalog(f.context('r6-child'), 'r6-child', v)).items,
      [],
    );
  }));
test('R6 selection preserves nested authority source, ordinal CAS, immutable approval replay and one atomic initial assignment', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    await setup(f);
    const c = f.context('r6-parent'),
      v = f.manifest.corpusVersion,
      page = await readCorpusCatalog(c, 'r6-child', v);
    const selected = page.items[0],
      body = {
        corpusVersion: v,
        selection: {
          lessonVersion: selected.lessonVersion,
          contentDigest: selected.contentDigest,
          releaseId: selected.releaseId,
          releaseRevision: selected.releaseRevision,
        },
        predecessorProposalId: null,
        expectedSourceDigest: null,
      };
    const p = (await proposeCorpus(c, 'r6-child', body)).proposal;
    assert.ok(p);
    assert.equal(p.selectionOrdinal, 1);
    assert.deepEqual((await proposeCorpus(c, 'r6-child', body)).proposal, p);
    const row = (
      await f.client.execute('SELECT source_json FROM pilot_corpus_proposal')
    ).rows[0];
    const source = JSON.parse(row.source_json);
    assert.deepEqual(source.selection, body.selection);
    assert.equal(source.authority.schemaVersion, 'r6-authority-1');
    const plan = (
      await approveCorpus(c, 'r6-child', {
        proposalId: p.proposalId,
        sourceDigest: p.sourceDigest,
      })
    ).plan;
    assert.ok(plan);
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].available, true);
    const replay = (
      await approveCorpus(c, 'r6-child', {
        proposalId: p.proposalId,
        sourceDigest: p.sourceDigest,
      })
    ).plan;
    assert.deepEqual(replay, plan);
    for (const table of [
      'pilot_corpus_plan',
      'pilot_corpus_plan_item',
      'pilot_corpus_assignment',
      'pilot_corpus_schedule',
      'pilot_corpus_learning_audit',
    ])
      assert.equal(
        Number(
          (await f.client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]
            .n,
        ),
        1,
      );
    const next = page.items[1];
    const nextBody = {
      ...body,
      selection: {
        lessonVersion: next.lessonVersion,
        contentDigest: next.contentDigest,
        releaseId: next.releaseId,
        releaseRevision: next.releaseRevision,
      },
      predecessorProposalId: p.proposalId,
      expectedSourceDigest: p.sourceDigest,
    };
    const p2 = (await proposeCorpus(c, 'r6-child', nextBody)).proposal;
    assert.equal(p2.selectionOrdinal, 2);
    await assert.rejects(
      () => proposeCorpus(c, 'r6-child', body),
      (e) => e.code === 'PLACEMENT_STALE',
    );
  }));
test('R6 final approval audit failure rolls back every dependent fact and exact retry commits once', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    await setup(f);
    const c = f.context('r6-parent'),
      v = f.manifest.corpusVersion;
    const p = (
      await proposeCorpus(c, 'r6-child', {
        corpusVersion: v,
        selection: null,
        predecessorProposalId: null,
        expectedSourceDigest: null,
      })
    ).proposal;
    assert.ok(p);
    await f.client.execute(
      "CREATE TRIGGER family_author_final_fault BEFORE INSERT ON pilot_corpus_learning_audit BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FINAL_FAILURE'); END",
    );
    const body = { proposalId: p.proposalId, sourceDigest: p.sourceDigest };
    await assert.rejects(() => approveCorpus(c, 'r6-child', body));
    for (const table of [
      'pilot_corpus_plan',
      'pilot_corpus_plan_item',
      'pilot_corpus_assignment',
      'pilot_corpus_schedule',
      'pilot_corpus_learning_audit',
    ])
      assert.equal(
        Number(
          (await f.client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]
            .n,
        ),
        0,
      );
    await f.client.execute('DROP TRIGGER family_author_final_fault');
    assert.ok((await approveCorpus(c, 'r6-child', body)).plan);
  }));

test('R6 private source inspection rejects altered bindings, unknown properties and stale source replay without a new ordinal', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    await setup(f);
    const c = f.context('r6-parent'),
      v = f.manifest.corpusVersion,
      body = {
        corpusVersion: v,
        selection: null,
        predecessorProposalId: null,
        expectedSourceDigest: null,
      };
    const p = (await proposeCorpus(c, 'r6-child', body)).proposal;
    const { inspectCorpusPlacementSource, inspectCorpusApprovalAck } =
      await import('../lib/pilot/corpus-family-policy.ts');
    const source = JSON.parse(
      (await f.client.execute('SELECT source_json FROM pilot_corpus_proposal'))
        .rows[0].source_json,
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(await inspectCorpusPlacementSource(source))),
      source,
    );
    for (const change of [
      (s) => s.selection.releaseRevision++,
      (s) => s.authority.configuration.ownerIds.push('forged-owner'),
      (s) => (s.lessonVersion = s.selection.lessonVersion),
      (s) => (s.authorityDigest = 'sha256:' + 'f'.repeat(64)),
      (s) => (s.selectionOrdinal = 0),
    ]) {
      const altered = structuredClone(source);
      change(altered);
      await assert.rejects(() => inspectCorpusPlacementSource(altered));
    }
    const plan = (
      await approveCorpus(c, 'r6-child', {
        proposalId: p.proposalId,
        sourceDigest: p.sourceDigest,
      })
    ).plan;
    const ack = JSON.parse(
      (await f.client.execute('SELECT ack_json FROM pilot_corpus_plan')).rows[0]
        .ack_json,
    );
    assert.equal(inspectCorpusApprovalAck(ack).planId, plan.planId);
    assert.throws(() => inspectCorpusApprovalAck({ ...ack, available: true }));
    await f.client.execute({
      sql: "UPDATE pilot_onboarding SET nickname='Changed' WHERE child_id=?",
      args: ['r6-child'],
    });
    await assert.rejects(
      () => proposeCorpus(c, 'r6-child', body),
      (e) => e.code === 'PLACEMENT_STALE',
    );
    assert.equal(
      Number(
        (
          await f.client.execute(
            'SELECT count(*) AS n FROM pilot_corpus_proposal',
          )
        ).rows[0].n,
      ),
      1,
    );
  }));
test('R6 source CAS refuses saved setup/config changes before approval and expiry preserves original proposal', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    await setup(f);
    const c = f.context('r6-parent'),
      v = f.manifest.corpusVersion,
      body = {
        corpusVersion: v,
        selection: null,
        predecessorProposalId: null,
        expectedSourceDigest: null,
      };
    const p = (await proposeCorpus(c, 'r6-child', body)).proposal;
    c.corpus.ownerIds.push('r6-op');
    await assert.rejects(
      () =>
        approveCorpus(c, 'r6-child', {
          proposalId: p.proposalId,
          sourceDigest: p.sourceDigest,
        }),
      (e) => e.code === 'PLACEMENT_STALE',
    );
    c.corpus.ownerIds.pop();
    c.config.curriculumTestNow = String(Date.parse(p.expiresAt));
    // Fresh synthetic session represents current authentication after the fixture's original one-day session expired; only the owned preissued parent is changed.
    await f.client.execute({
      sql: 'INSERT INTO pilot_auth_session(id,expires_at,token,created_at,updated_at,user_id) VALUES(?,?,?,?,?,?)',
      args: [
        'family-expiry-session',
        f.clock + 172800000,
        'SYNTHETIC-FAMILY-EXPIRY',
        f.clock + 86400000,
        f.clock + 86400000,
        'r6-parent',
      ],
    });
    c.session.id = 'family-expiry-session';
    await assert.rejects(
      () => proposeCorpus(c, 'r6-child', body),
      (e) => e.code === 'PLACEMENT_STALE',
    );
    await assert.rejects(
      () =>
        approveCorpus(c, 'r6-child', {
          proposalId: p.proposalId,
          sourceDigest: p.sourceDigest,
        }),
      (e) => e.code === 'PLACEMENT_STALE',
    );
    assert.equal(
      Number(
        (
          await f.client.execute(
            'SELECT count(*) AS n FROM pilot_corpus_proposal',
          )
        ).rows[0].n,
      ),
      1,
    );
    assert.equal(
      Number(
        (await f.client.execute('SELECT count(*) AS n FROM pilot_corpus_plan'))
          .rows[0].n,
      ),
      0,
    );
  }));

test('R6 same-time competing successors never branch and prior assignment/schedule facts remain intact', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    await setup(f);
    const c = f.context('r6-parent'),
      v = f.manifest.corpusVersion;
    c.config.curriculumTestNow = String(Date.now());
    const page = await readCorpusCatalog(c, 'r6-child', v),
      body = {
        corpusVersion: v,
        selection: null,
        predecessorProposalId: null,
        expectedSourceDigest: null,
      };
    const p = (await proposeCorpus(c, 'r6-child', body)).proposal;
    await approveCorpus(c, 'r6-child', {
      proposalId: p.proposalId,
      sourceDigest: p.sourceDigest,
    });
    const successor = (item) => ({
      ...body,
      selection: {
        lessonVersion: item.lessonVersion,
        contentDigest: item.contentDigest,
        releaseId: item.releaseId,
        releaseRevision: item.releaseRevision,
      },
      predecessorProposalId: p.proposalId,
      expectedSourceDigest: p.sourceDigest,
    });
    const results = await Promise.allSettled([
      proposeCorpus(c, 'r6-child', successor(page.items[1])),
      proposeCorpus(c, 'r6-child', successor(page.items[2])),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const count = async (table) =>
      Number(
        (await f.client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]
          .n,
      );
    assert.equal(await count('pilot_corpus_proposal'), 2);
    assert.equal(await count('pilot_corpus_assignment'), 1);
    assert.equal(await count('pilot_corpus_schedule'), 1);
    const prior = (
      await f.client.execute(
        'SELECT created_at FROM pilot_corpus_proposal ORDER BY selection_ordinal',
      )
    ).rows;
    assert.equal(prior[0].created_at, prior[1].created_at);
  }));

test('R6 current link removal during a held catalog read refuses the late page', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    await setup(f);
    const execute = f.client.execute.bind(f.client);
    let changed = false;
    f.client.execute = async (statement) => {
      const result = await execute(statement),
        sql = typeof statement === 'string' ? statement : statement.sql;
      if (!changed && sql.includes('SELECT item.* FROM pilot_corpus_item')) {
        changed = true;
        await execute(
          "DELETE FROM pilot_parent_child WHERE parent_id='r6-parent' AND child_id='r6-child'",
        );
      }
      return result;
    };
    await assert.rejects(
      () =>
        readCorpusCatalog(
          f.context('r6-parent'),
          'r6-child',
          f.manifest.corpusVersion,
        ),
      (e) =>
        [
          'NOT_FOUND',
          'UNAUTHORIZED',
          'CAPABILITY_DENIED',
          'FORBIDDEN',
        ].includes(e.code),
    );
    assert.equal(changed, true);
  }));
test('R6 indexed search applies every English/Hanzi prefix to one item and stale evidence refuses an old cursor', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    await setup(f);
    const c = f.context('r6-parent'),
      v = f.manifest.corpusVersion;
    const page = await readCorpusCatalog(c, 'r6-child', v, { limit: 2 }),
      first = page.items[0];
    const term = (
      await f.client.execute({
        sql: "SELECT term FROM pilot_corpus_search_term WHERE corpus_version=? AND lesson_version=? AND kind='title-english' ORDER BY term LIMIT 1",
        args: [v, first.lessonVersion],
      })
    ).rows[0]?.term;
    assert.ok(term);
    {
      const searched = await readCorpusCatalog(c, 'r6-child', v, {
        q: `${first.targets[0].hanzi} ${String(term).slice(0, 2)}`,
      });
      assert.ok(
        searched.items.some((i) => i.lessonVersion === first.lessonVersion),
      );
    }
    assert.deepEqual(
      (
        await readCorpusCatalog(c, 'r6-child', v, {
          q: 'zzzzzzzzzzzzzzzzzz 木',
        })
      ).items,
      [],
    );
    await f.client.execute(
      'UPDATE pilot_corpus_evidence_epoch SET revision=revision+1 WHERE id=1',
    );
    await assert.rejects(
      () =>
        readCorpusCatalog(c, 'r6-child', v, {
          limit: 2,
          cursor: page.nextCursor,
        }),
      (e) => e.code === 'CURSOR_STALE',
    );
  }));

test('R6 historical private inspector admits 240-character installation identities but refuses incomplete authority scope/capability', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    await setup(f);
    const c = f.context('r6-parent'),
      v = f.manifest.corpusVersion;
    await proposeCorpus(c, 'r6-child', {
      corpusVersion: v,
      selection: null,
      predecessorProposalId: null,
      expectedSourceDigest: null,
    });
    const source = JSON.parse(
        (
          await f.client.execute(
            'SELECT source_json FROM pilot_corpus_proposal',
          )
        ).rows[0].source_json,
      ),
      { inspectCorpusPlacementSource } =
        await import('../lib/pilot/corpus-family-policy.ts'),
      { curriculumDigest } = await import('../lib/curriculum/digest.ts');
    const long = structuredClone(source);
    long.installationId =
      long.authority.installationId =
      long.authority.configuration.capability.installationId =
        'i'.repeat(240);
    long.authorityDigest = await curriculumDigest(long.authority);
    assert.ok(await inspectCorpusPlacementSource(long));
    for (const mutate of [
      (s) => {
        s.installationId =
          s.authority.installationId =
          s.authority.configuration.capability.installationId =
            'i'.repeat(241);
      },
      (s) =>
        s.authority.scope.members.push({
          parentId: 'another-parent',
          childId: s.authority.scope.members[0].childId,
        }),
      (s) => (s.authority.configuration.capability.parentIds = []),
      (s) => (s.authority.configuration.capability.childIds = []),
      (s) => {
        s.authority.scope = { kind: 'starter' };
        s.authority.ownerDecisionId = null;
      },
      (s) => (s.authority.configuration.trust.candidateId = 'mismatched-build'),
    ]) {
      const altered = structuredClone(source);
      mutate(altered);
      altered.authorityDigest = await curriculumDigest(altered.authority);
      await assert.rejects(() => inspectCorpusPlacementSource(altered));
    }
  }));

test('R6 child and granted teacher catalogs expose assigned current stories only and revocation immediately denies', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    await setup(f);
    const c = f.context('r6-parent'),
      v = f.manifest.corpusVersion,
      p = (
        await proposeCorpus(c, 'r6-child', {
          corpusVersion: v,
          selection: null,
          predecessorProposalId: null,
          expectedSourceDigest: null,
        })
      ).proposal;
    await approveCorpus(c, 'r6-child', {
      proposalId: p.proposalId,
      sourceDigest: p.sourceDigest,
    });
    await f.client.execute({
      sql: 'INSERT INTO pilot_teacher_grant(child_id,teacher_id,granting_parent_id,created_at) VALUES(?,?,?,?)',
      args: ['r6-child', 'r6-teacher', 'r6-parent', Date.now()],
    });
    for (const id of ['r6-child', 'r6-teacher']) {
      const page = await readCorpusCatalog(f.context(id), 'r6-child', v);
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0].lessonVersion, p.lessonVersion);
      assert.equal(JSON.stringify(page).includes('publicKeyJwk'), false);
    }
    await f.client.execute(
      "DELETE FROM pilot_teacher_grant WHERE teacher_id='r6-teacher'",
    );
    await assert.rejects(
      () => readCorpusCatalog(f.context('r6-teacher'), 'r6-child', v),
      (e) => e.code === 'NOT_FOUND',
    );
    assert.equal((await readCorpusCatalog(c, 'r6-child', v)).items.length, 10);
  }));
