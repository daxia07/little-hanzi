/** Independent pure guard/schema probes; no database or application mock. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFreshStorySnapshot } from '../../scripts/pilot-story-libsql-backup.mjs';
import { PILOT_V4_TABLES } from '../../scripts/pilot-backup.mjs';
import {
  assertStorySchema,
  storySchemaSource,
} from '../../scripts/pilot-story-schema.mjs';
function tables() {
  return Object.fromEntries(
    PILOT_V4_TABLES.map((t) => [
      t,
      t === 'pilot_curriculum_registry_state'
        ? [{ id: 1, revision: 0, updated_at: 0 }]
        : [],
    ]),
  );
}
function boundary() {
  return {
    destination: {
      installationId: 'fresh-install',
      sessionCount: 0,
      verificationCount: 0,
      tables: tables(),
    },
    source: { sourceInstallationId: 'source-install', tables: tables() },
  };
}
test('pure freshness guard accepts empty distinct installation and refuses existing sessions/facts', () => {
  const { source, destination } = boundary();
  assert.doesNotThrow(() => assertFreshStorySnapshot(destination, source));
  assert.throws(
    () => assertFreshStorySnapshot({ ...destination, sessionCount: 1 }, source),
    { code: 'RESTORE_DESTINATION_NOT_FRESH' },
  );
  destination.tables.pilot_learning_plan.push({ id: 'already-populated' });
  assert.throws(() => assertFreshStorySnapshot(destination, source), {
    code: 'RESTORE_DESTINATION_NOT_FRESH',
  });
});
for (const [name, table, row] of [
  [
    'unpublished proof target',
    'pilot_curriculum_proof_receipt',
    {
      receipt_json: JSON.stringify({
        targetInstallationId: 'fresh-install',
        evidenceInstallationId: 'evidence-install',
      }),
    },
  ],
  [
    'proof evidence installation',
    'pilot_curriculum_proof_receipt',
    {
      receipt_json: JSON.stringify({
        targetInstallationId: 'target-install',
        evidenceInstallationId: 'fresh-install',
      }),
    },
  ],
  [
    'unpublished owner target',
    'pilot_curriculum_owner_decision',
    { target_installation_id: 'fresh-install' },
  ],
  [
    'ordinary historical run',
    'pilot_curriculum_learning_run',
    { installation_id: 'fresh-install' },
  ],
  [
    'historical plan',
    'pilot_learning_plan',
    { installation_id: 'fresh-install' },
  ],
]) {
  if (typeof name !== 'string') throw new Error('Invalid review case name');
  test(`pure freshness guard refuses reused ${name}`, () => {
    const { source, destination } = boundary();
    source.tables[table].push(row);
    assert.throws(() => assertFreshStorySnapshot(destination, source), {
      code: 'RESTORE_DESTINATION_NOT_FRESH',
    });
  });
}
test('trusted schema parser is read-only and rejects missing/drifted schema objects and migrations', () => {
  const source = storySchemaSource(),
    payload = {
      migrations: source.migrations,
      schema: structuredClone(source.schema),
    };
  assert.doesNotThrow(() => assertStorySchema(payload, source));
  assert.throws(() =>
    assertStorySchema({ ...payload, schema: payload.schema.slice(1) }, source),
  );
  const drift = structuredClone(payload);
  drift.schema.find((s) => s.name === 'pilot_curriculum_learning_event').sql =
    drift.schema
      .find((s) => s.name === 'pilot_curriculum_learning_event')
      .sql.replace('sequence>=1', 'sequence>=0');
  assert.throws(() => assertStorySchema(drift, source));
  assert.throws(() =>
    assertStorySchema(
      { ...payload, migrations: payload.migrations.slice(0, 5) },
      source,
    ),
  );
});
