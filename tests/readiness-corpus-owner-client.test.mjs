import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCorpusOwnerReview,
  normalizeCorpusOwnerItem,
} from '../lib/pilot-corpus-owner-client.ts';
const digest = 'sha256:' + 'a'.repeat(64),
  other = 'sha256:' + 'b'.repeat(64);
const item = () => ({
  schemaVersion: 'r6-owner-item-1',
  snapshotId: 'snapshot',
  lessonVersion: 'corpus-lesson-v1',
  contentDigest: digest,
  title: 'Forest paths',
  targets: ['木', '林'].map((hanzi, i) => ({
    characterId: `char-${i}`,
    hanzi,
    meanings: ['tree'],
    readings: [{ pinyin: 'mù', audioText: hanzi }],
    words: [0, 1].map((_w) => ({
      text: `${hanzi}木`,
      pinyin: 'mù mù',
      english: 'trees',
      context: { hanzi: '这里有树木。', english: 'There are trees here.' },
    })),
    teaching: {
      instructionEnglish: 'Explore this character.',
      hintEnglish: 'Listen again.',
      demonstrationEnglish: 'Look at the character.',
    },
  })),
  readers: Array.from({ length: 4 }, () => ({
    title: 'A woodland walk',
    instructionEnglish: 'Read together.',
    text: '这里有树木。',
    english: 'There are trees here.',
  })),
  prompts: Array.from({ length: 10 }, (_, i) => ({
    phases: i < 8 ? ['initial'] : ['review-24h', 'review-7d'],
    stepId: i < 2 ? 'familiarity' : i < 6 ? 'practice' : 'check',
    instructionEnglish: 'Choose the character.',
    promptEnglish: 'Listen.',
    audioText: '木',
    expectedAnswerHanzi: '木',
  })),
  playback: {
    kind: 'local-device',
    voices: [],
    assets: Array.from({ length: 16 }, (_, i) => ({
      assetId: `audio-${i}`,
      url: null,
      digest: null,
      transcript: '木',
      reviewRef: 'review-audio',
    })),
  },
  imageRefs: Array.from({ length: 4 }, (_, i) => ({
    assetId: `image-${i}`,
    url: '/story/forest-01-v3/art/forest.svg',
    digest,
    licenseRef: 'license-image',
  })),
  evidenceRefs: {
    source: ['source'],
    contentReview: ['content'],
    audioReview: ['audio'],
    proof: ['proof'],
    assetInventory: ['assets'],
  },
});
const review = () => ({
  schemaVersion: 'r6-owner-review-1',
  snapshotId: 'snapshot',
  corpusVersion: 'corpus-v1',
  corpusDigest: digest,
  prospectiveDigest: digest,
  candidateId: 'candidate',
  sourceDigest: digest,
  artifactDigest: other,
  dataAt: '2026-09-27T03:30:00.000Z',
  counts: {
    fixture: 2,
    machineValidDraft: 0,
    reviewedReady: 0,
    supervisedTrial: 0,
    prospectiveStarter: 0,
    committedStarter: 0,
  },
  permittedScopes: [
    {
      scope: {
        kind: 'supervised-trial',
        members: [{ parentId: 'parent-a', childId: 'child-a' }],
      },
      scopeDigest: digest,
      available: true,
      reasonCode: null,
    },
  ],
  items: [
    {
      coverageIdentity: '木',
      characterId: 'char-0',
      lessonVersion: 'corpus-lesson-v1',
      contentDigest: digest,
      classification: 'verification-fixture',
      eligible: false,
      reasonCodes: ['FIXTURE'],
      evidenceRefs: ['source'],
    },
  ],
  nextCursor: null,
});
test('protected owner projection preserves actual teaching/context/expected answer without a grading import', () => {
  const r = normalizeCorpusOwnerItem(
    item(),
    'snapshot',
    'corpus-lesson-v1',
    digest,
  );
  assert.equal(r.prompts[0].expectedAnswerHanzi, '木');
  assert.equal(r.targets[0].words[0].context.english, 'There are trees here.');
  assert.equal(
    normalizeCorpusOwnerReview(review(), 'corpus-v1', 'snapshot').counts
      .reviewedReady,
    0,
  );
});
test('protected owner decoder refuses foreign snapshot/build identity and unbounded material', () => {
  assert.throws(() =>
    normalizeCorpusOwnerReview(review(), 'other', 'snapshot'),
  );
  assert.throws(() =>
    normalizeCorpusOwnerItem(item(), 'other', 'corpus-lesson-v1', digest),
  );
  const r = review();
  r.items = Array.from({ length: 21 }, () => structuredClone(r.items[0]));
  assert.throws(() =>
    normalizeCorpusOwnerReview(r, 'corpus-v1', 'snapshot', 20),
  );
  const d = item();
  d.prompts.push(structuredClone(d.prompts[0]));
  assert.throws(() =>
    normalizeCorpusOwnerItem(d, 'snapshot', 'corpus-lesson-v1', digest),
  );
});
test('protected owner decoder refuses private narrative/raw package and unsafe media URLs', () => {
  for (const key of ['privateFeedback', 'rawPackage', 'reviewerNarrative']) {
    const r = review();
    r[key] = 'private';
    assert.throws(() => normalizeCorpusOwnerReview(r, 'corpus-v1', 'snapshot'));
  }
  const d = item();
  d.imageRefs[0].url = 'javascript:alert(1)';
  assert.throws(() =>
    normalizeCorpusOwnerItem(d, 'snapshot', 'corpus-lesson-v1', digest),
  );
});
test('owner data refuses getters without invoking them', () => {
  let reads = 0;
  const d = item();
  Object.defineProperty(d, 'targets', {
    enumerable: true,
    get() {
      reads++;
      return [];
    },
  });
  assert.throws(() =>
    normalizeCorpusOwnerItem(d, 'snapshot', 'corpus-lesson-v1', digest),
  );
  assert.equal(reads, 0);
});
export { review, item, digest, other };
import { createCorpusOwnerReview } from '../lib/pilot-corpus-owner-client.ts';
const scope = {
  accountId: 'parent-a',
  installationId: 'installation',
  role: 'parent',
  corpusVersion: 'corpus-v1',
  snapshotId: 'snapshot',
};
const held = () => {
  let resolve;
  return {
    promise: new Promise((r) => (resolve = r)),
    release: (v) => resolve(v),
  };
};
const receipt = (requestId) => ({
  requestId,
  recordId: 'decision-record',
  recordedAt: '2026-09-27T03:30:00.000Z',
});
function harness(request = async () => review(), verify = async () => true) {
  return createCorpusOwnerReview({
    scope,
    request,
    verify,
    id: () => 'decision-original',
  });
}
test('no owner decision is inferred from reads or scope selection; confirmation sends exact protected binding', async () => {
  const calls = [];
  const c = harness(async (path, options) => {
    calls.push({ path, options });
    return options.method === 'POST'
      ? receipt(JSON.parse(options.body).requestId)
      : review();
  });
  await c.load();
  assert.equal(c.prepare('accepted'), false);
  assert.equal(c.chooseScope(digest), true);
  assert.equal(c.prepare('accepted'), true);
  assert.equal(calls.length, 1);
  await c.confirm();
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(
    Object.keys(body).sort(),
    [
      'requestId',
      'snapshotId',
      'corpusDigest',
      'candidateId',
      'sourceDigest',
      'artifactDigest',
      'scope',
      'decision',
    ].sort(),
  );
  assert.deepEqual(body, {
    requestId: 'decision-original',
    snapshotId: 'snapshot',
    corpusDigest: digest,
    candidateId: 'candidate',
    sourceDigest: digest,
    artifactDigest: other,
    scope: review().permittedScopes[0].scope,
    decision: 'accepted',
  });
  assert.equal(c.snapshot().status, 'saved');
  assert.equal(c.snapshot().receipt.recordId, 'decision-record');
  assert.equal(calls.filter((x) => x.options.method === 'POST').length, 1);
});
test('uncertain decision preserves original request body for explicit retry with no automatic writes', async () => {
  const bodies = [];
  const c = harness(async (_path, options) => {
    if (options.method === 'POST') {
      bodies.push(options.body);
      if (bodies.length === 1) throw { status: 503 };
      return receipt('decision-original');
    }
    return review();
  });
  await c.load();
  c.chooseScope(digest);
  c.prepare('rejected');
  await c.confirm();
  assert.equal(c.snapshot().status, 'pending');
  assert.equal(bodies.length, 1);
  assert.equal(c.snapshot().pending.decision, 'rejected');
  await c.retry();
  assert.deepEqual(bodies, [bodies[0], bodies[0]]);
  assert.equal(c.snapshot().pending, null);
  assert.equal(c.snapshot().status, 'saved');
});
test('known decision ACK then failed readback retries GET only and retains immutable receipt', async () => {
  let gets = 0,
    posts = 0;
  const c = harness(async (_path, options) => {
    if (options.method === 'POST') {
      posts++;
      return receipt('decision-original');
    }
    gets++;
    if (gets === 2) throw { status: 503 };
    return review();
  });
  await c.load();
  c.chooseScope(digest);
  c.prepare('accepted');
  await c.confirm();
  assert.equal(c.snapshot().status, 'readback-pending');
  assert.deepEqual(c.snapshot().receipt, receipt('decision-original'));
  assert.equal(c.snapshot().pending, null);
  await c.retry();
  assert.equal(posts, 1);
  assert.equal(gets, 3);
  assert.equal(c.snapshot().status, 'saved');
});
test('conflicting owner save clears old acceptance and requires fresh review and explicit new decision', async () => {
  let posts = 0;
  const c = harness(async (_path, options) => {
    if (options.method === 'POST') {
      posts++;
      throw { status: 409, code: 'SNAPSHOT_STALE' };
    }
    return review();
  });
  await c.load();
  c.chooseScope(digest);
  c.prepare('accepted');
  await c.confirm();
  assert.equal(c.snapshot().status, 'conflict');
  assert.equal(c.snapshot().review, null);
  assert.equal(c.snapshot().pending, null);
  assert.equal(c.snapshot().confirmation, null);
  await c.retry();
  assert.equal(posts, 1);
  await c.reload();
  assert.equal(c.snapshot().status, 'ready');
  assert.equal(c.prepare('accepted'), false);
  assert.equal(c.snapshot().selectedScopeDigest, null);
});
test('scope/build change between protected pages invalidates material and decision controls', async () => {
  let reads = 0;
  const c = harness(async () => {
    const r = review();
    r.nextCursor = 'c1.owner-next';
    if (++reads === 2) r.artifactDigest = digest;
    return r;
  });
  await c.load();
  c.chooseScope(digest);
  c.prepare('accepted');
  await c.next();
  assert.equal(c.snapshot().status, 'conflict');
  assert.equal(c.snapshot().review, null);
  assert.equal(c.snapshot().confirmation, null);
  assert.equal(c.snapshot().selectedScopeDigest, null);
});
test('held owner read and known save response after sign-out cannot repopulate old account', async () => {
  const read = held();
  let started = false;
  const c = harness(async () => {
    started = true;
    return read.promise;
  });
  const loading = c.load();
  while (!started) await new Promise((r) => setImmediate(r));
  c.lock();
  read.release(review());
  await loading;
  assert.equal(c.snapshot().review, null);
  assert.equal(c.snapshot().status, 'locked');
  const ack = held();
  let posted = false;
  const d = harness(async (_p, o) => {
    if (o.method === 'POST') {
      posted = true;
      return ack.promise;
    }
    return review();
  });
  await d.load();
  d.chooseScope(digest);
  d.prepare('accepted');
  const writing = d.confirm();
  while (!posted) await new Promise((r) => setImmediate(r));
  d.lock();
  ack.release(receipt('decision-original'));
  await writing;
  assert.equal(d.snapshot().receipt, null);
  assert.equal(d.snapshot().pending, null);
  assert.equal(d.snapshot().status, 'locked');
});
test('protected detail is exact loaded-page membership; held detail cannot survive scope lock', async () => {
  let requests = 0;
  const hold = held();
  const c = harness(async (path) => {
    requests++;
    return path.includes('/items/') ? hold.promise : review();
  });
  await c.load();
  await c.openItem('foreign', digest);
  assert.equal(requests, 1);
  const opening = c.openItem('corpus-lesson-v1', digest);
  while (requests < 2) await new Promise((r) => setImmediate(r));
  c.lock();
  hold.release(item());
  await opening;
  assert.equal(c.snapshot().detail, null);
  assert.equal(c.snapshot().status, 'locked');
});
test('owner page retry retains exact opaque request and commits back history only on success', async () => {
  const cursors = [];
  let fail = true;
  const c = harness(async (path) => {
    const cursor = new URL(path, 'http://local').searchParams.get('cursor');
    cursors.push(cursor);
    if (cursor === 'c1.owner-next' && fail) {
      fail = false;
      throw { status: 503 };
    }
    const r = review();
    r.nextCursor = cursor ? null : 'c1.owner-next';
    return r;
  });
  await c.load();
  await c.next();
  await c.retry();
  assert.deepEqual(cursors, [null, 'c1.owner-next', 'c1.owner-next']);
  assert.equal(c.snapshot().previous, true);
  await c.previous();
  assert.equal(c.snapshot().previous, false);
});
test('child/teacher role and revoked current session cannot expose owner review', async () => {
  for (const role of ['child', 'teacher'])
    assert.throws(() =>
      createCorpusOwnerReview({
        scope: { ...scope, role },
        verify: async () => true,
      }),
    );
  let requests = 0;
  const c = harness(
    async () => {
      requests++;
      return review();
    },
    async () => false,
  );
  await c.load();
  assert.equal(requests, 0);
  assert.equal(c.snapshot().status, 'locked');
});

test('current owner denial is unavailable rather than an invented sign-in problem, and clears protected material', async () => {
  let gets = 0;
  const c = harness(async () => {
    if (++gets === 2) throw { status: 403, code: 'FORBIDDEN' };
    return review();
  });
  await c.load();
  c.chooseScope(digest);
  c.prepare('accepted');
  await c.openItem('corpus-lesson-v1', digest);
  assert.equal(c.snapshot().status, 'unavailable');
  assert.equal(c.snapshot().review, null);
  assert.equal(c.snapshot().confirmation, null);
  assert.equal(c.snapshot().detail, null);
});
test('parent protected review refuses a foreign-family trial scope before displaying its member IDs', async () => {
  const c = harness(async () => {
    const r = review();
    r.permittedScopes[0].scope.members[0].parentId = 'foreign-parent';
    return r;
  });
  await c.load();
  assert.equal(c.snapshot().review, null);
  assert.equal(c.snapshot().status, 'error');
});

test('owner page-size change uses explicit bounded first-page request and never reuses old cursor', async () => {
  const paths = [];
  const c = harness(async (path) => {
    paths.push(new URL(path, 'http://local'));
    const r = review();
    r.nextCursor = 'c1.next';
    return r;
  });
  await c.load();
  await c.next();
  await c.pageSize(50);
  assert.equal(paths[2].searchParams.get('limit'), '50');
  assert.equal(paths[2].searchParams.get('cursor'), null);
  assert.equal(c.snapshot().previous, false);
  assert.equal(c.snapshot().limit, 50);
  await c.pageSize(51);
  assert.equal(paths.length, 3);
});
test('[OF01] owner display retains valid32 meanings and240-bound reading/word pinyin', () => {
  const d = item();
  d.targets[0].meanings = Array.from({ length: 32 }, (_, i) => `meaning ${i}`);
  d.targets[0].readings[0].pinyin = 'm'.repeat(180);
  d.targets[0].words[0].pinyin = 'm'.repeat(180);
  const result = normalizeCorpusOwnerItem(
    d,
    'snapshot',
    'corpus-lesson-v1',
    digest,
  );
  assert.equal(result.targets[0].meanings.length, 32);
  assert.equal(result.targets[0].readings[0].pinyin.length, 180);
  assert.equal(result.targets[0].words[0].pinyin.length, 180);
});
test('[OF01] owner display rejects unsupported17 readings', () => {
  const d = item();
  d.targets[0].readings = Array.from({ length: 17 }, () => ({
    pinyin: 'mù',
    audioText: '木',
  }));
  assert.throws(() =>
    normalizeCorpusOwnerItem(d, 'snapshot', 'corpus-lesson-v1', digest),
  );
});
test('[OF01] owner image license reference remains an inherited bounded display string', () => {
  const d = item();
  d.imageRefs[0].licenseRef = 'r'.repeat(180);
  assert.equal(
    normalizeCorpusOwnerItem(d, 'snapshot', 'corpus-lesson-v1', digest)
      .imageRefs[0].licenseRef.length,
    180,
  );
  d.imageRefs[0].licenseRef = 'r'.repeat(241);
  assert.throws(() =>
    normalizeCorpusOwnerItem(d, 'snapshot', 'corpus-lesson-v1', digest),
  );
});

test('[OF02] owner material accepts honest absent or bounded image references and still requires the complete playback inventory', () => {
  for (let count = 0; count <= 4; count++) {
    const d = item();
    d.imageRefs = d.imageRefs.slice(0, count);
    assert.equal(
      normalizeCorpusOwnerItem(d, 'snapshot', 'corpus-lesson-v1', digest)
        .imageRefs.length,
      count,
    );
  }
  const oversized = item();
  oversized.imageRefs.push({ ...oversized.imageRefs[0], assetId: 'image-5' });
  assert.throws(() =>
    normalizeCorpusOwnerItem(oversized, 'snapshot', 'corpus-lesson-v1', digest),
  );
  const missingCue = item();
  missingCue.imageRefs = [];
  missingCue.playback.assets.pop();
  assert.throws(() =>
    normalizeCorpusOwnerItem(
      missingCue,
      'snapshot',
      'corpus-lesson-v1',
      digest,
    ),
  );
});

test('[OF03] distinct playback cue rows may share the actual declared asset reference', () => {
  const d = item();
  for (const row of d.playback.assets) row.assetId = 'asset-mandarin';
  assert.equal(
    normalizeCorpusOwnerItem(d, 'snapshot', 'corpus-lesson-v1', digest).playback
      .assets.length,
    16,
  );
  d.playback.assets.pop();
  assert.throws(() =>
    normalizeCorpusOwnerItem(d, 'snapshot', 'corpus-lesson-v1', digest),
  );
});

test('[OF04] owner scopes allow the closed starter, 100 individual trials, and combined trial bound', () => {
  const r = review();
  r.permittedScopes = Array.from({ length: 102 }, (_, i) => ({
    scope: {
      kind: 'supervised-trial',
      members: [{ parentId: 'parent-a', childId: `child-${i}` }],
    },
    scopeDigest: 'sha256:' + i.toString(16).padStart(64, '0'),
    available: true,
    reasonCode: null,
  }));
  assert.equal(
    normalizeCorpusOwnerReview(r, 'corpus-v1', 'snapshot').permittedScopes
      .length,
    102,
  );
  r.permittedScopes.push({
    ...r.permittedScopes[0],
    scopeDigest: 'sha256:' + 'f'.repeat(64),
  });
  assert.throws(() => normalizeCorpusOwnerReview(r, 'corpus-v1', 'snapshot'));
});
