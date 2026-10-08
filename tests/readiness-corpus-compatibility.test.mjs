import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  opsCompatibility,
  assertRollbackCompatibility,
} from '../scripts/pilot-ops-recovery.mjs';
import { readinessPhase } from '../scripts/readiness-node-runner.mjs';
import { digest } from '../scripts/qa-helpers.mjs';

test('[R6-E-013/015] compatibility binds exact8/3 schema and all frozen corpus versions without widening older phases', () => {
  const source = path.resolve(import.meta.dirname, '..');
  const work = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-node-r6-compat-unit-'),
  );
  const snapshot = path.join(work, 'candidate');
  const runId = 'r6-compat-' + crypto.randomUUID();
  const files = [];
  fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), runId);
  const copy = (folder) => {
    for (const item of fs.readdirSync(path.join(source, folder), {
      withFileTypes: true,
    })) {
      const file = folder + '/' + item.name;
      if (item.isDirectory()) copy(file);
      else if (item.isFile()) {
        fs.mkdirSync(path.dirname(path.join(snapshot, file)), {
          recursive: true,
        });
        fs.copyFileSync(path.join(source, file), path.join(snapshot, file));
        files.push(file);
      } else throw new Error('Unexpected fixture link');
    }
  };
  try {
    for (const folder of [
      'db/pilot-migrations',
      'db/pilot-ops-migrations',
      'content/curriculum',
      'content/corpora',
      'tests/fixtures/curriculum/corpus-stress',
    ])
      copy(folder);
    const output = path.join(source, 'outputs/qa/readiness-r6', runId);
    fs.writeFileSync(
      path.join(work, '.hanzi-qa-evidence.json'),
      JSON.stringify({
        schemaVersion: 'readiness-evidence-location-1',
        runId,
        output,
      }),
      { mode: 0o600 },
    );
    const nodeEntry = path.join(snapshot, '.output/server/index.mjs');
    fs.mkdirSync(path.dirname(nodeEntry), { recursive: true });
    fs.writeFileSync(
      nodeEntry,
      '// Synthetic compatibility metadata unit fixture; never served.',
    );
    const artifactFiles = ['.output/server/index.mjs'];
    const manifest = {
      phase: 'r6',
      ...readinessPhase('r6'),
      candidateId: 'r6-unit',
      runId,
      work,
      snapshot,
      output,
      files,
      digest: digest(snapshot, files),
      nodeEntry,
      artifactFiles,
      artifactDigest: digest(snapshot, artifactFiles),
    };
    const actual = opsCompatibility(manifest);
    assert.deepEqual(actual.archiveFormats, [
      'pilot-admin-backup-6',
      'pilot-ops-backup-3',
    ]);
    assert.equal(actual.learningMigrations.length, 8);
    assert.equal(actual.operationsMigrations.length, 3);
    assert.equal(actual.operationsTooling, 'separate-retained-r6');
    const draft = JSON.parse(
      fs.readFileSync(
        path.join(snapshot, 'content/corpora/hanzi-starter-draft-v1.json'),
      ),
    );
    const stress = JSON.parse(
      fs.readFileSync(
        path.join(
          snapshot,
          'tests/fixtures/curriculum/corpus-stress/corpus.json',
        ),
      ),
    );
    for (const item of [...draft.items, ...stress.items])
      assert.equal(actual.contentVersions.includes(item.lessonVersion), true);
    assert.equal(actual.contentVersions.includes('path-01-v1'), true);
    assert.equal(
      new Set(actual.contentVersions).size,
      actual.contentVersions.length,
    );
    const olderOutput = path.join(source, 'outputs/qa/readiness-r5', runId);
    fs.writeFileSync(
      path.join(work, '.hanzi-qa-evidence.json'),
      JSON.stringify({
        schemaVersion: 'readiness-evidence-location-1',
        runId,
        output: olderOutput,
      }),
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        opsCompatibility({
          ...manifest,
          phase: 'r5',
          ...readinessPhase('r5'),
          output: olderOutput,
        }),
      /OPS_ROLLBACK_INCOMPATIBLE/,
    );
    const target = {
      ...actual,
      candidateId: 'other',
      contentVersions: actual.contentVersions.filter(
        (v) => v !== draft.items[0].lessonVersion,
      ),
    };
    assert.throws(
      () => assertRollbackCompatibility(actual, target),
      /OPS_ROLLBACK_INCOMPATIBLE/,
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
