import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pilotBackupFormatForCandidate } from '../scripts/pilot-backup.mjs';
import {
  validateStoryRows,
  validateStorySemantics,
} from '../scripts/pilot-story-backup.mjs';
import { storyBackupFixture } from './helpers/story-backup-fixture.mjs';
import { canonicalPackage } from '../lib/curriculum/digest.ts';

test('[R3-E-017] exact six-migration story candidate selects v4 without changing v1–v3', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-story-format-'));
  const directory = path.join(root, 'db/pilot-migrations');
  fs.mkdirSync(directory, { recursive: true });
  try {
    const names = [
      '0000-auth.sql',
      '0001-data.sql',
      '0002-learning.sql',
      '0003-curriculum.sql',
      '0004-curriculum-runtime.sql',
      '0005-family-story.sql',
    ];
    for (let index = 0; index < names.length; index++) {
      fs.copyFileSync(
        new URL(`../db/pilot-migrations/${names[index]}`, import.meta.url),
        path.join(directory, names[index]),
      );
      if (index >= 2) {
        assert.equal(
          pilotBackupFormatForCandidate({ snapshot: root }),
          `pilot-admin-backup-${index - 1}`,
        );
      }
    }
    fs.writeFileSync(path.join(directory, '0006-unknown.sql'), 'SELECT 1;');
    assert.throws(
      () => pilotBackupFormatForCandidate({ snapshot: root }),
      (error) => error.code === 'BACKUP_VERSION_INCOMPATIBLE',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[R3-E-017] populated new history validates, archived revocation preserves signature, unknown trust refuses', async () => {
  const fixture = await storyBackupFixture();
  const saved = validateStoryRows(fixture.payload);
  await validateStorySemantics(saved, fixture.archiveIssuers);
  await validateStorySemantics(
    saved,
    fixture.archiveIssuers.map((issuer) => ({
      ...issuer,
      revokedAt: 1_790_000_010_000,
    })),
  );
  await assert.rejects(
    () => validateStorySemantics(saved, []),
    (error) => error.code === 'BACKUP_STORY_INVALID',
  );
});

test('[R3-E-017] refuses contradictory plan/publication/start/audit/namespace history before replay', async () => {
  const { payload } = await storyBackupFixture();
  const mutations = [
    (tables) => {
      tables.pilot_learning_plan[0].source_digest = `sha256:${'0'.repeat(64)}`;
    },
    (tables) => {
      tables.pilot_learning_plan_item[0].child_id = 'parent';
    },
    (tables) => {
      tables.pilot_curriculum_publication_state[0].revision = 2;
    },
    (tables) => {
      tables.pilot_curriculum_learning_run[0].start_ack_json = canonicalPackage(
        {
          runId: 'run',
          assignmentId: 'assignment',
          lessonVersion: 'forest-01-v4',
          revision: 1,
        },
      );
    },
    (tables) => {
      tables.pilot_curriculum_learning_audit.pop();
    },
    (tables) => {
      tables.pilot_curriculum_learning_event[0].event_id = 'forged';
    },
    (tables) => {
      tables.pilot_curriculum_assignment[0].test_run_id = null;
    },
    (tables) => {
      tables.pilot_placement_proposal[0].expires_at += 1;
    },
    (tables) => {
      tables.pilot_learning_schedule[0].due_at += 1;
    },
    (tables) => {
      tables.pilot_curriculum_proof_receipt[0].private_key = 'forbidden';
    },
  ];
  for (const change of mutations) {
    const copy = structuredClone(payload);
    change(copy.tables);
    assert.throws(
      () => validateStoryRows(copy),
      (error) => error.code === 'BACKUP_STORY_INVALID',
    );
  }
});

test('[R3-E-017] verifies signature bytes and reducer acknowledgements rather than trusting stored projection', async () => {
  const fixture = await storyBackupFixture();
  for (const change of [
    (tables) => {
      tables.pilot_curriculum_proof_receipt[0].signature = 'A'.repeat(86);
    },
    (tables) => {
      const row = tables.pilot_curriculum_learning_event[0],
        result = JSON.parse(row.result_json);
      result.ack.result.outcome = 'correct';
      row.result_json = canonicalPackage(result);
    },
  ]) {
    const copy = structuredClone(fixture.payload);
    change(copy.tables);
    const saved = validateStoryRows(copy);
    await assert.rejects(
      () => validateStorySemantics(saved, fixture.archiveIssuers),
      (error) => error.code === 'BACKUP_STORY_INVALID',
    );
  }
});
