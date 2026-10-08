import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const ROOT = path.resolve(import.meta.dirname, '..');
export function assertOwnedState(directory) {
  if (!directory || !path.isAbsolute(directory)) throw new Error('An absolute isolated state directory is required');
  const actual = fs.realpathSync(directory);
  const parent = path.dirname(actual);
  const marker = path.join(parent, '.hanzi-qa-owned');
  if (actual !== path.resolve(directory) || !fs.existsSync(marker) || !path.basename(parent).startsWith('hanzi-')) {
    throw new Error('State must be inside a marked runner-owned directory, without symlink traversal');
  }
  if (actual.includes(`${path.sep}.wrangler${path.sep}state`)) throw new Error('Family state cannot be used for preview or QA');
  return actual;
}
export function allowedSource(file) {
  const parts = file.split('/');
  if (parts.some(p => ['.git', '.wrangler', '.handoff', '.qa-config', 'node_modules', 'outputs', '.run', 'backups', 'private-backups', 'dist'].includes(p))) return false;
  if (parts.some(p => p.startsWith('.env') && p !== '.env.example')) return false;
  if (parts.some(p => p.startsWith('.dev.vars'))) return false;
  return !(/\.(?:sqlite|db|log|m4a)(?:-.*)?$/.test(file) || /(^|\/)(?:STATUS|NEXT-SESSION)\.md$/.test(file));
}
export function sourceFiles(root = ROOT) {
  return [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean))]
    .filter(allowedSource).filter(file => fs.existsSync(path.join(root, file))).sort((a, b) => a.localeCompare(b));
}
export function digest(root, files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(fs.readFileSync(path.join(root, file))).update('\0');
  return hash.digest('hex');
}
export function loadManifest(file) {
  if (!file) throw new Error('Pass --manifest <path printed by qa:prepare>');
  const manifest = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!manifest.snapshot || !manifest.files || digest(manifest.snapshot, manifest.files) !== manifest.digest) throw new Error('Candidate snapshot changed; prepare a new candidate');
  assertOwnedState(manifest.buildState);
  return manifest;
}
