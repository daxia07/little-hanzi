import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { assertOwnedState } from './qa-helpers.mjs';

export async function freePort() {
  const socket = net.createServer(); socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve)); return port;
}
export async function waitReady(url, headers = {}, timeout = 35_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { const response = await fetch(url, { headers: { Connection: 'close', ...headers }, signal: AbortSignal.timeout(1500) }); if (response.ok) return response; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Candidate did not become ready: ${url}`);
}
export async function server(manifest, { name, testing, token = '', port, host = '127.0.0.1', output, pilot = false, pilotTestContent = false, authSecret = '', beforeStart }) {
  const state = path.join(manifest.work, `${name}-state`);
  fs.mkdirSync(state, { recursive: true }); assertOwnedState(state);
  const builtDirectory = path.join(manifest.snapshot, 'dist', 'server');
  const base = JSON.parse(fs.readFileSync(path.join(builtDirectory, 'wrangler.json'), 'utf8'));
  // Each Worker watches its configuration. Keep mutable configs outside the
  // shared built module directory so another fixture cannot trigger its reload.
  const configDirectory = path.join(manifest.snapshot, '.qa-config', name);
  fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  const configPath = path.join(configDirectory, 'wrangler.json');
  const testRunId = `${manifest.runId}-${name}`;
  port ??= await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  if (pilot && authSecret.length < 32) throw new Error('Pilot runner requires a private auth secret');
  const vars = {
    HANZI_PREVIEW_MODE: '1', HANZI_TEST_MODE: testing ? '1' : '0',
    HANZI_TEST_RUN_ID: testing ? testRunId : '', HANZI_TEST_TOKEN: testing ? token : '',
    HANZI_CANDIDATE_ID: manifest.candidateId,
    ...(pilot ? { HANZI_PILOT_MODE: '1', HANZI_PILOT_TEST_CONTENT: pilotTestContent ? '1' : '0', HANZI_AUTH_ORIGIN: baseURL, HANZI_AUTH_SECRET: authSecret } : {}),
  };
  const config = {
    ...base, name: `hanzi-${name}`, vars,
    main: path.resolve(builtDirectory, base.main),
    base_dir: builtDirectory,
    assets: { ...base.assets, directory: path.resolve(builtDirectory, base.assets.directory) },
    build: { ...base.build, watch_dir: builtDirectory },
    d1_databases: [{ binding: 'DB', database_name: `hanzi-${name}`, database_id: '00000000-0000-4000-8000-000000000000' }],
    r2_buckets: [], kv_namespaces: [], services: [],
  };
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const inspector = await freePort();
  let child; let log;
  const launchArgs = [
    'dev', '--config', configPath, '--ip', host, '--port', String(port),
    '--inspector-port', String(inspector), '--persist-to', state, '--local',
  ];
  async function start(expectedCandidateId = manifest.candidateId) {
    if (expectedCandidateId !== manifest.candidateId && !(testing && pilot && expectedCandidateId === 'local-pilot')) {
      throw new Error('Unexpected candidate identity for an owned test restart');
    }
    const reservation = net.createServer(); reservation.listen(port, host);
    await once(reservation, 'listening');
    await new Promise(resolve => reservation.close(resolve));
    log = fs.openSync(path.join(output, `${name}-server.log`), 'a');
    child = spawn(path.join(manifest.snapshot, 'node_modules', '.bin', 'wrangler'), launchArgs, {
      cwd: manifest.snapshot, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_PATH: path.join(manifest.work, 'logs'), WRANGLER_REGISTRY_PATH: path.join(manifest.work, 'registry'), CHOKIDAR_USEPOLLING: '1', CI: '1' },
    });
    fs.writeFileSync(path.join(output, `${name}-process.json`), JSON.stringify({ pid: child.pid, launchArgs, state, candidateId: manifest.candidateId, testing, startedAt: new Date().toISOString() }, null, 2));
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream.on('data', chunk => {
        pending += chunk.toString();
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) if (log !== undefined) fs.writeSync(log, `${redact(line)}\n`);
      });
      stream.on('end', () => { if (pending && log !== undefined) fs.writeSync(log, redact(pending)); });
    }
    child.on('error', error => fs.appendFileSync(path.join(output, `${name}-server.log`), `\n${error.message}\n`));
    try {
      const response = await waitReady(pilot ? `${baseURL}/api/pilot/health` : testing ? `${baseURL}/api/test/identity` : `${baseURL}/api/preview/lessons/forest-01-v1/decision`, testing && !pilot ? { 'X-Hanzi-Test-Token': token } : {});
      if (testing && !pilot) {
        const identity = await response.json();
        if (identity.testRunId !== testRunId || identity.candidateId !== manifest.candidateId || identity.mode !== 'test') throw new Error('Test identity does not match the owned candidate');
      } else if ((await response.json()).candidateId !== expectedCandidateId) throw new Error('Preview identity does not match the owned candidate');
    } catch (error) { await stop(); fs.rmSync(configPath, { force: true }); throw error; }
  }
  function redact(value) {
    if (/HANZI_(?:AUTH_SECRET|TEST_TOKEN)/.test(value)) return '[private runner binding redacted]';
    for (const secret of [token, authSecret].filter(Boolean)) value = value.replaceAll(secret, '[redacted]');
    return value;
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 4000))]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    }
    if (log !== undefined) { fs.closeSync(log); log = undefined; }
  }
  try { if (beforeStart) await beforeStart({ configPath, state, baseURL }); }
  catch (error) { fs.rmSync(configPath, { force: true }); throw error; }
  await start();
  return { baseURL, port, state, configPath, testRunId, stop, restart: async ({ expectedCandidateId = manifest.candidateId } = {}) => { await stop(); await start(expectedCandidateId); } };
}
