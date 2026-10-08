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
const D = 'sha256:' + 'a'.repeat(64),
  J = JSON.stringify,
  sha = (b) => createHash('sha256').update(b).digest('hex');
const file =
    'outputs/implementation/readiness-r6/backend/0007-corpus-learning.sql',
  newSql = await fs.readFile(file, 'utf8');
assert.equal(
  sha(newSql),
  '8360c2dff5612a66a926b08866d227f40d8751ad4121e751e071ce689e27aec8',
);
const oldSql = newSql
  .replace(
    'EXISTS(SELECT 1 FROM pilot_installation WHERE id=1) AND (s.installation_id!=(SELECT installation_id FROM pilot_installation WHERE id=1) OR s.evidence_epoch=(SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1))',
    's.evidence_epoch=(SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1)',
  )
  .replace(
    '(s.installation_id!=(SELECT installation_id FROM pilot_installation WHERE id=1) OR NOT EXISTS(SELECT 1 FROM pilot_corpus_source_evidence later WHERE later.supersedes_id=source.id))',
    'NOT EXISTS(SELECT 1 FROM pilot_corpus_source_evidence later WHERE later.supersedes_id=source.id)',
  )
  .replace(
    ' OR NOT EXISTS(SELECT 1 FROM pilot_installation WHERE id=1)\n OR (NEW.installation_id=(SELECT installation_id FROM pilot_installation WHERE id=1) AND NEW.evidence_epoch!=(SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1))',
    ' OR NEW.evidence_epoch!=(SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1)',
  );
assert.equal(
  sha(oldSql),
  '4907c40484d03ecee3f654ebf9ab05f8dddf44360574bef16a28c9a14660e880',
);
const out = path.join(root, 'outputs/qa/readiness-r6/historical-constraints-2');
await fs.mkdir(out, { recursive: false });
await fs.writeFile(path.join(out, '4907-reviewed-source.sql'), oldSql);
await fs.writeFile(path.join(out, '8360-reviewed-source.sql'), newSql);
const report = {
  startedAt: Date.now(),
  oldHash: sha(oldSql),
  newHash: sha(newSql),
  cases: [],
  owned: [],
};
async function fixture(sql, label, fn) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'hanzi-r6-history-'));
  await fs.writeFile(path.join(work, '.hanzi-qa-owned'), label);
  const db = createClient({ url: 'file:' + path.join(work, 'fresh.db') });
  const exec = (sql, args = []) => db.execute({ sql, args });
  async function row(t, o) {
    const v = {};
    for (const c of (await exec('PRAGMA table_info(' + t + ')')).rows)
      if (c.notnull)
        v[c.name] =
          c.type === 'INTEGER'
            ? 0
            : c.name.endsWith('_digest')
              ? D
              : c.name.endsWith('_json')
                ? '{}'
                : 'fixture';
    Object.assign(v, o);
    const k = Object.keys(v);
    return exec(
      'INSERT INTO ' +
        t +
        '(' +
        k.join(',') +
        ') VALUES(' +
        k.map(() => '?').join(',') +
        ')',
      k.map((x) => v[x]),
    );
  }
  try {
    await applyLibsqlMigrations({ client: db, root });
    await db.executeMultiple(sql);
    const current = (
      await exec('SELECT installation_id FROM pilot_installation WHERE id=1')
    ).rows[0].installation_id;
    assert.equal(typeof current, 'string');
    report.engine = (await exec('SELECT sqlite_version() v')).rows[0].v;
    await row('pilot_auth_user', {
      id: 'op',
      name: 'Synthetic',
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
      batch_version: 'batch',
      actor_id: 'op',
      installation_id: current,
      request_id: 'batch',
      request_json: J({ resourceId: 'corpus' }),
    });
    await row('pilot_corpus', {
      corpus_version: 'corpus',
      corpus_id: 'corpus',
      policy_version: 'r6-corpus-policy-1',
      imported_by: 'op',
    });
    await row('pilot_corpus_item', {
      corpus_version: 'corpus',
      lesson_version: 'fixture-v1',
      batch_id: 'batch',
      track_id: 'track',
      sequence: 1,
      adapter_id: 'corpus-paired',
      adapter_version: 'corpus-paired-v1',
    });
    const source = {
      id: 'source',
      lesson_version: 'fixture-v1',
      classification: 'verification-fixture',
      lineage_id: 'source',
      source_ordinal: 1,
      actor_id: 'op',
      installation_id: current,
      request_id: 'source',
      request_json: J({ resourceId: 'corpus' }),
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
        corpus_version: 'corpus',
        lesson_version: 'fixture-v1',
        character_id: 'char' + i,
        target_index: i,
        coverage_identity: i ? '林' : '木',
        identity_version: 'r6-coverage-identity-1',
        source_evidence_id: 'source',
      });
    }
    const epoch = async () =>
      Number(
        (await exec('SELECT revision FROM pilot_corpus_evidence_epoch')).rows[0]
          .revision,
      );
    const originalEpoch = await epoch();
    await row('pilot_corpus_source_evidence', {
      ...source,
      id: 'successor',
      source_ordinal: 2,
      supersedes_id: 'source',
      request_id: 'successor',
      request_json: J({
        resourceId: 'corpus',
        request: { expectedEvidenceDigest: D },
      }),
      evidence_digest: 'sha256:' + 'b'.repeat(64),
    });
    const snap = async (id, install, e = originalEpoch) =>
      row('pilot_corpus_snapshot', {
        id,
        corpus_version: 'corpus',
        installation_id: install,
        candidate_id: 'candidate',
        evidence_epoch: e,
        plan_json: J({ lane: 'ordinary' }),
        expected_included_count: 0,
        expected_exclusion_count: 2,
        expected_package_count: 0,
        status: 'building',
        created_by: 'op',
        request_id: id,
        request_json: J({ resourceId: 'corpus' }),
      });
    const member = (id, i, o = {}) =>
      row('pilot_corpus_snapshot_member', {
        snapshot_id: id,
        member_ordinal: i,
        target_index: i,
        coverage_identity: i ? '林' : '木',
        character_id: 'char' + i,
        lesson_version: 'fixture-v1',
        source_evidence_id: 'source',
        package_eligible: 0,
        coverage_status: 'excluded',
        chunk_request_id: 'chunk',
        ...o,
      });
    const seal = (id) =>
      exec(
        "UPDATE pilot_corpus_snapshot SET status='sealed',sealed_at=0,seal_request_id='seal',seal_request_json='{}',seal_request_digest=?,seal_ack_json='{}' WHERE id=?",
        [D, id],
      );
    await fn({
      db,
      exec,
      row,
      current,
      epoch,
      originalEpoch,
      snap,
      member,
      seal,
    });
    assert.equal((await exec('PRAGMA foreign_key_check')).rows.length, 0);
  } finally {
    db.close();
    await fs.rm(work, { recursive: true, force: true });
    report.owned.push({ work, closed: true, removed: true });
  }
}
async function test(id, fn) {
  try {
    await fn();
    report.cases.push({ id, outcome: 'PASS' });
  } catch (e) {
    report.cases.push({ id, outcome: 'FAIL', error: e.message });
    throw e;
  }
}
try {
  await test('H01-retained490-historical-refusal', () =>
    fixture(oldSql, 'old490', async (f) => {
      await f.snap('historical', 'old-install');
      await assert.rejects(
        () => f.member('historical', 0),
        /R6_SNAPSHOT_BINDING/,
      );
      report.retainedRed = {
        expectedHistoricalSuccess: false,
        actualError: 'R6_SNAPSHOT_BINDING',
        oldEpoch: f.originalEpoch,
        currentEpoch: await f.epoch(),
      };
    }));
  await test('H02-836-historical-snapshot-success', () =>
    fixture(newSql, 'new836', async (f) => {
      await f.snap('historical', 'old-install');
      for (let i = 0; i < 2; i++) await f.member('historical', i);
      await f.seal('historical');
      assert.equal(
        (
          await f.exec(
            "SELECT status FROM pilot_corpus_snapshot WHERE id='historical'",
          )
        ).rows[0].status,
        'sealed',
      );
    }));
  await test('H03-current-epoch-and-source-head-refusal', () =>
    fixture(newSql, 'current', async (f) => {
      await f.snap('stale', f.current);
      await assert.rejects(() => f.member('stale', 0), /R6_SNAPSHOT_BINDING/);
      await f.snap('old-head', f.current, await f.epoch());
      await assert.rejects(
        () => f.member('old-head', 0),
        /R6_SNAPSHOT_BINDING/,
      );
      await f.snap('seal-stale', f.current, await f.epoch());
      for (let i = 0; i < 2; i++)
        await f.member('seal-stale', i, { source_evidence_id: 'successor' });
      await f.exec(
        'UPDATE pilot_corpus_evidence_epoch SET revision=revision+1',
      );
      await assert.rejects(
        () => f.seal('seal-stale'),
        /R6_SNAPSHOT_INCOMPLETE/,
      );
    }));
  await test('H04-missing-singleton-fail-closed', () =>
    fixture(newSql, 'missing', async (f) => {
      await f.snap('no-singleton', 'old-install');
      /* inherited pilot_installation has no deletion/identity trigger or inbound FK; removing owned bookkeeping models corrupt absent singleton, not trigger bypass */ await f.exec(
        'DELETE FROM pilot_installation WHERE id=1',
      );
      await assert.rejects(
        () => f.member('no-singleton', 0),
        /R6_SNAPSHOT_BINDING/,
      );
      await assert.rejects(
        () => f.seal('no-singleton'),
        /R6_SNAPSHOT_INCOMPLETE/,
      );
    }));
  await test('H05-historical-static-binding-and-count-refusal', () =>
    fixture(newSql, 'static', async (f) => {
      await f.snap('bad-static', 'old-install');
      await assert.rejects(
        () => f.member('bad-static', 0, { character_id: 'foreign' }),
        /R6_SNAPSHOT_BINDING/,
      );
      await f.member('bad-static', 0);
      await assert.rejects(
        () => f.seal('bad-static'),
        /R6_SNAPSHOT_INCOMPLETE/,
      );
    }));
  await test('H06-current-dual-target-and-original-receipt', () =>
    fixture(newSql, 'current-valid', async (f) => {
      await f.snap('current-valid', f.current, await f.epoch());
      await assert.rejects(
        () =>
          f.member('current-valid', 0, {
            source_evidence_id: 'successor',
            coverage_status: 'included',
          }),
        /CHECK/,
      );
      for (let i = 0; i < 2; i++)
        await f.member('current-valid', i, { source_evidence_id: 'successor' });
      await f.seal('current-valid');
      await assert.rejects(
        () =>
          f.exec(
            "UPDATE pilot_corpus_snapshot SET ack_json='{\"changed\":true}' WHERE id='current-valid'",
          ),
        /IMMUTABLE_R6_FACT|R6_SNAPSHOT_INCOMPLETE/,
      );
    }));
  await test('H07-current-proof-target-refusal-with-fresh-epoch', () =>
    fixture(newSql, 'proof-target', async (f) => {
      const envelope = {
        schemaVersion: 'r6-proof-receipt-1',
        policyVersion: 'r6-corpus-proof-1',
        syntheticOnly: true,
        receiptId: 'foreign-proof',
        issuerId: 'issuer',
        namespace: 'evidence',
        corpusVersion: 'corpus',
        corpusDigest: D,
        lessonVersion: 'fixture-v1',
        contentDigest: D,
        targetInstallationId: 'foreign',
      };
      await f.row('pilot_corpus_proof_receipt', {
        id: 'foreign-proof',
        corpus_version: 'corpus',
        lesson_version: 'fixture-v1',
        issuer_id: 'issuer',
        receipt_version: 'r6-proof-receipt-1',
        received_by: 'op',
        installation_id: 'foreign',
        namespace: 'evidence',
        receipt_json: J(envelope),
      });
      await f.snap('proof-scope', f.current, await f.epoch());
      await assert.rejects(
        () =>
          f.member('proof-scope', 0, {
            source_evidence_id: 'successor',
            proof_id: 'foreign-proof',
          }),
        /R6_SNAPSHOT_BINDING/,
      );
    }));
} catch (e) {
  report.failure = e.message;
  process.exitCode = 1;
} finally {
  report.finishedAt = Date.now();
  report.sourceUnchanged = sha(await fs.readFile(file)) === sha(newSql);
  await fs.writeFile(path.join(out, 'report.json'), J(report, null, 2));
  console.log(
    J({ cases: report.cases, failure: report.failure, owned: report.owned }),
  );
}
