// Independent structural SQL fixture only; no human/source eligibility claim.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { applyLibsqlMigrations } from '../../scripts/pilot-libsql-admin.mjs';
const root = process.cwd(),
  dependency =
    '/private/var/folders/hr/l9ynfm_j31g54lqlsqychm0m0000gp/T/hanzi-r2-dependencies-a2tj4rrw/node_modules/@libsql/client';
const { createClient } = await import(
  pathToFileURL(path.join(dependency, 'lib-esm/node.js'))
);
const work = await fs.mkdtemp(
  path.join(os.tmpdir(), 'hanzi-r6-independent-sql-'),
);
await fs.writeFile(path.join(work, '.hanzi-qa-owned'), 'r6-independent-sql-1');
const output = path.join(root, 'outputs/qa/readiness-r6/sql-constraints-4');
await fs.mkdir(output, { recursive: false });
const sqlPath =
    'outputs/implementation/readiness-r6/backend/0007-corpus-learning.sql',
  sql = await fs.readFile(sqlPath, 'utf8'),
  hash = createHash('sha256').update(sql).digest('hex');
assert.equal(
  hash,
  '370910c4a6c020a460471a6a9561e7d338d9339c3116264e02d69f51ddab0b13',
);
const client = createClient({ url: 'file:' + path.join(work, 'fresh.db') });
const D = 'sha256:' + 'a'.repeat(64),
  J = JSON.stringify,
  report = {
    schemaVersion: 'r6-sql-constraints-1',
    work,
    sourceHash: hash,
    startedAt: Date.now(),
    cases: [],
    scope:
      'embedded libSQL structural fixtures only; no HTTP/signature/human evidence',
  };
const exec = async (sql, args = []) => client.execute({ sql, args });
async function row(table, overrides) {
  const info = (await exec('PRAGMA table_info(' + table + ')')).rows;
  const values = {};
  for (const c of info) {
    if (c.notnull) {
      values[c.name] =
        c.type === 'INTEGER'
          ? 0
          : c.name.endsWith('_digest')
            ? D
            : c.name.endsWith('_json')
              ? '{}'
              : 'fixture';
    }
  }
  Object.assign(values, overrides);
  const keys = Object.keys(values);
  return exec(
    'INSERT INTO ' +
      table +
      '(' +
      keys.join(',') +
      ') VALUES(' +
      keys.map(() => '?').join(',') +
      ')',
    keys.map((k) => values[k]),
  );
}
async function test(id, fn) {
  try {
    await fn();
    report.cases.push({ id, outcome: 'PASS' });
  } catch (e) {
    report.cases.push({ id, outcome: 'FAIL', error: e.message });
    await fs.writeFile(path.join(output, 'report.json'), J(report, null, 2));
    throw e;
  }
}
async function denied(fn, pattern) {
  await assert.rejects(fn, pattern);
}
const epoch = async () =>
  Number(
    (await exec('SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1'))
      .rows[0].revision,
  );
try {
  await applyLibsqlMigrations({ client, root });
  await client.executeMultiple(sql);
  report.engine = (
    await exec('SELECT sqlite_version() AS version')
  ).rows[0].version;
  report.clientVersion = JSON.parse(
    await fs.readFile(path.join(dependency, 'package.json'), 'utf8'),
  ).version;
  await test('S01-schema-and-FKs', async () => {
    assert.equal(
      Number(
        (
          await exec(
            "SELECT count(*) n FROM sqlite_master WHERE type='table' AND (name='pilot_corpus' OR name LIKE 'pilot_corpus_%')",
          )
        ).rows[0].n,
      ),
      23,
    );
    assert.equal((await exec('PRAGMA foreign_key_check')).rows.length, 0);
    assert.equal(
      Number((await exec('PRAGMA foreign_keys')).rows[0].foreign_keys),
      1,
    );
  });
  await row('pilot_auth_user', {
    id: 'op',
    name: 'Synthetic operator',
    email: 'op@example.test',
    username: 'op',
    display_username: 'op',
    role: 'operator',
  });
  await row('pilot_curriculum_package', {
    lesson_version: 'fixture-v1',
    lesson_id: 'fixture',
    canonicalization_version: 's3-json-1',
    manifest_json: J({ renderer: { adapterId: 'corpus-paired' } }),
    import_id: 'import',
    imported_by_user_id: 'op',
  });
  await row('pilot_corpus_batch', {
    id: 'batch',
    batch_version: 'batch-v1',
    actor_id: 'op',
    installation_id: 'install',
    request_id: 'batch-request',
  });
  await row('pilot_corpus', {
    corpus_version: 'corpus-v1',
    corpus_id: 'corpus',
    policy_version: 'r6-corpus-policy-1',
    imported_by: 'op',
  });
  await row('pilot_corpus_item', {
    corpus_version: 'corpus-v1',
    lesson_version: 'fixture-v1',
    batch_id: 'batch',
    track_id: 'track',
    sequence: 1,
    adapter_id: 'corpus-paired',
    adapter_version: 'corpus-paired-v1',
    title: 'Synthetic',
  });
  const source = {
    id: 'source',
    lesson_version: 'fixture-v1',
    classification: 'verification-fixture',
    lineage_id: 'source',
    source_ordinal: 1,
    actor_id: 'op',
    installation_id: 'install',
    request_id: 'source-request',
  };
  await row('pilot_corpus_source_evidence', source);
  for (let i = 0; i < 2; i++) {
    await row('pilot_curriculum_character', {
      lesson_version: 'fixture-v1',
      character_id: 'char' + i,
      hanzi: i ? '林' : '木',
      character_index: i,
    });
    await row('pilot_corpus_character', {
      corpus_version: 'corpus-v1',
      lesson_version: 'fixture-v1',
      character_id: 'char' + i,
      target_index: i,
      coverage_identity: i ? '林' : '木',
      identity_version: 'r6-coverage-identity-1',
      source_evidence_id: 'source',
    });
  }
  await test('S02-source-causal-and-no-promotion', async () => {
    await denied(
      () =>
        row('pilot_corpus_source_evidence', {
          ...source,
          id: 'bad-source',
          source_ordinal: 2,
          supersedes_id: 'source',
          classification: 'real-source-reviewed',
          request_id: 'bad',
          request_json: J({ request: { expectedEvidenceDigest: D } }),
        }),
      /R6_SOURCE_STALE/,
    );
    await row('pilot_corpus_source_evidence', {
      ...source,
      id: 'next-source',
      evidence_digest: 'sha256:' + 'b'.repeat(64),
      source_ordinal: 2,
      supersedes_id: 'source',
      request_id: 'next',
      request_json: J({ request: { expectedEvidenceDigest: D } }),
    });
    await denied(
      () =>
        row('pilot_corpus_source_evidence', {
          ...source,
          id: 'branch',
          evidence_digest: 'sha256:' + 'c'.repeat(64),
          source_ordinal: 2,
          supersedes_id: 'source',
          request_id: 'branch',
          request_json: J({ request: { expectedEvidenceDigest: D } }),
        }),
      /R6_SOURCE_STALE|UNIQUE/,
    );
  });
  await test('S02b-inherited-review-epoch', async () => {
    const before = await epoch();
    await row('pilot_curriculum_review', {
      review_id: 'review',
      lesson_version: 'fixture-v1',
      review_sequence: 1,
      decision: 'rejected',
      reviewer_ref: 'SIMULATED',
      reviewed_at: 0,
      recorded_at: 10,
      checklist_version: 'hanzi-review-1',
      recorded_by_user_id: 'op',
      write_id: 'review-write',
    });
    assert.equal(await epoch(), before + 1);
  });
  const snapshot = {
    id: 'snapshot',
    corpus_version: 'corpus-v1',
    installation_id: 'install',
    candidate_id: 'candidate',
    evidence_epoch: await epoch(),
    plan_json: J({ lane: 'ordinary' }),
    expected_included_count: 0,
    expected_exclusion_count: 2,
    expected_package_count: 0,
    status: 'building',
    created_by: 'op',
    request_id: 'begin',
  };
  await test('S03-building-only-and-original-ack', async () => {
    await denied(
      () =>
        row('pilot_corpus_snapshot', {
          ...snapshot,
          id: 'sealed-insert',
          status: 'sealed',
          sealed_at: 0,
          seal_request_id: 'seal',
          seal_request_json: '{}',
          seal_request_digest: D,
          seal_ack_json: '{}',
          request_id: 'sealed',
        }),
      /R6_SNAPSHOT_INITIAL/,
    );
    await row('pilot_corpus_snapshot', snapshot);
    await denied(
      () =>
        exec(
          "UPDATE pilot_corpus_snapshot SET ack_json='{\"changed\":true}' WHERE id='snapshot'",
        ),
      /IMMUTABLE_R6_FACT|R6_SNAPSHOT_INCOMPLETE/,
    );
  });
  const member = (i) => ({
    snapshot_id: 'snapshot',
    member_ordinal: i,
    target_index: i,
    coverage_identity: i ? '林' : '木',
    character_id: 'char' + i,
    lesson_version: 'fixture-v1',
    source_evidence_id: 'next-source',
    package_eligible: 0,
    coverage_status: 'excluded',
    chunk_request_id: 'chunk',
  });
  await test('S04-excluded-null-and-included-denial', async () => {
    await denied(
      () =>
        row('pilot_corpus_snapshot_member', {
          ...member(0),
          coverage_status: 'included',
        }),
      /CHECK/,
    );
    await row('pilot_corpus_snapshot_member', member(0));
    await row('pilot_corpus_snapshot_member', member(1));
  });
  const receipt = {
    id: 'proof',
    corpus_version: 'corpus-v1',
    lesson_version: 'fixture-v1',
    issuer_id: 'issuer',
    receipt_version: 'r6-proof-receipt-1',
    received_by: 'op',
    installation_id: 'install',
    namespace: 'signed-evidence',
  };
  const envelope = {
    schemaVersion: 'r6-proof-receipt-1',
    policyVersion: 'r6-corpus-proof-1',
    syntheticOnly: true,
    receiptId: 'proof',
    issuerId: 'issuer',
    namespace: 'signed-evidence',
    corpusVersion: 'corpus-v1',
    corpusDigest: D,
    lessonVersion: 'fixture-v1',
    contentDigest: D,
    targetInstallationId: 'install',
  };
  await test('S05-receipt-null-and-identity-guard', async () => {
    await denied(
      () =>
        row('pilot_corpus_proof_receipt', { ...receipt, receipt_json: '{}' }),
      /CHECK/,
    );
    await denied(
      () =>
        row('pilot_corpus_proof_receipt', {
          ...receipt,
          receipt_json: J({ ...envelope, targetInstallationId: null }),
        }),
      /CHECK/,
    );
    await row('pilot_corpus_proof_receipt', {
      ...receipt,
      receipt_json: J(envelope),
    });
  });
  await test('S06-stale-epoch-seal-denial', async () => {
    await denied(
      () =>
        exec(
          "UPDATE pilot_corpus_snapshot SET status='sealed',sealed_at=0,seal_request_id='seal',seal_request_json='{}',seal_request_digest=?,seal_ack_json='{}' WHERE id='snapshot'",
          [D],
        ),
      /R6_SNAPSHOT_INCOMPLETE/,
    );
  });
  await test('S06b-foreign-proof-target-denial', async () => {
    const target = {
      ...snapshot,
      id: 'scope-check',
      evidence_epoch: await epoch(),
      request_id: 'scope-check',
    };
    await row('pilot_corpus_snapshot', target);
    await row('pilot_corpus_proof_receipt', {
      ...receipt,
      id: 'foreign-proof',
      installation_id: 'foreign',
      receipt_json: J({
        ...envelope,
        receiptId: 'foreign-proof',
        targetInstallationId: 'foreign',
      }),
    });
    await denied(
      () =>
        row('pilot_corpus_snapshot_member', {
          ...member(0),
          snapshot_id: 'scope-check',
          proof_id: 'foreign-proof',
        }),
      /R6_SNAPSHOT_BINDING/,
    );
  });
  const fresh = {
    ...snapshot,
    id: 'fresh',
    evidence_epoch: await epoch(),
    request_id: 'fresh-begin',
  };
  await row('pilot_corpus_snapshot', fresh);
  for (let i = 0; i < 2; i++)
    await row('pilot_corpus_snapshot_member', {
      ...member(i),
      snapshot_id: 'fresh',
      proof_id: 'proof',
    });
  await test('S07-dual-target-seal', async () => {
    await exec(
      "UPDATE pilot_corpus_snapshot SET status='sealed',sealed_at=0,seal_request_id='seal',seal_request_json='{}',seal_request_digest=?,seal_ack_json='{}' WHERE id='fresh'",
      [D],
    );
    await denied(
      () =>
        row('pilot_corpus_snapshot_member', {
          ...member(0),
          snapshot_id: 'fresh',
          member_ordinal: 3,
        }),
      /R6_SNAPSHOT_BINDING/,
    );
  });
  const publication = {
    id: 'pub',
    corpus_version: 'corpus-v1',
    snapshot_id: 'fresh',
    installation_id: 'install',
    namespace_key: 'verify',
    revision: 1,
    status: 'released',
    scope_kind: 'verification',
    actor_id: 'op',
    request_id: 'release',
    test_run_id: 'verify',
  };
  await test('S08-final-audit-atomic-rollback', async () => {
    await assert.rejects(async () => {
      const tx = await client.transaction('write');
      try {
        /* fully required structural publication values */ const v = {
          ...publication,
          corpus_digest: D,
          scope_json: '{}',
          scope_digest: D,
          request_digest: D,
          request_json: '{}',
          ack_json: '{}',
          created_at: 0,
        };
        await tx.execute({
          sql:
            'INSERT INTO pilot_corpus_publication(' +
            Object.keys(v).join(',') +
            ') VALUES(' +
            Object.keys(v)
              .map(() => '?')
              .join(',') +
            ')',
          args: Object.values(v),
        });
        await tx.execute(
          "INSERT INTO pilot_corpus_publication_audit VALUES('bad','pub','op','withdrawn','release',0)",
        );
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      } finally {
        tx.close();
      }
    }, /R6_AUDIT_BINDING/);
    assert.equal(
      Number(
        (await exec('SELECT count(*) n FROM pilot_corpus_publication')).rows[0]
          .n,
      ),
      0,
    );
  });
  await test('S09-head-composite-reference', async () => {
    await row('pilot_corpus_publication', publication);
    await denied(
      () =>
        row('pilot_corpus_publication_state', {
          corpus_version: 'corpus-v1',
          installation_id: 'other',
          namespace_key: 'verify',
          revision: 1,
          latest_publication_id: 'pub',
        }),
      /FOREIGN KEY/,
    );
    await row('pilot_corpus_publication_state', {
      corpus_version: 'corpus-v1',
      installation_id: 'install',
      namespace_key: 'verify',
      revision: 1,
      latest_publication_id: 'pub',
    });
    await denied(
      () =>
        exec(
          "UPDATE pilot_corpus_publication_state SET revision=3 WHERE corpus_version='corpus-v1'",
        ),
      /R6_HEAD_CAS/,
    );
    assert.equal((await exec('PRAGMA foreign_key_check')).rows.length, 0);
  });
} catch (e) {
  report.failure = e.message;
  process.exitCode = 1;
} finally {
  client.close();
  report.finishedAt = Date.now();
  report.sourceUnchanged =
    createHash('sha256')
      .update(await fs.readFile(sqlPath))
      .digest('hex') === hash;
  await fs.rm(work, { recursive: true, force: true });
  report.cleanup = { clientClosed: true, ownedDirectoryRemoved: true };
  await fs.writeFile(path.join(output, 'report.json'), J(report, null, 2));
  console.log(
    J({
      cases: report.cases,
      failure: report.failure,
      engine: report.engine,
      cleanup: report.cleanup,
    }),
  );
}
