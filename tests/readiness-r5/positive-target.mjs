// Independent ordinary-target policy/learning/recovery QA. Never invoked by the signer.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyNodeManifest } from '../../scripts/readiness-node-runner.mjs';
import { createHttpAdapter } from './http-runner.mjs';
import { completeRun, selectStart } from './http-suite.mjs';
import { COLLECTION, LESSONS } from './oracle.mjs';
const FIXTURE = 'tests/fixtures/curriculum/collection-positive';
const SCENARIOS = [
  'selection',
  'approval',
  'recognition',
  'help',
  'audio-unavailable',
  'restart',
  'duplicate-conflict',
  'review-24h',
  'review-7d',
  'progress-export',
  'recovery',
  'ownership',
  'browser-family',
];
const CHECKLIST = [
  'scriptAndGlyphs',
  'mandarinAndReadings',
  'wordContexts',
  'teachingAndChecks',
  'ageSuitability',
  'sourcesAndLicenses',
  'deviceAudio',
];
const COLLECTION_TABLES = [
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
const hash = (bytes) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
const canonical = (value) =>
  value && typeof value === 'object'
    ? Array.isArray(value)
      ? value.map(canonical)
      : Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
    : value;
const digest = (value) => hash(JSON.stringify(canonical(value)));
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const redactError = (error) => {
  const location = String(error?.stack ?? '').match(
    /(?:[/\\])(positive-target\.mjs|http-suite\.mjs|http-runner\.mjs|oracle\.mjs):(\d+):(\d+)/,
  );
  const scalar = (value) =>
    typeof value === 'number' || typeof value === 'boolean' || value === null
      ? value
      : undefined;
  return {
    name:
      error?.name === 'AssertionError' ? 'AssertionError' : 'ExecutionError',
    code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : null,
    location: location ? `${location[1]}:${location[2]}:${location[3]}` : null,
    ...(error?.name === 'AssertionError'
      ? { expected: scalar(error.expected), actual: scalar(error.actual) }
      : {}),
  };
};

function loopback(value) {
  const u = new URL(value);
  assert.equal(u.protocol, 'http:');
  assert.equal(u.hostname, '127.0.0.1');
  assert(u.port);
  assert.equal(u.pathname, '/');
  assert(!u.username && !u.password && !u.search && !u.hash);
  return u.origin;
}
async function privateFile(file) {
  const actual = await fs.realpath(file);
  assert.equal(actual, path.resolve(file));
  const s = await fs.lstat(actual);
  assert(s.isFile() && !s.isSymbolicLink());
  assert.equal(s.mode & 0o777, 0o600);
  if (process.getuid) assert.equal(s.uid, process.getuid());
  return actual;
}
function publicationBody(
  h,
  item,
  scope,
  head,
  reviewId,
  proofId,
  ownerId,
  status = 'released',
) {
  return {
    requestId: 'qa-positive-' + randomUUID(),
    expectedRevision: Number(head?.generation ?? 0),
    predecessorId: head?.id ?? null,
    contentDigest: item.contentDigest,
    reviewId,
    proofId,
    ownerDecisionId: ownerId,
    status,
    scope,
  };
}
function reviewBody(item, previousReviewId, decision = 'approved') {
  return {
    requestId: 'qa-simulated-' + randomUUID(),
    contentDigest: item.contentDigest,
    previousReviewId,
    decision,
    reviewerRef: 'SIMULATED QA review; not human Mandarin acceptance',
    reviewedAt: Date.now(),
    checklistVersion: 'hanzi-review-1',
    checklist: Object.fromEntries(
      CHECKLIST.map((k) => [k, decision === 'approved']),
    ),
    evidenceRef: 'SIMULATED/collection-positive/ordinary-policy-only',
    reason:
      'SIMULATED QA contract input; no human, device or owner acceptance.',
  };
}
function stableProgress(value) {
  const copy = structuredClone(value);
  delete copy.serverAt;
  return copy;
}
export async function runPositiveTarget(handoffFile, output) {
  const h = await json(await privateFile(handoffFile));
  const manifest = verifyNodeManifest(await json(h.manifest), { built: true });
  assert.equal(manifest.phase, 'r5');
  assert.equal(manifest.candidateId, h.candidateId);
  assert.equal(h.profile, 'positive-collection');
  assert.equal(h.collection.profile, 'positive-collection');
  assert.equal(h.collection.manifestPath, FIXTURE + '/collection.json');
  assert.equal(h.collection.packageDirectory, FIXTURE);
  const work = await fs.realpath(manifest.work);
  assert.equal(
    await fs.readFile(path.join(work, '.hanzi-qa-owned'), 'utf8'),
    manifest.runId,
  );
  output = path.resolve(output);
  assert(output.startsWith(work + path.sep));
  assert.equal(await fs.realpath(path.dirname(output)), path.dirname(output));
  assert.equal(path.resolve(h.snapshot), manifest.snapshot);
  assert.equal(h.sourceDigest, 'sha256:' + manifest.digest);
  assert.equal(h.artifactDigest, 'sha256:' + manifest.artifactDigest);
  assert.equal(h.buildId, manifest.candidateId);
  assert.equal(h.scope.installationId, h.evidenceInstallationId);
  assert.notEqual(h.targetInstallationId, h.evidenceInstallationId);
  const target = loopback(h.targetBaseURL);
  assert.notEqual(target, loopback(h.baseURL));
  assert.notEqual(target, loopback(h.ordinaryBaseURL));
  loopback(h.controlURL);
  loopback(h.collection.controlURL);
  assert.equal(path.dirname(h.targetState), work);
  assert.equal(await fs.realpath(h.targetState), h.targetState);
  assert((await fs.stat(h.targetState)).isDirectory());
  assert.notEqual(h.targetState, h.state);
  assert.equal(h.targetIssuer.purpose, 'release');
  assert.equal(h.publicIssuer.purpose, 'candidate');
  const credentialsFile = await privateFile(h.credentialsFile);
  assert(credentialsFile.startsWith(work + path.sep));
  const credentials = await json(credentialsFile);
  const persona = (label) => {
    const a = credentials.accounts.find((a) => a.label === label);
    assert(a);
    return { id: a.id, label: a.label };
  };
  const parent = persona('parent-a'),
    foreign = persona('parent-b'),
    operator = persona('operator');
  const fixed = await json(path.join(h.snapshot, FIXTURE, 'collection.json'));
  assert.equal(fixed.collectionVersion, COLLECTION.version);
  assert.equal(digest(fixed), h.collection.collectionDigest);
  assert.deepEqual(fixed.items, h.collection.items);
  assert.equal(fixed.items.length, 10);
  const packages = new Map();
  for (const item of fixed.items) {
    assert(LESSONS.some((l) => l.version === item.lessonVersion));
    const relative = FIXTURE + '/' + item.lessonVersion + '.json';
    assert(manifest.files.includes(relative));
    const p = await json(path.join(h.snapshot, relative));
    assert.equal(digest(p), item.contentDigest);
    assert.equal(p.lessonVersion, item.lessonVersion);
    assert(
      p.characters.every((c) =>
        c.readings.every((r) => r.provenance.source.includes('SIMULATED')),
      ),
    );
    packages.set(item.lessonVersion, p);
    assert(
      credentials.accounts.some(
        (a) =>
          a.id === h.collection.childIdsByLesson[item.lessonVersion] &&
          a.role === 'child',
      ),
    );
  }
  await fs.mkdir(output, { mode: 0o700 });
  const scriptDigest = hash(await fs.readFile(new URL(import.meta.url)));
  assert.equal(
    fileURLToPath(import.meta.url),
    path.join(manifest.snapshot, 'tests/readiness-r5/positive-target.mjs'),
  );
  assert(manifest.files.includes('tests/readiness-r5/positive-target.mjs'));
  const testerFiles = await Promise.all(
    [
      'positive-target.mjs',
      'http-runner.mjs',
      'http-suite.mjs',
      'oracle.mjs',
    ].map(async (name) => ({
      path: 'tests/readiness-r5/' + name,
      sha256: hash(await fs.readFile(new URL(name, import.meta.url))),
    })),
  );
  const results = [],
    completed = [],
    touched = new Map();
  let adapter;
  const report = () =>
    fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          schemaVersion: 'r5-positive-target-report-1',
          outcome: results.some((r) => r.outcome === 'FAIL')
            ? 'FAIL'
            : 'IN_PROGRESS',
          candidateId: h.candidateId,
          sourceDigest: h.sourceDigest,
          artifactDigest: h.artifactDigest,
          buildId: h.buildId,
          evidenceInstallationId: h.evidenceInstallationId,
          targetInstallationId: h.targetInstallationId,
          collectionVersion: fixed.collectionVersion,
          collectionDigest: h.collection.collectionDigest,
          scriptDigest,
          testerFiles,
          results,
          limitations: [
            'All reviewer/owner inputs are labelled SIMULATED QA; no human Mandarin/device/owner acceptance.',
            'Ordinary target later visits are not time-shifted; per-package delayed evidence is executed on the separate evidence installation by the fixed signer coordinator.',
            'This runner does not launch/stop the service; the private runtime owner must clean all owned databases/processes.',
          ],
        },
        null,
        2,
      ) + '\n',
    );
  async function testcase(id, ears, run) {
    try {
      const evidence = await run();
      results.push({ id, ears, outcome: 'PASS', evidence });
    } catch (error) {
      results.push({ id, ears, outcome: 'FAIL', failure: redactError(error) });
      await report();
      throw error;
    }
    await report();
  }
  async function control(base, route, body, timeout = 120000) {
    const response = await fetch(new URL(route, base), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hanzi-Test-Token': credentials.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      redirect: 'error',
    });
    const value = await response.json();
    assert.equal(response.status, 200, `Closed ${route} status`);
    return value;
  }
  const counts = () =>
    control(h.controlURL, '/inspect', { target: 'ordinary', kind: 'counts' });
  const publications = () =>
    control(h.controlURL, '/inspect', {
      target: 'ordinary',
      kind: 'publication',
    });
  const collectionCounts = () =>
    control(h.collection.controlURL, '/inspect', {
      target: 'ordinary',
      kind: 'counts',
    });
  let originalCookie = null;
  try {
    adapter = await createHttpAdapter(h, output);
    const request = async (who, method, endpoint, body, options = {}) => {
      const base = options.base ?? h.targetBaseURL;
      touched.set(base + who.id, { who, base });
      return adapter.request(who, method, endpoint, body, { ...options, base });
    };
    const ordinary = { ...adapter, request };
    await testcase(
      'P5-001-private-profile-target-import',
      ['R5-P-001', 'R5-P-003'],
      async () => {
        const installation = await control(h.controlURL, '/inspect', {
          target: 'ordinary',
          kind: 'installation',
        });
        assert.equal(installation.installationId, h.targetInstallationId);
        for (const item of fixed.items) {
          const r = await request(operator, 'POST', '/api/pilot/curriculum', {
            package: packages.get(item.lessonVersion),
          });
          assert.equal(r.status, 201);
          assert.equal(r.body.contentDigest, item.contentDigest);
        }
        const registered = await request(
          operator,
          'POST',
          '/api/pilot/collections',
          { collection: fixed },
        );
        assert.equal(registered.status, 200);
        assert.equal(
          registered.body.collectionDigest,
          h.collection.collectionDigest,
        );
        for (const route of [
          '/api/test/pilot/story-bootstrap',
          '/api/test/pilot/story-positive-bootstrap',
        ]) {
          const denied = await request(operator, 'POST', route, {
            fixture: 'family-story',
          });
          assert.equal(denied.status, 404);
        }
        return {
          importedPackages: 10,
          registeredCollection: registered.body,
          ordinaryTargetInstallation: installation.installationId,
        };
      },
    );
    for (const item of fixed.items) {
      const version = item.lessonVersion,
        endpoint = '/api/pilot/curriculum/' + version;
      await testcase(
        'P5-' + version + '-ordinary-journey',
        ['R5-P-002', 'R5-P-003'],
        async () => {
          const signed = await control(
            h.collection.controlURL,
            '/verify-and-sign',
            { suite: 'collection', lessonVersion: version },
            1200000,
          );
          assert.equal(signed.receipt.lessonVersion, version);
          assert.equal(signed.receipt.contentDigest, item.contentDigest);
          assert.equal(
            signed.receipt.targetInstallationId,
            h.targetInstallationId,
          );
          assert.equal(
            signed.receipt.evidenceInstallationId,
            h.evidenceInstallationId,
          );
          assert.equal(signed.receipt.syntheticOnly, true);
          assert.equal(signed.receipt.issuerId, h.targetIssuer.issuerId);
          assert.equal(signed.receipt.namespace, h.namespace);
          assert.equal(signed.receipt.buildId, h.buildId);
          assert.equal(signed.receipt.adapterId, COLLECTION.adapter);
          assert.equal(
            signed.receipt.adapterVersion,
            COLLECTION.adapterVersion,
          );
          assert.equal(signed.receipt.candidateId, h.candidateId);
          assert.equal(signed.receipt.sourceDigest, h.sourceDigest);
          assert.equal(signed.receipt.artifactDigest, h.artifactDigest);
          assert.deepEqual(
            signed.receipt.scenarios.map((s) => s.id).sort(),
            [...SCENARIOS].sort(),
          );
          assert(
            signed.receipt.scenarios.every(
              (s) =>
                s.outcome === 'PASS' &&
                /^sha256:[a-f0-9]{64}$/.test(s.evidenceDigest),
            ),
          );
          assert(
            verify(
              null,
              Buffer.from(JSON.stringify(canonical(signed.receipt))),
              createPublicKey({
                key: h.targetIssuer.publicKeyJwk,
                format: 'jwk',
              }),
              Buffer.from(signed.signature, 'base64url'),
            ),
          );
          await fs.writeFile(
            path.join(output, version + '-receipt.json'),
            JSON.stringify(signed, null, 2) + '\n',
            { mode: 0o600, flag: 'wx' },
          );
          const detail = await request(operator, 'GET', endpoint);
          assert.equal(detail.status, 200);
          assert.equal(detail.body.contentDigest, item.contentDigest);
          const review = await request(
            operator,
            'POST',
            endpoint + '/reviews',
            reviewBody(item, detail.body.reviews.at(-1)?.reviewId ?? null),
          );
          assert.equal(review.status, 201);
          assert(review.body.reviewId);
          const proof = await request(
            operator,
            'POST',
            '/api/pilot/curriculum/proofs',
            signed,
          );
          assert.equal(proof.status, 200);
          assert.equal(proof.body.eligible, true);
          const scope = {
            kind: 'supervised-trial',
            members: [
              {
                childId: h.collection.childIdsByLesson[version],
                parentId: parent.id,
                planScope: version,
              },
            ],
          };
          const owner = await request(
            operator,
            'POST',
            endpoint + '/decisions',
            {
              requestId: 'qa-simulated-owner-' + randomUUID(),
              contentDigest: item.contentDigest,
              candidateId: h.candidateId,
              artifactDigest: h.artifactDigest,
              targetInstallationId: h.targetInstallationId,
              scope,
              ownerIdentity: 'SIMULATED QA owner; not Parent or actual owner',
              decision: 'accepted',
              decidedAt: Date.now(),
              evidenceRef: 'SIMULATED/collection-positive/owner-policy-only',
            },
          );
          assert.equal(owner.status, 200);
          assert(owner.body.decisionId);
          const body = publicationBody(
            h,
            item,
            scope,
            null,
            review.body.reviewId,
            signed.receipt.receiptId,
            owner.body.decisionId,
          );
          const published = await request(
            operator,
            'POST',
            endpoint + '/publications',
            body,
          );
          assert.equal(published.status, 200);
          const head = (await publications()).publications
            .filter((p) => p.lesson_version === version)
            .at(-1);
          assert(head);
          assert.equal(head.id, published.body.publicationId);
          assert.equal(head.status, 'released');
          assert.equal(head.test_run_id, null);
          assert.equal(head.review_id, review.body.reviewId);
          assert.equal(head.proof_id, signed.receipt.receiptId);
          assert.equal(head.owner_decision_id, owner.body.decisionId);
          const child = {
            id: h.collection.childIdsByLesson[version],
            label: 'package-child',
          };
          const setup = await request(
            parent,
            'PUT',
            '/api/pilot/children/' + child.id + '/onboarding',
            {
              nickname: 'SIMULATED QA ' + version,
              experience: 'new',
              audioReady: true,
            },
          );
          assert.equal(setup.status, 200);
          const f = { parent, child, operator, otherParent: foreign };
          const started = await selectStart(ordinary, f, version);
          assert.equal(started.initial.contentDigest, item.contentDigest);
          assert.equal(started.initial.publicationId, head.id);
          const run = await completeRun(ordinary, child, started.runId);
          assert.equal(run.installationId, h.targetInstallationId);
          assert.equal(run.childId, child.id);
          assert.equal(run.lessonVersion, version);
          assert.equal(run.contentDigest, item.contentDigest);
          assert.equal(run.state.phase, 'initial');
          assert(run.state.completedAt);
          assert.equal(run.publicationId, head.id);
          assert.equal(run.soundReview, 'reviewed');
          assert(!JSON.stringify(run).includes('correctChoiceId'));
          const progress = await request(
              parent,
              'GET',
              '/api/pilot/children/' + child.id + '/progress',
            ),
            exported = await request(
              parent,
              'GET',
              '/api/pilot/children/' + child.id + '/export',
            );
          assert.equal(progress.status, 200);
          assert.equal(exported.status, 200);
          assert(!JSON.stringify(progress.body).includes('correctChoiceId'));
          assert(!JSON.stringify(exported.body).includes('correctChoiceId'));
          const group = progress.body.collections.find(
            (c) => c.collectionVersion === fixed.collectionVersion,
          );
          assert(group);
          assert.equal(group.installationId, h.targetInstallationId);
          assert.equal(group.collectionDigest, h.collection.collectionDigest);
          const visit = group.visits.find((v) => v.runId === run.runId);
          assert(visit);
          assert.equal(visit.phase, 'initial');
          assert.equal(visit.contentDigest, item.contentDigest);
          assert.equal(visit.lessonVersion, version);
          assert.deepEqual(visit.recap, run.recap);
          assert.equal(visit.completedAt, run.state.completedAt);
          assert.deepEqual(
            stableProgress(exported.body.collections),
            stableProgress(progress.body.collections),
          );
          for (const suffix of ['/progress', '/export'])
            assert.equal(
              (
                await request(
                  foreign,
                  'GET',
                  '/api/pilot/children/' + child.id + suffix,
                )
              ).status,
              404,
            );
          assert.equal(
            (
              await request(
                foreign,
                'GET',
                '/api/pilot/curriculum/learning-runs/' + run.runId,
              )
            ).status,
            404,
          );
          completed.push({
            item,
            run,
            child,
            scope,
            head,
            reviewId: review.body.reviewId,
            ownerId: owner.body.decisionId,
            proofId: signed.receipt.receiptId,
            signed,
            progress: group,
          });
          return {
            lessonVersion: version,
            contentDigest: item.contentDigest,
            receiptId: signed.receipt.receiptId,
            reviewId: review.body.reviewId,
            ownerDecisionId: owner.body.decisionId,
            publicationId: head.id,
            assignmentId: started.initial.assignmentId,
            scheduleId: started.initial.scheduleId,
            runId: run.runId,
            completedAt: run.state.completedAt,
            recap: run.recap,
            foreignDenials: 3,
            simulated: true,
          };
        },
      );
    }
    await testcase(
      'P5-012-tamper-wrong-package-refusal',
      ['R5-P-003'],
      async () => {
        const before = await counts();
        const source = completed[0],
          other = completed[1];
        const results = [];
        for (const changes of [
          {
            contentDigest: other.item.contentDigest,
            lessonVersion: other.item.lessonVersion,
          },
          { reportDigest: 'sha256:' + '0'.repeat(64) },
        ]) {
          const bad = {
            receipt: {
              ...source.signed.receipt,
              ...changes,
              receiptId: 'qa-negative-' + randomUUID(),
            },
            signature: source.signed.signature,
          };
          const r = await request(
            operator,
            'POST',
            '/api/pilot/curriculum/proofs',
            bad,
          );
          assert.equal(r.status, 409);
          assert(
            [
              'PROOF_INVALID',
              'PROOF_UNTRUSTED',
              'PROOF_IDENTITY_MISMATCH',
            ].includes(r.body.error?.code),
          );
          results.push({ status: r.status, code: r.body.error.code });
        }
        assert.deepEqual(await counts(), before);
        return { results, unchangedAuthorityCounts: true };
      },
    );
    await testcase('P5-013-positive-v5-recovery', ['R5-P-004'], async () => {
      const populated = await collectionCounts();
      assert.deepEqual(
        Object.keys(populated).sort(),
        [...COLLECTION_TABLES].sort(),
      );
      for (const table of COLLECTION_TABLES)
        assert(populated[table] > 0, table + ' populated');
      const account = credentials.accounts.find((a) => a.id === parent.id);
      const signIn = await fetch(
        new URL('/api/auth/sign-in/username', h.targetBaseURL),
        {
          method: 'POST',
          headers: {
            Origin: h.targetBaseURL,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: account.username,
            password: account.password,
          }),
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        },
      );
      assert.equal(signIn.status, 200);
      originalCookie = signIn.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
      assert(originalCookie);
      const backup = await control(h.controlURL, '/backup', {
        target: 'ordinary',
        name: 'populated',
      });
      assert.equal(Object.keys(backup.counts).length, 45);
      assert.equal(backup.installationId, h.targetInstallationId);
      assert.equal(backup.format, 'pilot-admin-backup-5');
      const restored = await control(h.controlURL, '/restore', {
        target: 'ordinary',
        name: 'populated',
        fault: 'none',
      });
      assert(restored.baseURL);
      loopback(restored.baseURL);
      assert.notEqual(restored.readback.installationId, h.targetInstallationId);
      assert.equal(restored.readback.sessionCount, 0);
      assert.equal(restored.readback.verificationCount, 0);
      assert.equal(Object.keys(restored.readback.counts).length, 45);
      for (const table of COLLECTION_TABLES)
        assert.equal(restored.readback.counts[table], populated[table]);
      const old = await fetch(new URL('/api/pilot/me', restored.baseURL), {
        headers: { Origin: restored.baseURL, Cookie: originalCookie },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      assert.equal(old.status, 401);
      for (const c of completed) {
        const history = await request(
          parent,
          'GET',
          '/api/pilot/curriculum/learning-runs/' + c.run.runId,
          undefined,
          { base: restored.baseURL },
        );
        assert.equal(history.status, 200);
        assert.equal(history.body.installationId, h.targetInstallationId);
        assert.equal(history.body.available, false);
        assert.equal(history.body.contentDigest, c.item.contentDigest);
        assert.deepEqual(history.body.recap, c.run.recap);
        assert.equal(history.body.state.completedAt, c.run.state.completedAt);
        const denied = await request(
          c.child,
          'POST',
          '/api/pilot/curriculum/learning-runs/' + c.run.runId + '/actions',
          {
            eventId: randomUUID(),
            expectedRevision: history.body.revision,
            occurrenceId: history.body.question?.occurrenceId ?? null,
            type: 'continue',
            payload: {},
          },
          { base: restored.baseURL },
        );
        assert([403, 409].includes(denied.status));
        const progress = await request(
          parent,
          'GET',
          '/api/pilot/children/' + c.child.id + '/progress',
          undefined,
          { base: restored.baseURL },
        );
        assert.equal(progress.status, 200);
        const group = progress.body.collections.find(
          (p) => p.collectionVersion === fixed.collectionVersion,
        );
        assert(group);
        assert.equal(group.installationId, restored.readback.installationId);
        assert.deepEqual(
          group.visits.find((v) => v.runId === c.run.runId).recap,
          c.run.recap,
        );
      }
      return {
        backup,
        restoreReadback: restored.readback,
        oldCookieStatus: old.status,
        historicalRuns: completed.length,
        oldAuthorityDenied: true,
      };
    });
    await testcase(
      'P5-014-withdrawal-review-invalidation',
      ['R5-P-003'],
      async () => {
        const withdrawn = completed[0],
          rejected = completed[1];
        const response = await request(
          operator,
          'POST',
          '/api/pilot/curriculum/' +
            withdrawn.item.lessonVersion +
            '/publications',
          publicationBody(
            h,
            withdrawn.item,
            withdrawn.scope,
            withdrawn.head,
            withdrawn.reviewId,
            withdrawn.proofId,
            withdrawn.ownerId,
            'withdrawn',
          ),
        );
        assert.equal(response.status, 200);
        const unavailable = await request(
          withdrawn.child,
          'GET',
          '/api/pilot/curriculum/learning-runs/' + withdrawn.run.runId,
        );
        assert.equal(unavailable.status, 200);
        assert.equal(unavailable.body.available, false);
        assert.deepEqual(unavailable.body.recap, withdrawn.run.recap);
        const deniedReview = await request(
          operator,
          'POST',
          '/api/pilot/curriculum/' + rejected.item.lessonVersion + '/reviews',
          reviewBody(rejected.item, rejected.reviewId, 'rejected'),
        );
        assert.equal(deniedReview.status, 201);
        const before = await counts();
        const release = await request(
          operator,
          'POST',
          '/api/pilot/curriculum/' +
            rejected.item.lessonVersion +
            '/publications',
          publicationBody(
            h,
            rejected.item,
            rejected.scope,
            rejected.head,
            rejected.reviewId,
            rejected.proofId,
            rejected.ownerId,
          ),
        );
        assert.equal(release.status, 409);
        assert.equal(release.body.error?.code, 'RELEASE_PREREQUISITES');
        assert.deepEqual(await counts(), before);
        const history = await request(
          rejected.child,
          'GET',
          '/api/pilot/curriculum/learning-runs/' + rejected.run.runId,
        );
        assert.equal(history.status, 200);
        assert.equal(history.body.available, false);
        assert.deepEqual(history.body.recap, rejected.run.recap);
        return {
          withdrawal: response.body,
          reviewInvalidation: deniedReview.body,
          rejectedReleaseStatus: release.status,
          historyPreserved: true,
          scope:
            'Representative path-01 withdrawal/path-02 newer rejected review; not every package trust-state combination.',
        };
      },
    );
    await adapter.verifyFrozenIdentity();
  } finally {
    const cleanup = [];
    if (originalCookie) {
      try {
        const response = await fetch(
          new URL('/api/auth/sign-out', h.targetBaseURL),
          {
            method: 'POST',
            headers: {
              Origin: h.targetBaseURL,
              Cookie: originalCookie,
              'Content-Type': 'application/json',
            },
            body: '{}',
            signal: AbortSignal.timeout(15000),
            redirect: 'error',
          },
        );
        cleanup.push({
          role: 'parent',
          session: 'held-original',
          status: response.status,
        });
      } catch {
        cleanup.push({ session: 'held-original', status: 'UNCONFIRMED' });
      }
      originalCookie = null;
    }
    if (adapter)
      for (const { who, base } of touched.values()) {
        try {
          const r = await adapter.request(
            who,
            'POST',
            '/api/auth/sign-out',
            {},
            { base },
          );
          cleanup.push({
            role: credentials.accounts.find((a) => a.id === who.id)?.role,
            status: r.status,
          });
        } catch {
          cleanup.push({ status: 'UNCONFIRMED' });
        }
      }
    await fs.writeFile(
      path.join(output, 'cleanup.json'),
      JSON.stringify(
        {
          ordinarySessionSignOut: cleanup,
          ownedProcessesLaunched: 0,
          ownedBrowserContexts: 0,
          privateCredentialsCopied: false,
          runtimeCleanup:
            'Runtime owner must stop its owned processes/databases separately.',
        },
        null,
        2,
      ) + '\n',
    );
    await report();
  }
  const result = await json(path.join(output, 'report.json'));
  result.scriptDigest = hash(await fs.readFile(new URL(import.meta.url)));
  result.outcome =
    results.length === 14 && results.every((r) => r.outcome === 'PASS')
      ? 'PASS'
      : 'FAIL';
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    assert.equal(args.length, 4);
    assert.equal(args[0], '--handoff');
    assert.equal(args[2], '--output');
    const result = await runPositiveTarget(args[1], args[3]);
    process.exitCode = result.outcome === 'PASS' ? 0 : 1;
  } catch (error) {
    process.stderr.write(JSON.stringify(redactError(error)) + '\n');
    process.exitCode = 1;
  }
}
