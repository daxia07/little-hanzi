/** Private fresh SQLD transport. It creates its own directory; never accepts an existing DB/client/URL. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';
import {
  freePort,
  launched,
  runtimeEnvironment,
  bounded,
} from './readiness-node-runner.mjs';
import { stopCorpusRuntimeChild } from './readiness-corpus-runtime-controls.mjs';
const servers = new WeakMap();
const identity = (p) => {
  const s = fs.lstatSync(p);
  return {
    dev: s.dev,
    ino: s.ino,
    uid: s.uid,
    type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other',
  };
};
const same = (p, v) => {
  try {
    return JSON.stringify(identity(p)) === JSON.stringify(v);
  } catch {
    return false;
  }
};
export function ownsCorpusDatabase(daemon) {
  const s = servers.get(daemon);
  return (
    !!s &&
    same(s.directory, s.directoryIdentity) &&
    same(s.file, s.fileIdentity) &&
    s.containingDirectories.every(([name, expected]) =>
      same(path.join(s.directory, name), expected),
    ) &&
    same(path.join(s.directory, '.hanzi-qa-owned'), s.markerIdentity) &&
    fs.readFileSync(path.join(s.directory, '.hanzi-qa-owned'), 'utf8') ===
      s.marker &&
    s.service.child.exitCode === null &&
    s.service.child.signalCode === null
  );
}
const expectedStartupPaths = new Set([
  '.hanzi-qa-owned',
  '.sqld.log',
  '.version',
  'dbs',
  'dbs/default',
  'dbs/default/data',
  'dbs/default/data-wal',
  'dbs/default/data-shm',
  'dbs/default/wallog',
  'dbs/default/client_wal_index',
  'dbs/default/to_compact',
  'dbs/default/stats.json',
  'dbs/default/tmp',
  'metastore',
  'metastore/data',
  'metastore/data-wal',
  'metastore/data-shm',
]);
function cleanupUnexposedStartup(
  directory,
  marker,
  directoryIdentity,
  markerIdentity,
  beforeStop,
) {
  if (
    !same(directory, directoryIdentity) ||
    !same(path.join(directory, '.hanzi-qa-owned'), markerIdentity) ||
    fs.readFileSync(path.join(directory, '.hanzi-qa-owned'), 'utf8') !== marker
  )
    return false;
  const names = fs.readdirSync(directory, { recursive: true });
  if (
    names.some(
      (name) =>
        !expectedStartupPaths.has(name) ||
        !beforeStop.has(name) ||
        !same(path.join(directory, name), beforeStop.get(name)),
    )
  )
    return false;
  for (const name of names.sort((a, b) => b.length - a.length)) {
    if (name === '.hanzi-qa-owned') continue;
    const target = path.join(directory, name),
      stat = fs.lstatSync(target);
    if (stat.isFile()) fs.unlinkSync(target);
    else if (stat.isDirectory() && fs.readdirSync(target).length === 0)
      fs.rmdirSync(target);
    else return false;
  }
  fs.unlinkSync(path.join(directory, '.hanzi-qa-owned'));
  fs.rmdirSync(directory);
  return true;
}
export async function startOwnedCorpusDatabase(options = {}) {
  if (
    !options ||
    Object.keys(options).some(
      (key) => !['parent', 'signal', 'onOwnedProcess'].includes(key),
    )
  )
    throw new Error('CORPUS_DATABASE_OPTIONS_INVALID');
  const { parent, signal, onOwnedProcess } = options;
  if (signal?.aborted) throw new Error('CORPUS_CANCELLED');
  if (onOwnedProcess !== undefined && typeof onOwnedProcess !== 'function')
    throw new Error('CORPUS_DATABASE_OPTIONS_INVALID');
  const parentPath = fs.realpathSync(parent),
    stat = fs.statSync(parentPath);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    !parentPath.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)
  )
    throw new Error('CORPUS_PRIVATE_PARENT_REQUIRED');
  const binary =
    process.env.HANZI_SQLD_BINARY ?? path.join(os.homedir(), '.turso/sqld');
  if (!path.isAbsolute(binary) || !fs.statSync(binary).isFile())
    throw new Error('CORPUS_SQLD_REQUIRED');
  fs.accessSync(binary, fs.constants.X_OK);
  const port = await freePort(),
    url = 'http://127.0.0.1:' + port;
  const directory = fs.mkdtempSync(path.join(parentPath, 'hanzi-r6-owned-'));
  const directoryIdentity = identity(directory),
    marker = 'r6-owned-direct-store:' + crypto.randomUUID();
  let service, client, markerIdentity;
  try {
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(path.join(directory, '.hanzi-qa-owned'), marker, {
      mode: 0o600,
      flag: 'wx',
    });
    markerIdentity = identity(path.join(directory, '.hanzi-qa-owned'));
    const file = path.join(directory, 'dbs/default/data');
    service = launched(
      binary,
      [
        '--db-path',
        directory,
        '--http-listen-addr',
        `127.0.0.1:${port}`,
        '--no-welcome',
        '--disable-metrics',
      ],
      {
        cwd: directory,
        env: runtimeEnvironment(),
        log: path.join(directory, '.sqld.log'),
      },
    );
    // Notification records this actual child before any readiness/seed await; its return grants no authority.
    onOwnedProcess?.(service);
    client = createClient({ url, intMode: 'number' });
    const deadline = Date.now() + 30000;
    for (let i = 0; ; i++) {
      if (signal?.aborted) throw new Error('CORPUS_CANCELLED');
      if (
        service.error ||
        service.child.exitCode !== null ||
        service.child.signalCode !== null
      )
        throw new Error('CORPUS_SQLD_EXIT');
      try {
        await bounded(client.execute('SELECT 1'), 1000, 'SQLD readiness');
        break;
      } catch (error) {
        if (i >= 99 || Date.now() >= deadline) throw error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const daemon = Object.freeze({
      directory,
      marker,
      file,
      client,
      url,
      service,
    });
    servers.set(daemon, {
      directory,
      marker,
      file,
      client,
      service,
      directoryIdentity,
      markerIdentity,
      fileIdentity: identity(file),
      containingDirectories: ['dbs', 'dbs/default'].map((name) => [
        name,
        identity(path.join(directory, name)),
      ]),
    });
    return daemon;
  } catch (error) {
    let beforeStop = new Map();
    try {
      beforeStop = new Map(
        fs
          .readdirSync(directory, { recursive: true })
          .map((name) => [name, identity(path.join(directory, name))]),
      );
    } catch {
      /* retain a changed/unreadable directory */
    }
    // An unsuccessful spawn with no PID created no child to certify. All spawned children require observed exit.
    try {
      if (service?.child.pid) await stopCorpusRuntimeChild(service.child);
    } finally {
      client?.close();
    }
    if (markerIdentity)
      cleanupUnexposedStartup(
        directory,
        marker,
        directoryIdentity,
        markerIdentity,
        beforeStop,
      );
    else if (
      same(directory, directoryIdentity) &&
      fs.readdirSync(directory).length === 0
    )
      fs.rmdirSync(directory);
    throw error;
  }
}
export async function stopOwnedCorpusDatabase(daemon) {
  const s = servers.get(daemon);
  if (!s) throw new Error('CORPUS_DATABASE_HANDLE_REQUIRED');
  try {
    await stopCorpusRuntimeChild(s.service.child);
  } finally {
    s.client.close();
  }
}
