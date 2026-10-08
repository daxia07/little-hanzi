import { legacyCollectionRoot } from './helpers/legacy-pilot-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { applyLibsqlMigrations } from '../scripts/pilot-libsql-admin.mjs';
import * as old from '../scripts/pilot-story-libsql-backup.mjs';
const root = legacyCollectionRoot(
  fileURLToPath(new URL('../', import.meta.url)),
);
const version5 = new URL(
  '../scripts/pilot-collection-libsql-backup.mjs',
  import.meta.url,
);
const api = fs.existsSync(version5)
  ? await import(version5.href)
  : {
      createCollectionBackupPayload: old.createStoryBackupPayload,
      restoreCollectionBackupPayload: old.restoreStoryBackupPayload,
      captureCollectionLibsql: old.captureStoryLibsql,
    };

test('[R5-E-012] real seven-migration database captures45 tables and restores only into a fresh new installation', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-archive-author-'));
  fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), 'r5-archive-author');
  const source = createClient({ url: 'file:' + path.join(work, 'source.db') }),
    target = createClient({ url: 'file:' + path.join(work, 'target.db') });
  try {
    for (const [client, id] of [
      [source, 'archive-source'],
      [target, 'archive-target'],
    ]) {
      assert.equal(
        (await applyLibsqlMigrations({ client, root })).migrationCount,
        7,
      );
      await client.execute({
        sql: 'UPDATE pilot_installation SET installation_id=? WHERE id=1',
        args: [id],
      });
    }
    await source.execute(
      "INSERT INTO pilot_auth_user(id,name,email,email_verified,created_at,updated_at,username,display_username,role,must_change_password,disabled) VALUES('operator','Synthetic operator','archive@example.test',0,0,0,'operator','operator','operator',0,0)",
    );
    const archive = await api.createCollectionBackupPayload({
      sourceRoot: root,
      candidateId: 'r5-archive-author',
      client: source,
      installationId: 'archive-source',
    });
    assert.equal(archive.payload.format, 'pilot-admin-backup-5');
    assert.equal(Object.keys(archive.payload.tables).length, 45);
    assert.equal(archive.payload.tables.pilot_auth_user[0].id, 'operator');
    assert.equal(
      Object.hasOwn(archive.payload.tables, 'pilot_auth_session'),
      false,
    );
    const restored = await api.restoreCollectionBackupPayload({
      sourceRoot: root,
      archive,
      client: target,
      installationId: 'archive-target',
    });
    assert.equal(restored.commit, 'confirmed');
    assert.equal(
      (await api.captureCollectionLibsql(target, 'archive-target')).tables
        .pilot_auth_user[0].id,
      'operator',
    );
    await assert.rejects(
      () =>
        api.restoreCollectionBackupPayload({
          sourceRoot: root,
          archive,
          client: target,
          installationId: 'archive-target',
        }),
      /RESTORE_DESTINATION_NOT_FRESH/,
    );
    let queried = false;
    await assert.rejects(
      () =>
        api.restoreCollectionBackupPayload({
          sourceRoot: root,
          archive: { ...archive, sha256: '0'.repeat(64) },
          client: {
            execute() {
              queried = true;
            },
            batch() {
              queried = true;
            },
          },
          installationId: 'other',
        }),
      /BACKUP_CHECKSUM_INVALID/,
    );
    assert.equal(queried, false);
  } finally {
    source.close();
    target.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

const { withCollectionFixture, populateCollectionVisits } =
  await import('./helpers/collection-store-fixture.mjs');
test('[R5-E-012] genuine three-visit facts populate all ten collection tables and survive semantic45-table restore', async () => {
  await withCollectionFixture(async (e) => {
    const facts = await populateCollectionVisits(e);
    const archive = await api.createCollectionBackupPayload({
      sourceRoot: root,
      candidateId: 'r5-populated-author',
      client: e.client,
      installationId: 'r5-install',
    });
    for (const [name, rows] of Object.entries(archive.payload.tables).filter(
      ([name]) => name.startsWith('pilot_collection'),
    ))
      assert(rows.length > 0, name);
    assert.equal(archive.payload.tables.pilot_collection_run.length, 3);
    assert.equal(
      archive.payload.tables.pilot_collection_assignment[0].id,
      facts.assignmentId,
    );
    const work = fs.mkdtempSync(
      path.join(os.tmpdir(), 'r5-populated-restore-'),
    );
    fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), 'r5-populated-author');
    const target = createClient({ url: 'file:' + path.join(work, 'fresh.db') });
    try {
      await applyLibsqlMigrations({ client: target, root });
      const install = (
        await target.execute(
          'SELECT installation_id FROM pilot_installation WHERE id=1',
        )
      ).rows[0].installation_id;
      assert(typeof install === 'string');
      const result = await api.restoreCollectionBackupPayload({
        sourceRoot: root,
        archive,
        client: target,
        installationId: install,
      });
      assert.equal(result.commit, 'confirmed');
      assert.equal(
        (
          await target.execute(
            'SELECT COUNT(*) AS n FROM pilot_collection_run WHERE completed_at IS NOT NULL',
          )
        ).rows[0].n,
        3,
      );
      assert.equal(
        (await target.execute('SELECT COUNT(*) AS n FROM pilot_auth_session'))
          .rows[0].n,
        0,
      );
    } finally {
      target.close();
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});

const { publishCollection } = await import('../lib/pilot/collection-store.ts');
const { validatePilotCollectionBackup } =
  await import('../scripts/pilot-collection-backup.mjs');
test('[R5-E-012][V5-HISTORY-01] real withdrawal preserves older visits but forged history after withdrawal is refused', async () => {
  await withCollectionFixture(async (e) => {
    await populateCollectionVisits(e);
    const pub = (
      await e.client.execute(
        "SELECT * FROM pilot_curriculum_publication WHERE lesson_version='path-01-v1'",
      )
    ).rows[0];
    const input = JSON.parse(pub.request_json).request;
    e.config.curriculumTestNow = String(Number(e.config.curriculumTestNow) + 1);
    const withdrawal = await publishCollection(e.operator, 'path-01-v1', {
      ...input,
      requestId: 'withdraw-after-visits',
      expectedRevision: 1,
      predecessorId: pub.id,
      status: 'withdrawn',
    });
    const archive = await api.createCollectionBackupPayload({
      sourceRoot: root,
      candidateId: 'r5-withdrawal-author',
      client: e.client,
      installationId: 'r5-install',
      createdAtMs: Number(e.config.curriculumTestNow),
    });
    await assert.doesNotReject(() =>
      validatePilotCollectionBackup(archive.payload),
    );
    const impossible = structuredClone(archive.payload),
      at = pub.created_at + 1;
    impossible.tables.pilot_curriculum_publication.find(
      (p) => p.id === withdrawal.publicationId,
    ).created_at = at;
    impossible.tables.pilot_curriculum_publication_audit.find(
      (p) => p.publication_id === withdrawal.publicationId,
    ).created_at = at;
    await assert.rejects(
      () => validatePilotCollectionBackup(impossible),
      /BACKUP_COLLECTION_INVALID/,
    );
  });
});
