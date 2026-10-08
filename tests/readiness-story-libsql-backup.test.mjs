import test from 'node:test';
import assert from 'node:assert/strict';
import { PILOT_V4_TABLES } from '../scripts/pilot-backup.mjs';
import { assertFreshStorySnapshot } from '../scripts/pilot-story-libsql-backup.mjs';

const fresh = () => ({
  installationId: 'new-install',
  sessionCount: 0,
  verificationCount: 0,
  tables: Object.fromEntries(
    PILOT_V4_TABLES.map((table) => [
      table,
      table === 'pilot_curriculum_registry_state'
        ? [{ id: 1, revision: 0, updated_at: 0 }]
        : [],
    ]),
  ),
});
test('[R3-E-017] restore refuses populated destinations, old installation identity and retained sessions', () => {
  const source = {
    sourceInstallationId: 'old-install',
    tables: {
      pilot_curriculum_publication: [],
      pilot_curriculum_runtime_run: [],
    },
  };
  assert.doesNotThrow(() => assertFreshStorySnapshot(fresh(), source));
  for (const mutate of [
    (value) => {
      value.tables.pilot_auth_user.push({ id: 'existing-family' });
    },
    (value) => {
      value.tables.pilot_curriculum_learning_event.push({
        id: 'existing-answer',
      });
    },
    (value) => {
      value.sessionCount = 1;
    },
    (value) => {
      value.verificationCount = 1;
    },
    (value) => {
      value.installationId = 'old-install';
    },
    (value) => {
      value.tables.pilot_curriculum_registry_state[0].revision = 1;
    },
  ]) {
    const snapshot = fresh();
    mutate(snapshot);
    assert.throws(
      () => assertFreshStorySnapshot(snapshot, source),
      /RESTORE_DESTINATION_NOT_FRESH/,
    );
  }
  assert.throws(
    () =>
      assertFreshStorySnapshot(fresh(), {
        ...source,
        tables: {
          ...source.tables,
          pilot_curriculum_publication: [{ installation_id: 'new-install' }],
        },
      }),
    /RESTORE_DESTINATION_NOT_FRESH/,
  );
});
