import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectCorpusManifest,
  normalizeCoverageIdentity,
  normalizeCorpusSearch,
  corpusSearchMatches,
  inspectSourceRequest,
  assertSourceSuccessor,
  deriveCorpusCoverage,
  assertPublicationCAS,
  currentCorpusPackageAvailable,
  parseCorpusCapability,
  authorizeCorpusOwner,
  corpusRequestDigest,
  assertExactCorpusReplay,
} from '../lib/pilot/corpus-policy.ts';
const d = 'sha256:' + 'a'.repeat(64);
const manifest = () => ({
  schemaVersion: 'r6-corpus-1',
  corpusId: 'hanzi-starter',
  corpusVersion: 'starter-v1',
  canonicalizationVersion: 's3-json-1',
  policyVersion: 'r6-corpus-policy-1',
  items: [
    {
      lessonVersion: 'lesson-v1',
      contentDigest: d,
      batchId: 'batch-1',
      trackId: 'track-1',
      sequence: 1,
    },
  ],
});
const target = (hanzi, overrides = {}) => ({
  characterId: 'character-' + hanzi,
  hanzi,
  classification: 'real-source-reviewed',
  identityKind: 'simplified',
  machineValid: true,
  licensed: true,
  wordsComplete: true,
  contentReviewed: true,
  audioReviewed: true,
  promptsComplete: true,
  assetsComplete: true,
  proofValid: true,
  current: true,
  placeholder: false,
  ...overrides,
});
const pkg = (lessonVersion, targets, extra = {}) => ({
  lessonVersion,
  ordinal: 0,
  prospective: false,
  contentDigest: d,
  targets,
  trial: false,
  committed: false,
  ...extra,
});
const source = () => ({
  requestId: 'source-1',
  lessonVersion: 'lesson-v1',
  contentDigest: d,
  classification: 'real-source-reviewed',
  sourceRefs: ['source-ref'],
  licenseRefs: ['license-ref'],
  reviewRefs: ['review-1'],
  identityReviews: [
    {
      characterId: 'mu',
      hanzi: '木',
      kind: 'simplified',
      reviewRef: 'review-1',
    },
    {
      characterId: 'lin',
      hanzi: '林',
      kind: 'simplified',
      reviewRef: 'review-1',
    },
  ],
  predecessorEvidenceId: null,
  expectedEvidenceDigest: null,
});
test('E001 bounded manifest rejects unknown policy, duplicate versions and getters without execution', () => {
  assert.equal(inspectCorpusManifest(manifest()).items.length, 1);
  assert.throws(() =>
    inspectCorpusManifest({ ...manifest(), policyVersion: 'r5-policy' }),
  );
  assert.throws(() =>
    inspectCorpusManifest({
      ...manifest(),
      items: [manifest().items[0], manifest().items[0]],
    }),
  );
  let reads = 0;
  const hostile = manifest();
  Object.defineProperty(hostile, 'items', {
    enumerable: true,
    get() {
      reads++;
      return [];
    },
  });
  assert.throws(() => inspectCorpusManifest(hostile));
  assert.equal(reads, 0);
});
test('E003 identity rejects variation/multiscalar/traditional inference; explicit identity review required', () => {
  assert.equal(normalizeCoverageIdentity('木'), '木');
  for (const bad of ['木林', '木\uFE00', 'A', ''])
    assert.throws(() => normalizeCoverageIdentity(bad));
  assert.equal(normalizeCoverageIdentity('門'), '門');
  const targets = [
    { characterId: 'mu', hanzi: '木' },
    { characterId: 'lin', hanzi: '林' },
  ];
  assert.equal(
    inspectSourceRequest(source(), targets, ['review-1']).identityReviews
      .length,
    2,
  );
  assert.throws(() =>
    inspectSourceRequest({ ...source(), identityReviews: [] }, targets, [
      'review-1',
    ]),
  );
  assert.throws(() =>
    inspectSourceRequest(source(), targets, ['older-review']),
  );
});
test('E002 fixture successor cannot promote and stale lineage cannot branch', () => {
  const head = {
    id: 'source-old',
    lineageId: 'lineage-1',
    ordinal: 3,
    digest: d,
    classification: 'verification-fixture',
    lessonVersion: 'lesson-v1',
    contentDigest: d,
  };
  const req = {
    ...source(),
    predecessorEvidenceId: head.id,
    expectedEvidenceDigest: d,
  };
  assert.deepEqual(assertSourceSuccessor(req, head, false), {
    classification: 'verification-fixture',
    ordinal: 4,
    lineageId: 'lineage-1',
  });
  assert.equal(
    assertSourceSuccessor(source(), null, true).classification,
    'verification-fixture',
  );
  assert.throws(() =>
    assertSourceSuccessor(
      { ...req, predecessorEvidenceId: 'older' },
      head,
      false,
    ),
  );
});
test('E003 paired closure excludes both targets if companion audio missing, duplicate coverage does not exclude complete package', () => {
  const result = deriveCorpusCoverage([
    pkg('one', [target('木'), target('林', { audioReviewed: false })]),
    pkg('two', [target('日'), target('月')]),
    pkg('three', [target('日'), target('火')]),
  ]);
  assert.equal(result.counts.reviewedReady, 3);
  assert.deepEqual(
    result.releasedPackages.map((p) => p.lessonVersion),
    ['two', 'three'],
  );
  assert.ok(
    result.members
      .slice(0, 2)
      .every(
        (m) => !m.eligible && m.reasonCodes.includes('PACKAGE_INELIGIBLE'),
      ),
  );
  assert.ok(result.members[4].reasonCodes.includes('DUPLICATE_IDENTITY'));
});
test('E003 separate committed subset still counts identity represented by another eligible package', () => {
  const r = deriveCorpusCoverage([
    pkg('draft', [target('木'), target('林')], { prospective: true }),
    pkg('committed', [target('木'), target('日')], {
      committed: true,
      prospective: true,
    }),
  ]);
  assert.equal(r.counts.committedStarter, 2);
  assert.equal(r.counts.prospectiveStarter, 3);
});
test('E005 1600 fixture stress does not create any real readiness', () => {
  const items = [];
  for (let i = 0; i < 800; i++)
    items.push(
      pkg(
        'fixture-' + i,
        [
          target(String.fromCodePoint(0x4e00 + i * 2), {
            classification: 'verification-fixture',
          }),
          target(String.fromCodePoint(0x4e01 + i * 2), {
            classification: 'verification-fixture',
          }),
        ],
        { committed: true, trial: true },
      ),
    );
  const r = deriveCorpusCoverage(items);
  assert.equal(r.fixtureCharacterCount, 1600);
  assert.equal(r.verificationPackageCount, 800);
  for (const k of [
    'reviewedReady',
    'prospectiveStarter',
    'committedStarter',
    'supervisedTrial',
  ])
    assert.equal(r.counts[k], 0);
});
test('E008 threshold and head/epoch CAS; successful publication epoch advance does not self-invalidate', () => {
  const f = {
    scope: 'starter',
    includedCharacterCount: 1599,
    expectedRevision: 2,
    currentRevision: 2,
    predecessorId: 'group-2',
    currentHeadId: 'group-2',
    sealedEpoch: 4,
    currentEpoch: 4,
    ownerAccepted: true,
    allMembersCurrent: true,
  };
  assert.throws(() => assertPublicationCAS(f), /STARTER_THRESHOLD/);
  assertPublicationCAS({ ...f, includedCharacterCount: 1600 });
  assert.throws(
    () =>
      assertPublicationCAS({
        ...f,
        includedCharacterCount: 1600,
        currentEpoch: 5,
      }),
    /PUBLICATION_STALE/,
  );
  assert.equal(
    currentCorpusPackageAvailable({
      isCurrentHead: true,
      scopePermitted: true,
      packageCurrent: true,
    }),
    true,
  );
  assert.throws(
    () => assertPublicationCAS({ ...f, scope: 'verification' }),
    /VERIFICATION_FORBIDDEN/,
  );
});
test('E009 literal mixed search splits adjacent English/Hanzi and punctuation; no substring match', () => {
  assert.deepEqual(normalizeCorpusSearch('  TREe木， forest  ', 50), {
    q: 'tree木， forest',
    tokens: ['tree', '木', 'forest'],
    limit: 50,
  });
  assert.equal(corpusSearchMatches(['木', 'tre'], ['木头', 'tree']), true);
  assert.equal(corpusSearchMatches(['头'], ['木头']), false);
  assert.throws(() => normalizeCorpusSearch('a'.repeat(81)));
  assert.throws(() => normalizeCorpusSearch('', 51));
});
test('E007 default deny owner and current session/role checks, capability structural isolation', () => {
  const actor = {
    id: 'owner',
    role: 'operator',
    enabled: true,
    sessionExpiresAt: 101,
  };
  assert.equal(authorizeCorpusOwner([], actor, 100), false);
  assert.equal(authorizeCorpusOwner(['owner'], actor, 100), true);
  assert.equal(
    authorizeCorpusOwner(['owner'], { ...actor, role: 'teacher' }, 100),
    false,
  );
  assert.equal(authorizeCorpusOwner(['owner'], actor, 101), false);
  const cap = {
    installationId: 'install',
    corpusVersion: 'starter-v1',
    corpusDigest: d,
    namespace: 'test-1',
    parentIds: ['parent'],
    childIds: ['child'],
  };
  assert.equal(JSON.stringify(parseCorpusCapability(cap)), JSON.stringify(cap));
  assert.equal(
    parseCorpusCapability({ ...cap, childIds: ['child', 'child'] }),
    null,
  );
  assert.equal(parseCorpusCapability({ ...cap, threshold: 2 }), null);
});
test('E006 request identity binds actor/install/resource and exact immutable replay', async () => {
  const one = await corpusRequestDigest(
    'snapshot',
    'actor',
    'install',
    'corpus',
    { requestId: 'r1' },
  );
  assert.notEqual(
    one,
    await corpusRequestDigest('snapshot', 'other', 'install', 'corpus', {
      requestId: 'r1',
    }),
  );
  assertExactCorpusReplay({ b: 2, a: 1 }, { a: 1, b: 2 });
  assert.throws(
    () => assertExactCorpusReplay({ a: 1 }, { a: 2 }),
    /REQUEST_CONFLICT/,
  );
});

import {
  issueCorpusCursor,
  readCorpusCursor,
} from '../lib/pilot/corpus-cursor.ts';
import {
  inspectCorpusProof,
  verifyCorpusProof,
  corpusRepresentatives,
  CORPUS_MEMBER_CHECKS,
  CORPUS_FAMILY_SCENARIOS,
} from '../lib/pilot/corpus-proof.ts';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
const cursorBinding = () => ({
  kind: 'catalog',
  actorId: 'parent-1',
  sessionId: 'session-1',
  authRevision: '1',
  installationId: 'install-1',
  resourceId: 'child-1',
  corpusVersion: 'corpus-v1',
  corpusDigest: d,
  buildId: 'build-1',
  releaseRevision: 1,
  evidenceEpoch: 8,
  q: 'tree',
  limit: 20,
});
test('E009 cursor encrypted roundtrip, tamper/rotation/foreign/stale and expiry', async () => {
  const b = cursorBinding(),
    now = 1790000000000;
  const wire = await issueCorpusCursor(
    'private-test-secret',
    b,
    ['track', '1', 'lesson'],
    now,
  );
  assert.match(wire, /^c1\./);
  assert.equal(wire.includes('parent-1'), false);
  assert.deepEqual(
    (await readCorpusCursor('private-test-secret', wire, b, now)).last,
    ['track', '1', 'lesson'],
  );
  await assert.rejects(
    readCorpusCursor(
      'private-test-secret',
      wire.slice(0, -1) + (wire.endsWith('A') ? 'B' : 'A'),
      b,
      now,
    ),
    /CURSOR_INVALID/,
  );
  await assert.rejects(
    readCorpusCursor('rotated-test-secret', wire, b, now),
    /CURSOR_INVALID/,
  );
  await assert.rejects(
    readCorpusCursor(
      'private-test-secret',
      wire,
      { ...b, actorId: 'parent-2' },
      now,
    ),
    /CURSOR_FOREIGN/,
  );
  await assert.rejects(
    readCorpusCursor(
      'private-test-secret',
      wire,
      { ...b, evidenceEpoch: 9 },
      now,
    ),
    /CURSOR_STALE/,
  );
  await assert.rejects(
    readCorpusCursor('private-test-secret', wire, b, now + 600000),
    /CURSOR_STALE/,
  );
  await assert.rejects(
    readCorpusCursor(
      'private-test-secret',
      wire,
      { ...b, kind: 'owner-review' },
      now,
    ),
    /CURSOR_INVALID/,
  );
});
test('E009 cursor issue rejects invalid finite clock and out-of-contract page limits', async () => {
  await assert.rejects(
    issueCorpusCursor('test-secret', cursorBinding(), [], NaN),
    /CURSOR_INVALID/,
  );
  await assert.rejects(
    issueCorpusCursor(
      'test-secret',
      { ...cursorBinding(), limit: 51 },
      [],
      1790000000000,
    ),
    /CURSOR_INVALID/,
  );
});
const members = Array.from({ length: 5 }, (_, i) => ({
  lessonVersion: 'lesson-' + i,
  contentDigest: d,
}));
const receipt = () => ({
  schemaVersion: 'r6-proof-receipt-1',
  policyVersion: 'r6-corpus-proof-1',
  receiptId: 'proof-1',
  issuerId: 'issuer-1',
  issuedAt: '2026-09-27T00:00:00.000Z',
  candidateId: 'candidate-1',
  sourceDigest: d,
  artifactDigest: d,
  buildId: 'build-1',
  corpusVersion: 'corpus-v1',
  corpusDigest: d,
  ...members[0],
  canonicalizationVersion: 's3-json-1',
  adapterId: 'corpus-paired',
  adapterVersion: 'corpus-paired-v1',
  profileVersion: 'r6-paired-profile-1',
  evidenceInstallationId: 'evidence-1',
  targetInstallationId: 'target-1',
  namespace: 'unit-1',
  syntheticOnly: true,
  runnerManifestDigest: d,
  memberReportDigest: d,
  memberChecks: CORPUS_MEMBER_CHECKS.map((id) => ({
    id,
    outcome: 'PASS',
    evidenceDigest: d,
  })),
  familyEvidence: {
    reportDigest: d,
    representatives: corpusRepresentatives(members),
    scenarios: corpusRepresentatives(members).flatMap((m) =>
      CORPUS_FAMILY_SCENARIOS.map((id) => ({
        ...m,
        id,
        outcome: 'PASS',
        evidenceDigest: d,
      })),
    ),
  },
});
test('E004 proof exact member/family separation and recomputed representatives', () => {
  assert.equal(inspectCorpusProof(receipt(), members).memberChecks.length, 5);
  assert.equal(receipt().familyEvidence.scenarios.length, 39);
  for (const bad of [
    { ...receipt(), schemaVersion: 'r3-proof-receipt-1' },
    { ...receipt(), syntheticOnly: false },
    { ...receipt(), memberChecks: receipt().memberChecks.slice(1) },
    {
      ...receipt(),
      familyEvidence: {
        ...receipt().familyEvidence,
        representatives: [members[0], members[1], members[4]],
      },
    },
    {
      ...receipt(),
      familyEvidence: {
        ...receipt().familyEvidence,
        scenarios: [
          ...receipt().familyEvidence.scenarios.slice(1),
          receipt().familyEvidence.scenarios[1],
        ],
      },
    },
  ])
    assert.throws(() => inspectCorpusProof(bad, members));
});
test('E004 actual Ed25519 validates exact binding; candidate scope/current revoke vs historical window', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ]),
    publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey),
    r = receipt(),
    now = Date.parse(r.issuedAt);
  const signature = Buffer.from(
    await crypto.subtle.sign(
      'Ed25519',
      pair.privateKey,
      new TextEncoder().encode(canonicalPackage(r)),
    ),
  ).toString('base64url');
  const issuer = {
    issuerId: r.issuerId,
    publicKeyJwk,
    notBefore: now - 1,
    revokedAt: null,
    purpose: 'release',
  };
  const trust = {
    candidateId: r.candidateId,
    sourceDigest: d,
    artifactDigest: d,
    buildId: r.buildId,
    issuers: [issuer],
    archiveIssuers: [issuer],
  };
  const expected = {
    candidateId: r.candidateId,
    sourceDigest: r.sourceDigest,
    artifactDigest: r.artifactDigest,
    buildId: r.buildId,
    installationId: 'target-1',
    evidenceInstallationId: 'evidence-1',
    corpusVersion: r.corpusVersion,
    corpusDigest: d,
    namespace: r.namespace,
    verification: false,
    members,
    ...members[0],
  };
  assert.equal(
    (await verifyCorpusProof(r, signature, trust, expected, now)).receipt
      .receiptId,
    r.receiptId,
  );
  await assert.rejects(
    verifyCorpusProof(
      { ...r, memberReportDigest: 'sha256:' + 'b'.repeat(64) },
      signature,
      trust,
      expected,
      now,
    ),
    /PROOF_UNTRUSTED/,
  );
  await assert.rejects(
    verifyCorpusProof(
      r,
      signature,
      trust,
      { ...expected, corpusVersion: 'other' },
      now,
    ),
    /PROOF_IDENTITY_MISMATCH/,
  );
  const candidate = { ...issuer, purpose: 'candidate' };
  await assert.rejects(
    verifyCorpusProof(
      r,
      signature,
      { ...trust, issuers: [candidate] },
      expected,
      now,
    ),
    /PROOF_UNTRUSTED/,
  );
  await verifyCorpusProof(
    r,
    signature,
    { ...trust, issuers: [candidate] },
    { ...expected, verification: true },
    now,
  );
  const revoked = { ...issuer, revokedAt: now + 1 };
  await assert.rejects(
    verifyCorpusProof(
      r,
      signature,
      { ...trust, issuers: [revoked] },
      expected,
      now,
    ),
    /PROOF_UNTRUSTED/,
  );
  await verifyCorpusProof(
    r,
    signature,
    { ...trust, archiveIssuers: [revoked] },
    expected,
    now + 2,
    true,
  );
  await assert.rejects(
    verifyCorpusProof(
      r,
      signature,
      { ...trust, archiveIssuers: [{ ...revoked, revokedAt: now }] },
      expected,
      now + 2,
      true,
    ),
    /PROOF_UNTRUSTED/,
  );
});
test('E003 reviewed count is not prospective until bound sealed membership; stable ordinal picks representatives', () => {
  const one = pkg('later', [target('木'), target('林')], {
    ordinal: 2,
    prospective: false,
  });
  assert.equal(deriveCorpusCoverage([one]).counts.reviewedReady, 2);
  assert.equal(deriveCorpusCoverage([one]).counts.prospectiveStarter, 0);
  assert.equal(
    deriveCorpusCoverage([{ ...one, prospective: true }]).counts
      .prospectiveStarter,
    2,
  );
  assert.equal(
    deriveCorpusCoverage([
      {
        ...one,
        prospective: true,
        targets: [target('木'), target('林', { current: false })],
      },
    ]).counts.prospectiveStarter,
    0,
  );
  const earlier = pkg('earlier', [target('木'), target('日')], {
    ordinal: 1,
    prospective: true,
  });
  const a = deriveCorpusCoverage([one, earlier]),
    b = deriveCorpusCoverage([earlier, one]);
  assert.deepEqual(a, b);
  assert.equal(
    a.members.find((m) => m.coverageIdentity === '木' && m.eligible)
      .lessonVersion,
    'earlier',
  );
});
import {
  parseCorpusOwnerIds,
  parseCorpusFixtureBinding,
  validateCorpusCapability,
  inspectCorpusChunk,
  validateSnapshotSeal,
} from '../lib/pilot/corpus-policy.ts';
test('E005 restrictive fixture config grants no bootstrap without all server gates/current links', () => {
  assert.deepEqual(parseCorpusOwnerIds(undefined), []);
  assert.throws(
    () => parseCorpusOwnerIds('["same","same"]'),
    /OWNER_CONFIG_INVALID/,
  );
  assert.equal(
    parseCorpusFixtureBinding(
      {
        schemaVersion: 'r6-fixture-binding-1',
        installationId: 'install',
        mode: 'synthetic-only',
      },
      'install',
    ).mode,
    'synthetic-only',
  );
  assert.throws(() =>
    parseCorpusFixtureBinding(
      {
        schemaVersion: 'r6-fixture-binding-1',
        installationId: 'other',
        mode: 'synthetic-only',
      },
      'install',
    ),
  );
  const cap = parseCorpusCapability({
    installationId: 'install',
    corpusVersion: 'corpus',
    corpusDigest: d,
    namespace: 'test',
    parentIds: ['parent'],
    childIds: ['child'],
  });
  const context = {
    installationId: 'install',
    corpusVersion: 'corpus',
    corpusDigest: d,
    namespace: 'test',
    candidateId: 'candidate',
    testMode: true,
    testContent: true,
    tokenBound: true,
    freshOwnedInstallation: true,
    currentParentIds: ['parent'],
    currentChildIds: ['child'],
    currentLinkedPairs: [{ parentId: 'parent', childId: 'child' }],
  };
  validateCorpusCapability(cap, context);
  for (const gate of [
    'testMode',
    'testContent',
    'tokenBound',
    'freshOwnedInstallation',
  ])
    assert.throws(
      () => validateCorpusCapability(cap, { ...context, [gate]: false }),
      /CAPABILITY_DENIED/,
    );
  assert.throws(
    () => validateCorpusCapability(cap, { ...context, currentLinkedPairs: [] }),
    /CAPABILITY_DENIED/,
  );
});
test('E006 chunks at most50 exact planned package pairs; seal denies missing/extra/duplicate rows and stale epoch', () => {
  const planned = Array.from({ length: 51 }, (_, i) => ({
    lessonVersion: 'lesson-' + i,
    contentDigest: d,
  }));
  assert.equal(
    inspectCorpusChunk(
      { requestId: 'chunk-1', packages: planned.slice(0, 50) },
      planned,
    ).packages.length,
    50,
  );
  assert.throws(() =>
    inspectCorpusChunk({ requestId: 'chunk-1', packages: planned }, planned),
  );
  assert.throws(() =>
    inspectCorpusChunk(
      { requestId: 'chunk-1', packages: [planned[0], planned[0]] },
      planned,
    ),
  );
  const f = {
    expectedPlanDigest: d,
    actualPlanDigest: d,
    preparedEpoch: 2,
    currentEpoch: 2,
    expectedTargetKeys: ['a-0', 'a-1'],
    persistedTargetKeys: ['a-1', 'a-0'],
    expectedMemberDigest: d,
    actualMemberDigest: d,
    expectedReleasedPackageDigest: d,
    actualReleasedPackageDigest: d,
  };
  validateSnapshotSeal(f);
  assert.throws(
    () => validateSnapshotSeal({ ...f, currentEpoch: 3 }),
    /SNAPSHOT_STALE/,
  );
  assert.throws(
    () => validateSnapshotSeal({ ...f, persistedTargetKeys: ['a-0'] }),
    /SNAPSHOT_INCOMPLETE/,
  );
  assert.throws(
    () => validateSnapshotSeal({ ...f, persistedTargetKeys: ['a-0', 'a-0'] }),
    /SNAPSHOT_INCOMPLETE/,
  );
});
import { readFile } from 'node:fs/promises';
test('E001 actual frozen draft/stress manifests parse without granting source review or compilation', async () => {
  for (const [file, count] of [
    ['../content/corpora/hanzi-starter-draft-v1.json', 10],
    ['./fixtures/curriculum/corpus-stress/corpus.json', 800],
  ]) {
    const v = JSON.parse(
      await readFile(new URL(file, import.meta.url), 'utf8'),
    );
    assert.equal(inspectCorpusManifest(v).items.length, count);
  }
});
test('E008 unavailable member leaves another current package available in same group', () => {
  assert.equal(
    currentCorpusPackageAvailable({
      isCurrentHead: true,
      scopePermitted: true,
      packageCurrent: false,
    }),
    false,
  );
  assert.equal(
    currentCorpusPackageAvailable({
      isCurrentHead: true,
      scopePermitted: true,
      packageCurrent: true,
    }),
    true,
  );
  const r = deriveCorpusCoverage([
    pkg('stale', [target('木'), target('林', { current: false })], {
      committed: true,
      prospective: true,
    }),
    pkg('current', [target('日'), target('月')], {
      committed: true,
      prospective: true,
    }),
  ]);
  assert.equal(r.counts.committedStarter, 2);
  assert.deepEqual(
    r.releasedPackages.map((p) => p.lessonVersion),
    ['current'],
  );
});
