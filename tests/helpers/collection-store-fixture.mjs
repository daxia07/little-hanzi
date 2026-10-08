import { legacyCollectionRoot } from './legacy-pilot-root.mjs';
/** Author fixture only: fresh marked synthetic embeddedlibSQL, closed production bootstrap; not HTTP acceptance. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { applyLibsqlMigrations } from '../../scripts/pilot-libsql-admin.mjs';
import { createLibsqlD1Database } from '../../lib/platform/libsql-d1.ts';
import * as collection from '../../lib/pilot/collection-store.ts';
import { curriculumDigest } from '../../lib/curriculum/digest.ts';
const clock = Date.parse('2026-09-27T00:00:00Z');
export async function withCollectionFixture(fn) {
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        '../../content/collections/little-hanzi-path-1-v1.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-owned-unit-'));
  fs.writeFileSync(path.join(root, '.hanzi-qa-owned'), 'r5-author-unit');
  const client = createClient({ url: 'file:' + path.join(root, 'fresh.db') });
  try {
    await applyLibsqlMigrations({
      client,
      root: legacyCollectionRoot(
        fileURLToPath(new URL('../../', import.meta.url)),
      ),
    });
    for (const [id, role] of [
      ['op', 'operator'],
      ['p', 'parent'],
      ['c', 'child'],
      ['p2', 'parent'],
      ['c2', 'child'],
      ['t', 'teacher'],
    ]) {
      await client.execute({
        sql: 'INSERT INTO pilot_auth_user(id,name,email,email_verified,created_at,updated_at,username,display_username,role,must_change_password,disabled) VALUES(?,?,?,0,0,0,?,?,?,0,0)',
        args: [id, id, id + '@example.test', id, id, role],
      });
      await client.execute({
        sql: 'INSERT INTO pilot_auth_session(id,expires_at,token,created_at,updated_at,user_id) VALUES(?,?,?,?,?,?)',
        args: [
          's-' + id,
          clock + 30 * 86400000,
          'synthetic-private-' + id,
          0,
          0,
          id,
        ],
      });
    }
    await client.execute(
      "INSERT INTO pilot_parent_child VALUES('p','c',0,'op'),('p2','c2',0,'op')",
    );
    await client.execute(
      "UPDATE pilot_installation SET installation_id='r5-install',created_at=0 WHERE id=1",
    );
    await client.execute(
      "INSERT INTO pilot_onboarding VALUES('c','Synthetic learner','confident',1,0,'p')",
    );
    const digest = await curriculumDigest(manifest),
      config = {
        pilotMode: true,
        testMode: true,
        testContentAllowed: true,
        testRunId: 'r5-unit',
        testToken: 'private-author-only',
        candidateId: 'candidate',
        candidateExplicitlyBound: true,
        curriculumTestNow: String(clock),
        curriculumTrust: {
          candidateId: 'candidate',
          sourceDigest: digest,
          artifactDigest: digest,
          buildId: 'build',
          issuers: [],
          archiveIssuers: [],
        },
        collectionCapability: {
          installationId: 'r5-install',
          collectionVersion: manifest.collectionVersion,
          collectionDigest: digest,
          namespace: 'r5-unit',
          childIds: ['c'],
          parentIds: ['p'],
        },
      };
    const db = createLibsqlD1Database(client),
      context = (id) => ({
        db,
        config,
        user: {
          id,
          role:
            id === 'op'
              ? 'operator'
              : id.startsWith('p')
                ? 'parent'
                : id === 't'
                  ? 'teacher'
                  : 'child',
        },
        session: { id: 's-' + id },
      });
    // Explicit synthetic verification fixture facts: no human review or ordinary release assertion.
    await collection.bootstrapCollection(
      context('op'),
      manifest,
      manifest.items.map((x) =>
        JSON.parse(
          fs.readFileSync(
            new URL(
              '../../content/curriculum/collection/' +
                x.lessonVersion +
                '.json',
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      ),
    );
    await fn({
      client,
      config,
      context,
      parent: context('p'),
      child: context('c'),
      operator: context('op'),
      manifest,
    });
  } finally {
    client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
export async function populateCollectionVisits(e) {
  const proposed = await collection.proposeCollection(e.parent, 'c', {
      collectionVersion: e.manifest.collectionVersion,
      lessonVersion: null,
      predecessorProposalId: null,
      expectedSourceDigest: null,
    }),
    approved = await collection.approveCollection(e.parent, 'c', {
      proposalId: proposed.proposal.proposalId,
      sourceDigest: proposed.proposal.sourceDigest,
    }),
    assignmentId = approved.plan.items[0].assignmentId;
  const runIds = [];
  for (const kind of ['initial', 'review-24h', 'review-7d']) {
    const schedule = (
      await collection.collectionPractice(
        e.child,
        'c',
        e.manifest.collectionVersion,
      )
    ).items.find((x) => x.kind === kind);
    if (!schedule) throw Error('Required visit missing');
    e.config.curriculumTestNow = String(Date.parse(schedule.dueAt));
    const start = await collection.startCollection(e.child, assignmentId, {
      requestId: 'fixture-' + kind,
      scheduleId: schedule.scheduleId,
    });
    runIds.push(start.runId);
    let completed = false;
    for (let i = 0; i < 80; i++) {
      const view = await collection.getCollectionRun(e.child, start.runId);
      if (view.state.completedAt) {
        completed = true;
        break;
      }
      await collection.advanceCollection(e.child, start.runId, {
        eventId: 'fixture-' + crypto.randomUUID(),
        expectedRevision: view.revision,
        occurrenceId: view.question?.occurrenceId ?? null,
        type:
          view.question?.status === 'open' ? 'audio-unavailable' : 'continue',
        payload: {},
      });
    }
    if (!completed) throw Error('Fixture did not complete');
  }
  return { assignmentId, runIds };
}
