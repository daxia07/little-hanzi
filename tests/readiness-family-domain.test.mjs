import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validateCurriculumPackage } from '../lib/curriculum/validate.ts';
import { FOREST_STORY_LESSON } from '../lib/preview/content.ts';
const base = JSON.parse(
  fs.readFileSync(
    new URL('../content/curriculum/forest-01-v2.json', import.meta.url),
    'utf8',
  ),
);
export function examplePackage() {
  return {
    ...structuredClone(base),
    lessonVersion: 'forest-01-v4',
    title: 'A shady place to read',
    renderer: {
      ...base.renderer,
      adapterId: 'forest-story',
      adapterVersion: 'forest-story-v1',
    },
    story: {
      schemaVersion: 'r3-story-package-1',
      lineageDigest:
        'sha256:bfd06daa7d205bc077b2e8136c7dc47ebb6d645921de8adee34f92da30a7b1fb',
      steps: FOREST_STORY_LESSON.steps,
      questions: FOREST_STORY_LESSON.questions,
      learningPanels: {
        introduction: ['learn-mu', 'learn-lin'],
        reminder: ['reminder'],
        mixed: 'per-target',
      },
      build: {
        pieces: ['mu-a', 'mu-b'],
        slots: ['left', 'right'],
        glyph: '林',
      },
      find: { ids: ['find-mu', 'find-lin'], soundRequired: false },
      reader: FOREST_STORY_LESSON.captions,
      rules: {
        firstResponse: true,
        helpAssists: true,
        secondWrongDemonstrates: true,
        lateFailure: 'append-unavailable-current-question',
      },
      delayed: {
        questionIds: ['review-mu-sound', 'review-lin-sound'],
        delayMs: 86400000,
      },
      playback: {
        schemaVersion: 'r3-playback-1',
        kind: 'local-device',
        voices: [{ name: 'Tingting', lang: 'zh-CN', localService: true }],
        fallback: 'unavailable',
        cues: [
          ...new Set(
            ['你好'].concat(
              FOREST_STORY_LESSON.questions
                .flatMap((q) => [
                  q.prompt,
                  q.cueText,
                  ...q.choices.map((c) => c.audioText).filter(Boolean),
                ])
                .concat(
                  FOREST_STORY_LESSON.examples.map((e) => e.audioText),
                  FOREST_STORY_LESSON.captions.map((c) => c.text),
                  base.characters.flatMap((c) =>
                    c.readings
                      .map((r) => r.audioText)
                      .concat(
                        c.wordAssociations.flatMap((w) => [
                          w.text,
                          w.context.hanzi,
                        ]),
                      ),
                  ),
                ),
            ),
          ),
        ].map((transcript, i) => ({
          id: `cue-${i}`,
          transcript,
          source:
            'Declared local device speech; human Mandarin/device review pending',
          license: 'Platform-provided voice; no recording redistributed',
          assetUrl: null,
          assetDigest: null,
        })),
      },
    },
  };
}
test('R3-E001 accepts V4 exact story package without weakening old package validation', () => {
  assert.equal(validateCurriculumPackage(base).ok, true);
  assert.equal(validateCurriculumPackage(examplePackage()).ok, true);
});
test('R3-E001 inherited oracle and unknown story fields fail closed', () => {
  const p = examplePackage();
  p.story.questions = structuredClone(p.story.questions);
  p.story.questions[0].correctChoiceId = 'lin';
  assert.equal(validateCurriculumPackage(p).ok, false);
  const q = examplePackage();
  q.story.callerReviewed = true;
  assert.equal(validateCurriculumPackage(q).ok, false);
});
test('R3-E001 story dispatch inspects caller data without invoking getters', () => {
  for (const location of ['root', 'renderer', 'story', 'accessor']) {
    const p = examplePackage();
    let calls = 0;
    const trap = {
      get() {
        calls += 1;
        throw new Error('caller getter invoked');
      },
    };
    let input = p;
    if (location === 'root') input = new Proxy(p, trap);
    else if (location === 'accessor')
      Object.defineProperty(p, 'renderer', {
        enumerable: true,
        get() {
          calls += 1;
          throw new Error('caller accessor invoked');
        },
      });
    else p[location] = new Proxy(p[location], trap);
    let result;
    assert.doesNotThrow(() => {
      result = validateCurriculumPackage(input);
    });
    assert.equal(calls, 0);
    if (location === 'accessor') {
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((e) => e.code === 'UNSAFE_JSON_VALUE'));
    } else assert.equal(result.ok, true);
  }
});
const runtime = await import('../lib/curriculum/story-runtime.ts');
const { compileStoryPackage } =
  await import('../lib/curriculum/story-package.ts');
const lesson = await compileStoryPackage(examplePackage());
const clock = '2026-09-27T00:00:00.000Z';
function step(
  run,
  events,
  type,
  payload = {},
  policy = { soundReview: 'reviewed' },
) {
  const action = {
    eventId: `e-${events.length}`,
    expectedRevision: run.revision,
    stepId: run.state.stepId,
    type,
    payload,
  };
  const result = runtime.applyAction(run, events, action, clock, policy);
  return { result, action };
}
test('R3-E002 ordinary reviewed sound can be graded without fake synthetic identity; pending cannot', () => {
  let run = runtime.createInitialRun(lesson, {
    runId: 'ordinary-1',
    seed: 0,
    now: clock,
  });
  const open = step(run, [], 'continue').result;
  assert.equal(open.ok, true);
  run = open.run;
  assert.equal(Object.hasOwn(run, 'synthetic'), false);
  assert.equal(Object.hasOwn(run.state, 'soundReview'), false);
  assert.equal(
    step(
      run,
      [open.event],
      'answer',
      { questionId: 'fam-mu', choiceId: 'mu' },
      { soundReview: 'pending' },
    ).result.ok,
    false,
  );
  assert.equal(
    step(run, [open.event], 'answer', { questionId: 'fam-mu', choiceId: 'mu' })
      .result.ok,
    true,
  );
});
const policy = await import('../lib/pilot/story-policy.ts');
function receipt() {
  return {
    schemaVersion: 'r3-proof-receipt-1',
    receiptId: 'proof-1',
    issuerId: 'issuer-1',
    issuedAt: 0,
    candidateId: 'candidate',
    sourceDigest: lesson.identity.contentDigest,
    artifactDigest: lesson.identity.contentDigest,
    buildId: 'build',
    lessonVersion: 'forest-01-v4',
    contentDigest: lesson.identity.contentDigest,
    canonicalizationVersion: 's3-json-1',
    adapterId: 'forest-story',
    adapterVersion: 'forest-story-v1',
    evidenceInstallationId: 'evidence',
    targetInstallationId: 'target',
    namespace: 'qa',
    syntheticOnly: true,
    scenarios: policy.REQUIRED_SCENARIOS.map((id) => ({
      id,
      outcome: 'PASS',
      evidenceDigest: lesson.identity.contentDigest,
    })),
    reportDigest: lesson.identity.contentDigest,
  };
}
test('R3-E003 receipt is exact complete synthetic execution, never production-data attestation', () => {
  const r = receipt();
  assert.equal(policy.validReceipt(r), true);
  assert.equal(policy.validReceipt({ ...r, syntheticOnly: false }), false);
  assert.equal(
    policy.validReceipt({ ...r, scenarios: r.scenarios.slice(1) }),
    false,
  );
  assert.equal(
    policy.validReceipt({
      ...r,
      scenarios: r.scenarios.map((s, i) => (i ? s : r.scenarios[1])),
    }),
    false,
  );
});
test('R3-E003 real Ed25519 canonical proof separates current trust from historical authenticity', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ]),
    jwk = await crypto.subtle.exportKey('jwk', keys.publicKey),
    r = receipt(),
    issuer = {
      issuerId: r.issuerId,
      publicKeyJwk: jwk,
      notBefore: 0,
      revokedAt: null,
      purpose: 'release',
    },
    trust = {
      candidateId: r.candidateId,
      sourceDigest: r.sourceDigest,
      artifactDigest: r.artifactDigest,
      buildId: r.buildId,
      issuers: [issuer],
      archiveIssuers: [issuer],
    },
    signed = new Uint8Array(
      await crypto.subtle.sign(
        'Ed25519',
        keys.privateKey,
        new TextEncoder().encode(
          (await import('../lib/curriculum/digest.ts')).canonicalPackage(r),
        ),
      ),
    ),
    signature = Buffer.from(signed).toString('base64url'),
    expected = { installationId: 'target', contentDigest: r.contentDigest };
  assert.equal(
    (
      await policy.verifyProofReceipt(
        r,
        signature,
        trust,
        expected,
        Date.parse(clock),
      )
    ).receipt.receiptId,
    r.receiptId,
  );
  await assert.rejects(() =>
    policy.verifyProofReceipt(
      { ...r, buildId: 'changed' },
      signature,
      trust,
      expected,
      Date.parse(clock),
    ),
  );
  await assert.rejects(() =>
    policy.verifyProofReceipt(
      r,
      signature,
      { ...trust, issuers: [{ ...issuer, revokedAt: 1 }] },
      expected,
      Date.parse(clock),
    ),
  );
  assert.equal(
    (
      await policy.verifyProofReceipt(
        r,
        signature,
        { ...trust, archiveIssuers: [{ ...issuer, revokedAt: 1 }] },
        expected,
        Date.parse(clock),
        true,
      )
    ).receipt.receiptId,
    r.receiptId,
  );
  await assert.rejects(() =>
    policy.verifyProofReceipt(
      r,
      signature,
      { ...trust, archiveIssuers: [] },
      expected,
      Date.parse(clock),
      true,
    ),
  );
});
test('R3-E001 story compiler rejects a valid generic V2 or unsupported adapter', async () => {
  await assert.rejects(() => compileStoryPackage(base));
  const p = examplePackage();
  p.renderer.adapterVersion = 'unknown-story';
  await assert.rejects(() => compileStoryPackage(p));
});
