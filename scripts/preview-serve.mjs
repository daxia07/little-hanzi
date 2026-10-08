import fs from 'node:fs';
import path from 'node:path';
import { loadManifest } from './qa-helpers.mjs';
import { server } from './qa-server.mjs';

const args = process.argv.slice(2);
const manifestIndex = args.indexOf('--manifest');
const manifest = loadManifest(manifestIndex >= 0 ? args[manifestIndex + 1] : undefined);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 4193;
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [4173,4175,4183,4185].includes(port)) throw new Error('Choose an unused preview port, separate from family services');
const output = path.join(manifest.output, 'owner-preview'); fs.mkdirSync(output, { recursive: true });
const app = await server(manifest, { name: 'owner-preview', testing: false, host: '0.0.0.0', port, output });
fs.writeFileSync(path.join(output, 'preview.json'), JSON.stringify({ candidateId: manifest.candidateId, lessonVersion: manifest.lessonVersion, port, state: app.state, startedAt: new Date().toISOString() }, null, 2));
console.log(`Owner preview: http://localhost:${port}/preview/forest-01 (${manifest.candidateId})`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.stop(); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
