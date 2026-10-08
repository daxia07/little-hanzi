/** Server-only profile validation. No frozen Forest adapter dependency. */
import { canonicalPackage } from './digest.ts';
import { inspectJson } from './json.ts';
import type { PairedPackage } from './paired-types.ts';
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  obj(v) && Object.keys(v).sort().join(',') === keys.slice().sort().join(',');
const text = (v: unknown, max = 240): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v === v.trim() &&
  Array.from(v).length <= max;
const id = (v: unknown): v is string =>
  text(v, 80) && /^[a-z0-9][a-z0-9._-]*$/.test(v);
const same = (a: unknown, b: unknown) =>
  canonicalPackage(a) === canonicalPackage(b);
function ensure(condition: unknown): asserts condition {
  if (!condition) throw new Error('PAIRED_PROFILE_INVALID');
}
export function validatePairedEngineSection(
  input: unknown,
  adapterId: 'paired-story' | 'corpus-paired',
): boolean {
  try {
    const inspected = inspectJson(input);
    ensure(!inspected.errors.length && obj(inspected.value));
    const v = inspected.value as unknown as PairedPackage,
      p = v.pairedStory;
    ensure(
      (adapterId === 'paired-story' || adapterId === 'corpus-paired') &&
        v.renderer.adapterId === adapterId &&
        v.renderer.adapterVersion ===
          (adapterId === 'paired-story'
            ? 'paired-story-v1'
            : 'corpus-paired-v1'),
    );
    ensure(
      exact(p, ['schemaVersion', 'welcome', 'targets', 'reader', 'playback']) &&
        p.schemaVersion === 'r5-paired-story-1',
    );
    ensure(
      exact(p.welcome, ['title', 'instructionEnglish']) &&
        text(p.welcome.title, 120) &&
        text(p.welcome.instructionEnglish),
    );
    ensure(
      v.characters.length === 2 &&
        Array.isArray(p.targets) &&
        p.targets.length === 2,
    );
    const usedChecks: string[] = [],
      words: string[] = [],
      readings: string[] = [];
    p.targets.forEach((t, i) => {
      ensure(
        exact(t, [
          'characterId',
          'readingId',
          'familiarityCheckId',
          'practice',
          'immediateCheckId',
          'reviewCheckId',
        ]),
      );
      const c = v.characters[i];
      ensure(t.characterId === c.characterId && id(t.readingId));
      ensure(
        c.readings.some((r) => r.readingId === t.readingId) &&
          c.wordAssociations.length === 2,
      );
      readings.push(t.readingId);
      ensure(Array.isArray(t.practice) && t.practice.length === 2);
      const refs = [
        t.familiarityCheckId,
        ...t.practice.map((w) => w.checkId),
        t.immediateCheckId,
        t.reviewCheckId,
      ];
      let order: string[] | null = null;
      refs.forEach((ref, j) => {
        ensure(id(ref));
        const check = v.recognitionChecks.find((q) => q.checkId === ref);
        ensure(
          check &&
            check.characterId === t.characterId &&
            check.kind ===
              (j === 1 || j === 2 ? 'word-context' : 'plain-print') &&
            check.choices.length === 4,
        );
        const glyphs = check.choices.map((q) => q.hanzi);
        ensure(new Set(glyphs).size === 4);
        ensure(order === null || same(order, glyphs));
        order = glyphs;
        usedChecks.push(ref);
        if (j === 1 || j === 2) {
          const w = c.wordAssociations[j - 1];
          ensure(
            exact(t.practice[j - 1], ['wordId', 'checkId']) &&
              t.practice[j - 1].wordId === w.wordId &&
              w.readingId === t.readingId &&
              check.prompt.hanzi === w.text,
          );
          words.push(w.wordId);
        } else
          ensure(
            check.prompt.hanzi ===
              c.readings.find((r) => r.readingId === t.readingId)?.audioText,
          );
      });
      ensure(
        c.teaching.recognitionCheckId === t.immediateCheckId &&
          c.teaching.delayedReview.recognitionCheckId === t.reviewCheckId,
      );
    });
    ensure(
      usedChecks.length === 10 &&
        new Set(usedChecks).size === 10 &&
        v.recognitionChecks.length === 10,
    );
    ensure(
      exact(p.reader, ['title', 'instructionEnglish', 'wordIds']) &&
        text(p.reader.title, 120) &&
        text(p.reader.instructionEnglish) &&
        same(p.reader.wordIds, words),
    );
    ensure(v.steps.length === 5);
    const kinds = [
      'familiarity',
      'teach',
      'practice',
      'plain-print-check',
      'recap',
    ];
    const stepChecks = [
      p.targets.map((t) => t.familiarityCheckId),
      [],
      p.targets.flatMap((t) => t.practice.map((w) => w.checkId)),
      p.targets.map((t) => t.immediateCheckId),
      [],
    ];
    v.steps.forEach((s, i) =>
      ensure(s.kind === kinds[i] && same(s.recognitionCheckIds, stepChecks[i])),
    );
    const b = p.playback;
    ensure(
      exact(b, ['schemaVersion', 'kind', 'voices', 'fallback', 'cues']) &&
        b.schemaVersion === 'r5-playback-1' &&
        b.fallback === 'unavailable',
    );
    ensure(
      ['local-device', 'recorded'].includes(b.kind) &&
        Array.isArray(b.voices) &&
        b.voices.length <= 8 &&
        Array.isArray(b.cues) &&
        b.cues.length === 16,
    );
    const voiceNames = new Set<string>();
    b.voices.forEach((q) => {
      ensure(
        exact(q, ['name', 'lang', 'localService']) &&
          text(q.name, 120) &&
          text(q.lang, 32) &&
          /^zh(?:-[A-Za-z0-9]+)*$/.test(q.lang) &&
          q.localService === true &&
          !voiceNames.has(q.name),
      );
      voiceNames.add(q.name);
    });
    if (b.kind === 'recorded') ensure(b.voices.length === 0);
    const required = new Set([
        ...readings.map((r) => 'readingId:' + r),
        ...words.map((w) => 'wordId:' + w),
        ...usedChecks.map((c) => 'checkId:' + c),
      ]),
      cueIds = new Set<string>();
    b.cues.forEach((q) => {
      ensure(
        exact(q, [
          'cueId',
          'readingId',
          'wordId',
          'checkId',
          'transcript',
          'assetId',
          'assetUrl',
          'assetDigest',
        ]) &&
          id(q.cueId) &&
          !cueIds.has(q.cueId) &&
          text(q.transcript, 120),
      );
      cueIds.add(q.cueId);
      const keys = (['readingId', 'wordId', 'checkId'] as const).filter(
        (k) => q[k] !== null,
      );
      ensure(keys.length === 1);
      const key = keys[0];
      ensure(id(q[key]));
      const ref = key + ':' + q[key];
      ensure(required.delete(ref));
      const expected =
        key === 'readingId'
          ? v.characters
              .flatMap((c) => c.readings)
              .find((r) => r.readingId === q[key])?.audioText
          : key === 'wordId'
            ? v.characters
                .flatMap((c) => c.wordAssociations)
                .find((w) => w.wordId === q[key])?.context.hanzi
            : v.recognitionChecks.find((c) => c.checkId === q[key])?.prompt
                .hanzi;
      ensure(
        q.transcript === expected &&
          v.assets.some((a) => a.assetId === q.assetId && a.kind === 'audio'),
      );
      if (b.kind === 'local-device')
        ensure(q.assetUrl === null && q.assetDigest === null);
      else
        ensure(
          typeof q.assetUrl === 'string' &&
            /^\/story\/[A-Za-z0-9_./-]+$/.test(q.assetUrl) &&
            !q.assetUrl.split('/').some((s) => s === '.' || s === '..') &&
            typeof q.assetDigest === 'string' &&
            /^sha256:[a-f0-9]{64}$/.test(q.assetDigest),
        );
    });
    ensure(required.size === 0);
    return true;
  } catch {
    return false;
  }
}

export function validatePairedSection(input: unknown): boolean {
  return validatePairedEngineSection(input, 'paired-story');
}
