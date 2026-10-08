/** Closed R5 collection extension for the owned Node/libSQL family runner. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  prepareNodeCandidate,
  bounded,
  jsonFile,
} from './readiness-node-runner.mjs';
import { serveStoryNodeCandidate } from './readiness-story-node-runner.mjs';
import { collectionProfile } from './readiness-collection-profiles.mjs';
export { collectionProfile } from './readiness-collection-profiles.mjs';
import { curriculumDigest } from '../lib/curriculum/digest.ts';
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(v);
export function validateCollectionControl(
  route,
  body,
  profile = 'draft-collection',
) {
  const selected = collectionProfile(profile);
  if (Object.hasOwn(body || {}, 'target')) {
    if (
      selected.name !== 'positive-collection' ||
      body.target !== 'ordinary' ||
      route !== '/inspect'
    )
      throw new Error('Invalid collection runner control');
    const { target: _target, ...rest } = body;
    void _target;
    return validateCollectionControl(route, rest, profile);
  }
  const valid =
    (route === '/verify-and-sign' &&
      exact(body, ['suite', 'lessonVersion']) &&
      body.suite === 'collection' &&
      /^path-(?:0[1-9]|10)-v1$/.test(body.lessonVersion)) ||
    (route === '/inspect' &&
      ((exact(body, ['kind']) && body.kind === 'counts') ||
        (exact(body, ['kind', 'assignmentId']) &&
          body.kind === 'assignment' &&
          id(body.assignmentId)) ||
        (exact(body, ['kind', 'runId']) &&
          body.kind === 'run' &&
          id(body.runId))));
  if (!valid) throw new Error('Invalid collection runner control');
  return true;
}
export async function collectionFactory({
  manifest,
  output,
  client,
  scope,
  accounts,
  token,
  trust,
  urls,
  signIn,
  profile = 'draft-collection',
  signProof,
  targetContext,
}) {
  if (manifest.phase !== 'r5') throw new Error('R5 candidate required');
  const selected = collectionProfile(profile);
  const document = JSON.parse(
    fs.readFileSync(
      path.join(manifest.snapshot, selected.manifestPath),
      'utf8',
    ),
  );
  const packages = document.items.map((item) =>
    JSON.parse(
      fs.readFileSync(
        path.join(
          manifest.snapshot,
          selected.packageDirectory,
          item.lessonVersion + '.json',
        ),
        'utf8',
      ),
    ),
  );
  const fingerprint = await curriculumDigest(document);
  const capability = {
    installationId: scope.installationId,
    collectionVersion: document.collectionVersion,
    collectionDigest: fingerprint,
    namespace: scope.namespace,
    childIds: scope.childIds,
    parentIds: scope.parentIds,
  };
  const moduleAt = (relative) =>
    import(pathToFileURL(path.join(manifest.snapshot, relative)).href);
  const { createLibsqlD1Database } = await moduleAt(
    'lib/platform/libsql-d1.ts',
  );
  const { bootstrapCollection } = await moduleAt(
    'lib/pilot/collection-store.ts',
  );
  const config = {
    pilotMode: true,
    testMode: true,
    testContentAllowed: true,
    testRunId: scope.namespace,
    testToken: token,
    candidateId: manifest.candidateId,
    candidateExplicitlyBound: true,
    curriculumTrust: trust,
    collectionCapability: capability,
  };
  let server = null;
  const handoff = {
    profile: selected.name,
    manifestPath: selected.manifestPath,
    packageDirectory: selected.packageDirectory,
    collectionVersion: document.collectionVersion,
    collectionDigest: fingerprint,
    items: document.items,
    controlURL: null,
    bootstrap: null,
    childIdsByLesson: Object.fromEntries(
      document.items.map((item, index) => [
        item.lessonVersion,
        `qa-story-collection-child-${String(index + 1).padStart(2, '0')}`,
      ]),
    ),
    initialClock: null,
  };
  const tables = [
    'pilot_collection',
    'pilot_collection_item',
    'pilot_collection_proposal',
    'pilot_collection_plan',
    'pilot_collection_plan_item',
    'pilot_collection_assignment',
    'pilot_collection_schedule',
    'pilot_collection_run',
    'pilot_collection_event',
    'pilot_collection_learning_audit',
  ];
  const rows = async (sql, args = [], selectedClient = client) =>
    (
      await bounded(
        selectedClient.execute({ sql, args }),
        10000,
        'Collection inspection',
      )
    ).rows.map((row) => Object.fromEntries(Object.entries(row)));
  async function inspect(body) {
    const selectedClient =
      body.target === 'ordinary' ? targetContext()?.client : client;
    if (!selectedClient) throw new Error('Missing owned target');
    const read = (sql, args = []) => rows(sql, args, selectedClient);
    if (body.kind === 'counts')
      return Object.fromEntries(
        await Promise.all(
          tables.map(async (table) => [
            table,
            Number((await read(`SELECT COUNT(*) AS n FROM ${table}`))[0].n),
          ]),
        ),
      );
    if (body.kind === 'assignment')
      return {
        schedules: await read(
          'SELECT id,assignment_id,kind,due_at,initial_run_id,completion_event_id,initial_completed_at FROM pilot_collection_schedule WHERE assignment_id=? ORDER BY due_at,kind',
          [body.assignmentId],
        ),
        runs: await read(
          'SELECT id,schedule_id,phase,revision,completed_at FROM pilot_collection_run WHERE assignment_id=? ORDER BY phase',
          [body.assignmentId],
        ),
      };
    return {
      runs: await read(
        'SELECT id,assignment_id,schedule_id,phase,revision,completed_at FROM pilot_collection_run WHERE id=?',
        [body.runId],
      ),
      events: await read(
        'SELECT id,event_id,sequence,expected_revision,server_at FROM pilot_collection_event WHERE run_id=? ORDER BY sequence',
        [body.runId],
      ),
    };
  }
  return {
    handoff,
    bindings(name) {
      return {
        HANZI_COLLECTION_CAPABILITY:
          name === 'app' ? JSON.stringify(capability) : '',
      };
    },
    async initialize() {
      const operator = accounts.find((a) => a.role === 'operator');
      const session = (
        await rows(
          'SELECT id FROM pilot_auth_session WHERE user_id=? ORDER BY created_at DESC LIMIT 1',
          [operator.id],
        )
      )[0];
      if (!session)
        throw new Error(
          'Collection bootstrap requires an ordinary operator session',
        );
      if (selected.name === 'positive-collection') {
        const cookie = await signIn(operator);
        for (const p of packages) {
          const response = await fetch(`${urls.app}/api/pilot/curriculum`, {
            method: 'POST',
            headers: {
              Origin: urls.app,
              Cookie: cookie,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ package: p }),
            signal: AbortSignal.timeout(10000),
          });
          if (
            !response.ok ||
            (await response.json()).contentDigest !==
              (await curriculumDigest(p))
          )
            throw new Error('Positive collection ordinary import mismatch');
        }
        const response = await fetch(`${urls.app}/api/pilot/collections`, {
          method: 'POST',
          headers: {
            Origin: urls.app,
            Cookie: cookie,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ collection: document }),
          signal: AbortSignal.timeout(10000),
        });
        if (
          !response.ok ||
          (await response.json()).collectionDigest !== fingerprint
        )
          throw new Error(
            'Positive collection ordinary manifest import mismatch',
          );
      }
      handoff.bootstrap = await bootstrapCollection(
        {
          db: createLibsqlD1Database(client),
          config,
          user: operator,
          session: { id: session.id },
        },
        document,
        packages,
      );
      handoff.initialClock = Date.now();
      server = http.createServer(async (req, res) => {
        const send = (status, value) =>
          res
            .writeHead(status, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            })
            .end(JSON.stringify(value));
        if (req.method !== 'POST')
          return send(404, { error: 'Unknown collection control' });
        if (req.headers['x-hanzi-test-token'] !== token)
          return send(403, { error: 'Runner token required' });
        try {
          const body = await bounded(
            (async () => {
              let raw = '';
              for await (const chunk of req) {
                raw += chunk;
                if (Buffer.byteLength(raw) > 1024)
                  throw new Error('Oversized control');
              }
              return JSON.parse(raw);
            })(),
            5000,
            'Collection control body',
          );
          validateCollectionControl(req.url, body, selected.name);
          if (req.url === '/verify-and-sign') {
            const item = document.items.find(
              (item) => item.lessonVersion === body.lessonVersion,
            );
            if (!item || typeof signProof !== 'function')
              return send(503, {
                error: 'Collection proof executor unavailable',
              });
            return send(
              200,
              await signProof({
                lessonVersion: item.lessonVersion,
                contentDigest: item.contentDigest,
              }),
            );
          }
          send(200, await inspect(body));
        } catch {
          send(400, { error: 'Collection control rejected' });
        }
      });
      server.requestTimeout = 6000;
      server.headersTimeout = 6000;
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      handoff.controlURL = `http://127.0.0.1:${server.address().port}`;
      jsonFile(path.join(output, 'collection-bootstrap.json'), {
        collectionVersion: document.collectionVersion,
        collectionDigest: fingerprint,
        lessonCount: packages.length,
        syntheticOnly: true,
      });
    },
    async cleanup() {
      if (server) {
        server.closeAllConnections();
        await bounded(
          new Promise((resolve) => server.close(resolve)),
          5000,
          'Collection control close',
        );
      }
      jsonFile(path.join(output, 'collection-cleanup.json'), {
        controlClosed: true,
      });
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (process.argv[2] === 'prepare' && process.argv.length === 3)
      await prepareNodeCandidate({ phase: 'r5' });
    else if (
      process.argv[2] === 'serve' &&
      (process.argv.length === 4 ||
        (process.argv.length === 6 && process.argv[4] === '--profile'))
    ) {
      const selected = collectionProfile(process.argv[5]);
      const operationsFactory =
        selected.name === 'draft-collection'
          ? (await import('./readiness-ops-node-runner.mjs')).operationsFactory
          : null;
      await serveStoryNodeCandidate(process.argv[3], {
        collectionFactory,
        collectionProfileName: selected.name,
        operationsFactory,
      });
    } else
      throw new Error(
        'Usage: node scripts/readiness-collection-node-runner.mjs prepare | serve <manifest> [--profile draft-collection|positive-collection]',
      );
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
