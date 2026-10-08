import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedSource, assertOwnedState, digest, loadManifest } from '../scripts/qa-helpers.mjs';

test('QA snapshots exclude private state, secrets and recordings', () => {
  for (const file of ['.env.local', '.dev.vars', '.dev.vars.preview', '.wrangler/state/db.sqlite', '.handoff/source.ts', '.qa-config/pilot/wrangler.json', 'public/audio/yi.m4a', 'backups/record.json', 'private-backups/pilot.json', 'STATUS.md']) assert.equal(allowedSource(file), false, file);
  for (const file of ['app/page.tsx', 'docs/roadmap.md', '.env.example', 'package-lock.json']) assert.equal(allowedSource(file), true, file);
});
test('QA state requires a marked owned directory and rejects escaping symlinks', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hanzi-unit-'));
  try {
    const state = path.join(root, 'state'); fs.mkdirSync(state);
    assert.throws(() => assertOwnedState(state), /marked/);
    fs.writeFileSync(path.join(root, '.hanzi-qa-owned'), 'unit');
    assert.equal(assertOwnedState(state), state);
    const alias = path.join(root, 'alias'); fs.symlinkSync(state, alias);
    assert.throws(() => assertOwnedState(alias), /symlink/);
    assert.throws(() => assertOwnedState('.wrangler/state'), /absolute/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('QA rejects changed candidate source instead of reporting stale evidence', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hanzi-unit-'));
  try {
    fs.writeFileSync(path.join(root, '.hanzi-qa-owned'), 'unit');
    const state = path.join(root, 'state'); fs.mkdirSync(state);
    fs.writeFileSync(path.join(root, 'source.ts'), 'original');
    const file = path.join(root, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ snapshot: root, files: ['source.ts'], digest: digest(root, ['source.ts']), buildState: state }));
    assert.equal(loadManifest(file).snapshot, root);
    fs.writeFileSync(path.join(root, 'source.ts'), 'changed');
    assert.throws(() => loadManifest(file), /changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
