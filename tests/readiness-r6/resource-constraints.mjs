import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { applyLibsqlMigrations } from '../../scripts/pilot-libsql-admin.mjs';
const root = process.cwd(),
  dep =
    '/private/var/folders/hr/l9ynfm_j31g54lqlsqychm0m0000gp/T/hanzi-r2-dependencies-a2tj4rrw/node_modules/@libsql/client';
const { createClient } = await import(
  pathToFileURL(path.join(dep, 'lib-esm/node.js'))
);
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'hanzi-r6-resource-'));
await fs.writeFile(path.join(work, '.hanzi-qa-owned'), 'r6-resource-1');
const out = path.join(root, 'outputs/qa/readiness-r6/resource-constraints-2');
await fs.mkdir(out, { recursive: false });
const p =
    'outputs/implementation/readiness-r6/backend/0007-corpus-learning.sql',
  sql = await fs.readFile(p, 'utf8'),
  sha = (b) => createHash('sha256').update(b).digest('hex'),
  hash = sha(sql);
assert.equal(
  hash,
  '4907c40484d03ecee3f654ebf9ab05f8dddf44360574bef16a28c9a14660e880',
);
const client = createClient({ url: 'file:' + path.join(work, 'fresh.db') }),
  D = 'sha256:' + 'a'.repeat(64),
  J = JSON.stringify;
const report = { sourceHash: hash, work, cases: [], startedAt: Date.now() };
const exec = (sql, args = []) => client.execute({ sql, args });
async function row(t, o) {
  const values = {};
  for (const c of (await exec('PRAGMA table_info(' + t + ')')).rows)
    if (c.notnull)
      values[c.name] =
        c.type === 'INTEGER'
          ? 0
          : c.name.endsWith('_digest')
            ? D
            : c.name.endsWith('_json')
              ? '{}'
              : 'fixture';
  Object.assign(values, o);
  const k = Object.keys(values);
  return exec(
    'INSERT INTO ' +
      t +
      '(' +
      k.join(',') +
      ') VALUES(' +
      k.map(() => '?').join(',') +
      ')',
    k.map((x) => values[x]),
  );
}
async function test(id, f) {
  try {
    await f();
    report.cases.push({ id, outcome: 'PASS' });
  } catch (e) {
    report.cases.push({ id, outcome: 'FAIL', error: e.message });
    throw e;
  }
}
const epoch = async () =>
  Number(
    (await exec('SELECT revision FROM pilot_corpus_evidence_epoch')).rows[0]
      .revision,
  );
try {
  await applyLibsqlMigrations({ client, root });
  await client.executeMultiple(sql);
  report.engine = (await exec('SELECT sqlite_version() v')).rows[0].v;
  for (const [id, role] of [
    ['op', 'operator'],
    ['parent', 'parent'],
    ['child', 'child'],
  ])
    await row('pilot_auth_user', {
      id,
      name: 'Synthetic',
      email: id + '@example.test',
      username: id,
      display_username: id,
      role,
    });
  await row('pilot_curriculum_package', {
    lesson_version: 'fixture-v1',
    lesson_id: 'fixture',
    canonicalization_version: 's3-json-1',
    manifest_json: J({ renderer: { adapterId: 'corpus-paired' } }),
    import_id: 'import',
    imported_by_user_id: 'op',
  });
  const batch = {
    id: 'batch1',
    batch_version: 'batch1',
    actor_id: 'op',
    installation_id: 'install',
    request_id: 'same',
    request_json: J({ resourceId: 'corpus1' }),
  };
  await test('R01-batch-resource-scope', async () => {
    await row('pilot_corpus_batch', batch);
    await row('pilot_corpus_batch', {
      ...batch,
      id: 'batch2',
      batch_version: 'batch2',
      request_json: J({ resourceId: 'corpus2' }),
    });
    await assert.rejects(
      () =>
        row('pilot_corpus_batch', {
          ...batch,
          id: 'batch3',
          batch_version: 'batch3',
          request_json: J({ resourceId: 'corpus1', changed: true }),
        }),
      /UNIQUE/,
    );
    for (const resourceId of [undefined, null])
      await assert.rejects(
        () =>
          row('pilot_corpus_batch', {
            ...batch,
            id: 'missing' + String(resourceId),
            batch_version: 'missing' + String(resourceId),
            request_id: 'missing' + String(resourceId),
            request_json: J({ resourceId }),
          }),
        /CHECK/,
      );
  });
  for (const corpus_version of ['corpus1', 'corpus2']) {
    await row('pilot_corpus', {
      corpus_version,
      corpus_id: corpus_version,
      policy_version: 'r6-corpus-policy-1',
      imported_by: 'op',
    });
    await row('pilot_corpus_item', {
      corpus_version,
      lesson_version: 'fixture-v1',
      batch_id: 'batch1',
      track_id: 'track',
      sequence: 1,
      adapter_id: 'corpus-paired',
      adapter_version: 'corpus-paired-v1',
    });
  }
  const source = {
    id: 'source',
    lesson_version: 'fixture-v1',
    classification: 'verification-fixture',
    lineage_id: 'source',
    source_ordinal: 1,
    actor_id: 'op',
    installation_id: 'install',
    request_id: 'same',
    request_json: J({ resourceId: 'corpus1' }),
  };
  await row('pilot_corpus_source_evidence', source);
  await test('R02-source-resource-scope', async () => {
    await row('pilot_corpus_source_evidence', {
      ...source,
      id: 'source2',
      source_ordinal: 2,
      supersedes_id: 'source',
      evidence_digest: 'sha256:' + 'b'.repeat(64),
      request_json: J({
        resourceId: 'corpus2',
        request: { expectedEvidenceDigest: D },
      }),
    });
    await assert.rejects(
      () =>
        row('pilot_corpus_source_evidence', {
          ...source,
          id: 'source3',
          source_ordinal: 3,
          supersedes_id: 'source2',
          evidence_digest: 'sha256:' + 'c'.repeat(64),
          request_json: J({
            resourceId: 'corpus1',
            request: { expectedEvidenceDigest: 'sha256:' + 'b'.repeat(64) },
          }),
        }),
      /UNIQUE/,
    );
  });
  for (let i = 0; i < 2; i++) {
    await row('pilot_curriculum_character', {
      lesson_version: 'fixture-v1',
      character_id: 'char' + i,
      hanzi: i ? '林' : '木',
      character_index: i,
    });
    await row('pilot_corpus_character', {
      corpus_version: 'corpus1',
      lesson_version: 'fixture-v1',
      character_id: 'char' + i,
      target_index: i,
      coverage_identity: i ? '林' : '木',
      identity_version: 'r6-coverage-identity-1',
      source_evidence_id: 'source',
    });
  }
  const snap = {
    id: 'snap1',
    corpus_version: 'corpus1',
    installation_id: 'install',
    candidate_id: 'candidate',
    evidence_epoch: await epoch(),
    plan_json: J({ lane: 'verification' }),
    expected_included_count: 0,
    expected_exclusion_count: 2,
    expected_package_count: 1,
    status: 'building',
    created_by: 'op',
    request_id: 'same',
    request_json: J({ resourceId: 'corpus1' }),
    test_run_id: 'verify',
  };
  await test('R03-snapshot-resource-scope', async () => {
    await row('pilot_corpus_snapshot', snap);
    await row('pilot_corpus_snapshot', {
      ...snap,
      id: 'snap2',
      corpus_version: 'corpus2',
      request_json: J({ resourceId: 'corpus2' }),
    });
    await assert.rejects(
      () =>
        row('pilot_corpus_snapshot', {
          ...snap,
          id: 'bad-snap',
          request_id: 'other',
          request_json: J({ resourceId: 'corpus2' }),
        }),
      /CHECK/,
    );
  });
  const owner = {
    id: 'owner1',
    snapshot_id: 'snap1',
    installation_id: 'install',
    candidate_id: 'candidate',
    decision: 'rejected',
    actor_id: 'op',
    request_id: 'same',
    request_json: J({ resourceId: 'corpus1' }),
  };
  await test('R04-owner-resource-scope-and-binding', async () => {
    await row('pilot_corpus_owner_decision', owner);
    await row('pilot_corpus_owner_decision', {
      ...owner,
      id: 'owner2',
      snapshot_id: 'snap2',
      request_json: J({ resourceId: 'corpus2' }),
    });
    await assert.rejects(
      () =>
        row('pilot_corpus_owner_decision', {
          ...owner,
          id: 'bad-owner',
          request_id: 'other',
          request_json: J({ resourceId: 'corpus2' }),
        }),
      /R6_REQUEST_SCOPE/,
    );
  });
  for (let i = 0; i < 2; i++)
    await row('pilot_corpus_snapshot_member', {
      snapshot_id: 'snap1',
      member_ordinal: i,
      target_index: i,
      coverage_identity: i ? '林' : '木',
      character_id: 'char' + i,
      lesson_version: 'fixture-v1',
      source_evidence_id: 'source2',
      package_eligible: 1,
      coverage_status: 'excluded',
      chunk_request_id: 'chunk',
    });
  await exec(
    "UPDATE pilot_corpus_snapshot SET status='sealed',sealed_at=0,seal_request_id='seal',seal_request_json='{}',seal_request_digest=?,seal_ack_json='{}' WHERE id='snap1'",
    [D],
  );
  const publication = {
    id: 'pub',
    corpus_version: 'corpus1',
    snapshot_id: 'snap1',
    installation_id: 'install',
    namespace_key: 'verify',
    revision: 1,
    status: 'released',
    scope_kind: 'verification',
    actor_id: 'op',
    request_id: 'same',
    request_json: J({ resourceId: 'corpus1' }),
    test_run_id: 'verify',
  };
  await row('pilot_corpus_publication', publication);
  await test('R05-start-assignment-scoped-request', async () => {
    for (let i = 1; i <= 2; i++) {
      const selection = {
        lessonVersion: 'fixture-v1',
        contentDigest: D,
        releaseId: 'pub',
      };
      await row('pilot_corpus_proposal', {
        id: 'proposal' + i,
        child_id: 'child',
        installation_id: 'install',
        corpus_version: 'corpus1',
        policy_version: 'r6-placement-1',
        parent_id: 'parent',
        selection_ordinal: i,
        predecessor_id: i === 1 ? null : 'proposal1',
        predecessor_source_digest: i === 1 ? null : D,
        source_json: J({ selection }),
        expires_at: 86400000,
        test_run_id: 'verify',
      });
      await row('pilot_corpus_plan', {
        id: 'plan' + i,
        proposal_id: 'proposal' + i,
        child_id: 'child',
        installation_id: 'install',
        corpus_version: 'corpus1',
        parent_id: 'parent',
        policy_version: 'r6-placement-1',
        test_run_id: 'verify',
      });
      await row('pilot_corpus_plan_item', {
        id: 'item' + i,
        plan_id: 'plan' + i,
        child_id: 'child',
        installation_id: 'install',
        corpus_version: 'corpus1',
        publication_id: 'pub',
        lesson_version: 'fixture-v1',
      });
      await row('pilot_corpus_assignment', {
        id: 'assignment' + i,
        plan_item_id: 'item' + i,
        child_id: 'child',
        installation_id: 'install',
        corpus_version: 'corpus1',
        lesson_version: 'fixture-v1',
        publication_id: 'pub',
        test_run_id: 'verify',
      });
      await row('pilot_corpus_schedule', {
        id: 'schedule' + i,
        assignment_id: 'assignment' + i,
        child_id: 'child',
        installation_id: 'install',
        kind: 'initial',
        policy_version: 'r6-review-24h-7d-1',
      });
      await row('pilot_corpus_run', {
        id: 'run' + i,
        assignment_id: 'assignment' + i,
        schedule_id: 'schedule' + i,
        child_id: 'child',
        installation_id: 'install',
        corpus_version: 'corpus1',
        lesson_version: 'fixture-v1',
        publication_id: 'pub',
        adapter_id: 'corpus-paired',
        adapter_version: 'corpus-paired-v1',
        phase: 'initial',
        start_request_id: 'same',
        test_run_id: 'verify',
      });
    }
    assert.equal(
      Number((await exec('SELECT count(*) n FROM pilot_corpus_run')).rows[0].n),
      2,
    );
    assert.equal((await exec('PRAGMA foreign_key_check')).rows.length, 0);
  });
} catch (e) {
  report.failure = e.message;
  process.exitCode = 1;
} finally {
  client.close();
  await fs.rm(work, { recursive: true, force: true });
  report.cleanup = { closed: true, removed: true };
  report.finishedAt = Date.now();
  report.sourceUnchanged = sha(await fs.readFile(p)) === hash;
  await fs.writeFile(path.join(out, 'report.json'), J(report, null, 2));
  console.log(J(report.cases));
  if (report.failure) console.log(report.failure);
}
