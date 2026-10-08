import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCorpusPlacement,
  normalizeCorpusPlans,
  normalizeCorpusPractice,
  normalizeCorpusProgress,
  createCorpusFamilyClient,
} from '../lib/pilot-corpus-client.ts';
const d = 'sha256:' + 'a'.repeat(64),
  scope = {
    accountId: 'parent',
    installationId: 'now',
    childId: 'child',
    corpusVersion: 'corpus-v1',
  };
const identity = {
  corpusId: 'corpus',
  corpusVersion: 'corpus-v1',
  corpusDigest: d,
};
const pkg = {
  ...identity,
  lessonId: 'lesson',
  lessonVersion: 'lesson-v1',
  contentDigest: d,
  adapterId: 'corpus-paired',
  adapterVersion: 'corpus-paired-v1',
};
const targets = [
  { characterId: 'a', hanzi: '木' },
  { characterId: 'b', hanzi: '林' },
];
const item = () => ({
  ...pkg,
  title: 'A woodland story',
  targets,
  trackId: 'track',
  sequence: 1,
  releaseId: 'release',
  releaseRevision: 1,
  available: false,
  reason: 'Historical learning',
  assignmentId: 'assignment',
  completed: true,
  planItemId: 'item',
  ordinal: 0,
});
const plan = (origin) => ({
  ...identity,
  planId: 'plan-' + origin.slice(0, 10),
  proposalId: 'proposal',
  childId: 'child',
  installationId: origin,
  approvedAt: '2026-09-27T00:00:00.000Z',
  available: false,
  reason: 'Historical learning',
  items: [item()],
});
const practice = (origin) => ({
  ...pkg,
  title: 'A woodland story',
  targets,
  installationId: origin,
  assignmentId: 'assignment',
  scheduleId: 'schedule',
  runId: null,
  releaseId: 'release',
  releaseRevision: 1,
  kind: 'review-24h',
  dueAt: '2026-09-28T00:00:00.000Z',
  available: false,
  reason: 'Historical learning',
  stepId: null,
});
const group = (origin) => ({
  ...identity,
  schemaVersion: 'r6-family-progress-1',
  installationId: origin,
  childId: 'child',
  plans: [plan(origin)],
  practice: [practice(origin)],
  visits: [],
  evidenceLimits: ['No human acceptance'],
});
const proposal = () => ({
  ...pkg,
  title: 'Saved woodland story',
  targets,
  proposalId: 'proposal',
  childId: 'child',
  installationId: 'now',
  predecessorProposalId: null,
  selectionOrdinal: 0,
  releaseId: 'release',
  releaseRevision: 1,
  sourceDigest: d,
  reason: 'The saved parent choice.',
  selectedByParent: true,
  createdAt: '2026-09-27T00:00:00.000Z',
  expiresAt: '2026-09-28T00:00:00.000Z',
});
test('same corpus across original origins is retained; duplicate origin and mixed nested digest refuse', () => {
  assert.equal(
    normalizeCorpusProgress([group('old'), group('now')], scope).length,
    2,
  );
  assert.throws(() =>
    normalizeCorpusProgress([group('old'), group('old')], scope),
  );
  const bad = group('old');
  bad.plans[0].items[0].corpusDigest = 'sha256:' + 'b'.repeat(64);
  assert.throws(() => normalizeCorpusProgress([bad], scope));
});
test('historical plan is readable, cannot become current or actionable, and foreign child refuses', () => {
  assert.equal(
    normalizeCorpusPlans({ plan: null, history: [plan('old')] }, scope)
      .history[0].installationId,
    'old',
  );
  assert.throws(() =>
    normalizeCorpusPlans({ plan: plan('old'), history: [] }, scope),
  );
  const bad = plan('old');
  bad.childId = 'other';
  assert.throws(() =>
    normalizeCorpusPlans({ plan: null, history: [bad] }, scope),
  );
  const active = practice('old');
  active.available = true;
  assert.throws(() =>
    normalizeCorpusPractice(
      {
        items: [active],
        primary: {
          kind: 'prepare',
          assignmentId: null,
          scheduleId: null,
          runId: null,
        },
      },
      scope,
    ),
  );
});
test('quiet safe DTO refuses extra grading keys/getters and accepts empty authorized wrappers', () => {
  assert.equal(
    JSON.stringify(
      normalizeCorpusPlacement(
        { setupComplete: false, proposal: null, reason: null },
        scope,
      ),
    ),
    JSON.stringify({ setupComplete: false, proposal: null, reason: null }),
  );
  assert.throws(() =>
    normalizeCorpusPlacement(
      {
        setupComplete: true,
        proposal: { ...proposal(), correctChoiceId: 'answer' },
        reason: null,
      },
      scope,
    ),
  );
  let reads = 0;
  const p = proposal();
  Object.defineProperty(p, 'title', {
    enumerable: true,
    get() {
      reads++;
      return 'private';
    },
  });
  assert.throws(() =>
    normalizeCorpusPlacement(
      { setupComplete: true, proposal: p, reason: null },
      scope,
    ),
  );
  assert.equal(reads, 0);
});
test('family API uses explicit selectors/exact mutation wire and saved safe title', async () => {
  const calls = [];
  const me = { installationId: 'now', user: { id: 'parent', role: 'parent' } };
  const api = createCorpusFamilyClient(me, 'corpus-v1', {
    verify: async () => true,
    request: async (path, options) => {
      calls.push({ path, options });
      return path.endsWith('catalog/proposals')
        ? { proposal: proposal() }
        : { setupComplete: true, proposal: null, reason: null };
    },
  });
  await api.placement('child');
  const body = {
    corpusVersion: 'corpus-v1',
    selection: null,
    predecessorProposalId: null,
    expectedSourceDigest: null,
  };
  assert.equal(
    (await api.propose('child', body)).proposal.title,
    'Saved woodland story',
  );
  assert.equal(
    calls[0].path,
    '/api/pilot/children/child/placement?corpusVersion=corpus-v1',
  );
  assert.deepEqual(JSON.parse(calls[1].options.body), body);
  assert.throws(() =>
    normalizeCorpusPlacement(
      {
        setupComplete: true,
        proposal: { ...proposal(), installationId: 'foreign' },
        reason: null,
      },
      scope,
    ),
  );
});
test('held family read refuses late identity changes and nonparent mutation makes no request', async () => {
  let allowed = true,
    release,
    calls = 0;
  const held = new Promise((r) => (release = r));
  const api = createCorpusFamilyClient(
    { installationId: 'now', user: { id: 'parent', role: 'parent' } },
    'corpus-v1',
    {
      verify: async () => allowed,
      request: async () => {
        calls++;
        return held;
      },
    },
  );
  const reading = api.placement('child');
  await new Promise((r) => setImmediate(r));
  allowed = false;
  release({ setupComplete: true, proposal: null, reason: null });
  await assert.rejects(reading, (e) => e.code === 'IDENTITY_CHANGED');
  const child = createCorpusFamilyClient(
    { installationId: 'now', user: { id: 'child', role: 'child' } },
    'corpus-v1',
    {
      verify: async () => true,
      request: async () => {
        calls++;
        return {};
      },
    },
  );
  await assert.rejects(child.propose('child', {}), (e) => e.status === 403);
  assert.equal(calls, 1);
});

test('the explicit 240-character original installation exception survives family reads', () => {
  const origin = 'x'.repeat(240);
  assert.equal(
    normalizeCorpusProgress([group(origin)], scope)[0].installationId,
    origin,
  );
  const longScope = { ...scope, installationId: origin };
  assert.equal(
    normalizeCorpusPlacement(
      {
        setupComplete: true,
        proposal: { ...proposal(), installationId: origin },
        reason: null,
      },
      longScope,
    ).proposal.installationId,
    origin,
  );
  assert.throws(() => normalizeCorpusProgress([group('x'.repeat(241))], scope));
});

test('teacher reads assigned progress but export is parent-only and never issues the denied request', async () => {
  const paths = [];
  const teacher = createCorpusFamilyClient(
    { installationId: 'now', user: { id: 'teacher', role: 'teacher' } },
    'corpus-v1',
    {
      verify: async () => true,
      request: async (path) => {
        paths.push(path);
        return { corpora: [group('now')] };
      },
    },
  );
  assert.equal((await teacher.progress('child')).length, 1);
  await assert.rejects(
    teacher.export('child'),
    (e) => e.status === 403 && e.code === 'FORBIDDEN',
  );
  assert.deepEqual(paths, ['/api/pilot/children/child/progress']);
});
