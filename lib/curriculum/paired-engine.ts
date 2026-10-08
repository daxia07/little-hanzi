/** Server-only paired compiler/reducer. No Forest oracle, IO, clock or persistence. */
import { canonicalPackage, curriculumDigest } from './digest.ts';
import { inspectJson } from './json.ts';
import { validateCurriculumPackage } from './validate.ts';
import type {
  CollectionQuestion,
  CollectionTeachingPanel,
  CollectionReaderPanel,
  CollectionRecap,
  CollectionEvent,
} from './collection-types.ts';
import type {
  PairedAction,
  PairedAck,
  PairedEvent,
  PairedIdentity,
  PairedPackage,
  PairedRun as StoredPairedRun,
  PairedState,
  PairedPhase,
  PairedSound,
  PairedResult,
  PairedGroup,
  PairedCheck,
} from './paired-types.ts';
export type PairedErrorCode =
  | 'INVALID_PACKAGE'
  | 'INVALID_REQUEST'
  | 'INVALID_TRANSITION'
  | 'STALE_REVISION'
  | 'EVENT_CONFLICT'
  | 'RUNTIME_IDENTITY_MISMATCH'
  | 'RUNTIME_STATE_INVALID';
export class PairedRuntimeError extends Error {
  readonly code: PairedErrorCode;
  constructor(code: PairedErrorCode) {
    super(code);
    this.name = 'PairedRuntimeError';
    this.code = code;
  }
}
function fail(code: PairedErrorCode): never {
  throw new PairedRuntimeError(code);
}
function check(
  v: unknown,
  code: PairedErrorCode = 'INVALID_REQUEST',
): asserts v {
  if (!v) fail(code);
}
function safeCopy<T>(v: T): T {
  const r = inspectJson(v);
  check(!r.errors.length);
  return r.value as T;
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === keys.slice().sort().join(',');
const validId = (s: unknown): s is string =>
  typeof s === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(s);
const iso = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v;
function clockIso(value: string | number): string {
  if (typeof value === 'string') {
    check(iso(value));
    return value;
  }
  check(
    Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000,
  );
  return new Date(value).toISOString();
}
export type EngineKind = 'paired' | 'corpus';
export interface CorpusIdentity {
  lessonId: string;
  lessonVersion: string;
  contentDigest: string;
  adapterId: 'corpus-paired';
  adapterVersion: 'corpus-paired-v1';
}
type EngineIdentity<K extends EngineKind> = K extends 'paired'
  ? PairedIdentity
  : CorpusIdentity;
export type StoryRun<K extends EngineKind> = Omit<
  StoredPairedRun,
  'identity' | 'schemaVersion'
> & {
  identity: EngineIdentity<K>;
  schemaVersion: K extends 'paired' ? 'r5-paired-run-1' : 'r6-corpus-run-1';
};
export interface CompiledStoryLesson<K extends EngineKind> {
  readonly identity: EngineIdentity<K>;
  readonly title: string;
  readonly targetIds: readonly string[];
}
/** Private shared mechanics: each fixed wrapper receives its own compiled-object partition. */
export function createPairedEngine<K extends EngineKind>(kind: K) {
  check(kind === 'paired' || kind === 'corpus', 'INVALID_PACKAGE');
  type CompiledPairedLesson = CompiledStoryLesson<K>;
  type PairedRun = StoryRun<K>;
  const adapterId = kind === 'paired' ? 'paired-story' : 'corpus-paired';
  const adapterVersion =
    kind === 'paired' ? 'paired-story-v1' : 'corpus-paired-v1';
  const runSchema = (
    kind === 'paired' ? 'r5-paired-run-1' : 'r6-corpus-run-1'
  ) as PairedRun['schemaVersion'];
  const viewSchema = (
    kind === 'paired' ? 'r5-story-view-1' : 'r6-story-view-1'
  ) as K extends 'paired' ? 'r5-story-view-1' : 'r6-story-view-1';
  const internals = new WeakMap<CompiledPairedLesson, PairedPackage>();
  function pkg(l: CompiledPairedLesson): PairedPackage {
    const p = internals.get(l);
    check(p, 'INVALID_PACKAGE');
    return p;
  }
  async function compilePairedRuntime(
    input: unknown,
  ): Promise<CompiledPairedLesson> {
    const v = safeCopy(input);
    check(validateCurriculumPackage(v).ok, 'INVALID_PACKAGE');
    const p = v as PairedPackage;
    check(
      p.renderer.adapterId === adapterId &&
        p.renderer.adapterVersion === adapterVersion,
      'INVALID_PACKAGE',
    );
    const lesson = freeze({
      identity: {
        lessonId: p.lessonId,
        lessonVersion: p.lessonVersion,
        contentDigest: await curriculumDigest(v),
        adapterId,
        adapterVersion,
      } as EngineIdentity<K>,
      title: p.title,
      targetIds: p.characters.map((c) => c.characterId),
    });
    internals.set(lesson, freeze(p));
    return lesson;
  }
  function createPairedRun(
    l: CompiledPairedLesson,
    input: {
      runId: string;
      seed: number;
      phase: PairedPhase;
      now: string | number;
    },
  ): PairedRun {
    pkg(l);
    input = safeCopy(input);
    const timestamp = clockIso(input.now);
    check(
      exact(input, ['runId', 'seed', 'phase', 'now']) &&
        validId(input.runId) &&
        Number.isInteger(input.seed) &&
        input.seed >= 0 &&
        input.seed <= 0xffffffff &&
        ['initial', 'review-24h', 'review-7d'].includes(input.phase) &&
        iso(timestamp),
    );
    return {
      schemaVersion: runSchema,
      runId: input.runId,
      identity: safeCopy(l.identity),
      seed: input.seed,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      state: {
        phase: input.phase,
        stepId: input.phase === 'initial' ? 'welcome' : 'check',
        panelIndex: 0,
        questionIndex: 0,
        questionStatus: input.phase === 'initial' ? null : 'open',
        attempts: 0,
        hintLevel: 0,
        assisted: false,
        targetRoutes: null,
        completedAt: null,
      },
      events: [],
    };
  }
  function checkIds(p: PairedPackage, s: PairedState): string[] {
    if (s.stepId === 'familiarity')
      return p.pairedStory.targets.map((t) => t.familiarityCheckId);
    if (s.stepId === 'practice')
      return p.pairedStory.targets.flatMap((t) =>
        t.practice.map((w) => w.checkId),
      );
    if (s.stepId === 'check')
      return p.pairedStory.targets.map((t) =>
        s.phase === 'initial' ? t.immediateCheckId : t.reviewCheckId,
      );
    return [];
  }
  function current(
    p: PairedPackage,
    r: PairedRun,
  ): { q: PairedCheck; occurrenceId: string; targetIndex: number } | null {
    const ref = checkIds(p, r.state)[r.state.questionIndex];
    if (!ref) return null;
    const q = p.recognitionChecks.find((q) => q.checkId === ref);
    check(q, 'RUNTIME_STATE_INVALID');
    return {
      q,
      occurrenceId: `${r.state.phase}:${r.state.stepId}:${q.checkId}`,
      targetIndex: p.characters.findIndex(
        (c) => c.characterId === q.characterId,
      ),
    };
  }
  function choices(p: PairedPackage, r: PairedRun) {
    const c = current(p, r);
    if (!c) return [];
    const phaseOffset =
      r.state.phase === 'initial' ? 0 : r.state.phase === 'review-24h' ? 1 : 2;
    const offset = (r.seed + c.targetIndex + phaseOffset) % 4;
    return c.q.choices.slice(offset).concat(c.q.choices.slice(0, offset));
  }
  function resetQuestion(s: PairedState) {
    s.questionStatus = 'open';
    s.attempts = 0;
    s.hintLevel = 0;
    s.assisted = false;
  }
  function terminal(s: PairedState) {
    return (
      s.questionStatus === 'answered' ||
      s.questionStatus === 'demonstrated' ||
      s.questionStatus === 'unavailable'
    );
  }
  function advance(p: PairedPackage, r: PairedRun, now: string) {
    const s = r.state,
      ids = checkIds(p, s);
    if (ids.length) {
      check(terminal(s), 'INVALID_TRANSITION');
      if (s.questionIndex + 1 < ids.length) {
        s.questionIndex++;
        resetQuestion(s);
        return;
      }
    }
    if (s.stepId === 'teach' && s.panelIndex === 0) {
      s.panelIndex++;
      return;
    }
    if (s.stepId === 'reader' && s.panelIndex < 3) {
      s.panelIndex++;
      return;
    }
    if (s.stepId === 'recap') fail('INVALID_TRANSITION');
    const order =
      s.phase === 'initial'
        ? [
            'welcome',
            'familiarity',
            'teach',
            'practice',
            'reader',
            'check',
            'recap',
          ]
        : ['check', 'recap'];
    s.stepId = order[order.indexOf(s.stepId) + 1] as PairedState['stepId'];
    s.panelIndex = 0;
    s.questionIndex = 0;
    s.questionStatus = null;
    s.attempts = 0;
    s.hintLevel = 0;
    s.assisted = false;
    if (s.stepId === 'teach')
      s.targetRoutes = p.characters.map((c, i) => {
        const occurrenceId = `initial:familiarity:${p.pairedStory.targets[i].familiarityCheckId}`;
        const events = r.events.filter((e) => e.occurrenceId === occurrenceId),
          first = events.find((e) => e.result.firstResponse);
        const reminder =
          first?.result.outcome === 'correct' &&
          !first.result.assisted &&
          !events.some(
            (e) =>
              e.action.type === 'help' || e.action.type === 'audio-unavailable',
          );
        return {
          characterId: c.characterId,
          mode: reminder ? 'reminder' : 'full',
        };
      });
    if (checkIds(p, s).length) resetQuestion(s);
    if (s.stepId === 'recap') s.completedAt = now;
  }
  function validateAction(input: unknown): PairedAction {
    const a = safeCopy(input) as PairedAction;
    check(
      exact(a, [
        'eventId',
        'expectedRevision',
        'occurrenceId',
        'type',
        'payload',
      ]) &&
        validId(a.eventId) &&
        Number.isSafeInteger(a.expectedRevision) &&
        a.expectedRevision >= 0 &&
        (a.occurrenceId === null ||
          (typeof a.occurrenceId === 'string' &&
            a.occurrenceId.length <= 180)) &&
        ['continue', 'answer', 'help', 'audio-unavailable'].includes(a.type),
    );
    check(
      a.type === 'answer'
        ? exact(a.payload, ['choiceId']) &&
            typeof a.payload.choiceId === 'string'
        : exact(a.payload, []),
    );
    return a;
  }
  function reduce(
    l: CompiledPairedLesson,
    run: PairedRun,
    a: PairedAction,
    policy: { now: string | number; soundReview: PairedSound },
  ) {
    const p = pkg(l);
    const timestamp = clockIso(policy.now);
    check(
      iso(timestamp) &&
        ['pending', 'reviewed', 'synthetic'].includes(policy.soundReview),
    );
    check(Date.parse(timestamp) >= Date.parse(run.updatedAt));
    check(a.expectedRevision === run.revision, 'STALE_REVISION');
    const r = safeCopy(run),
      s = r.state,
      c = current(p, r);
    check(a.occurrenceId === (c?.occurrenceId ?? null), 'INVALID_TRANSITION');
    check(s.stepId !== 'recap', 'INVALID_TRANSITION');
    let result: PairedResult = {
      outcome: 'continued',
      firstResponse: false,
      assisted: s.assisted,
    };
    if (a.type === 'continue') {
      advance(p, r, timestamp);
      result.outcome = s.completedAt ? 'completed' : 'continued';
    } else {
      check(c, 'INVALID_TRANSITION');
      if (a.type === 'audio-unavailable') {
        check(s.questionStatus !== 'unavailable', 'INVALID_TRANSITION');
        s.questionStatus = 'unavailable';
        s.assisted = true;
        result = {
          outcome: 'unavailable',
          firstResponse: false,
          assisted: true,
        };
      } else {
        check(s.questionStatus === 'open', 'INVALID_TRANSITION');
        if (a.type === 'help') {
          s.assisted = true;
          s.hintLevel = r.events.some(
            (e) =>
              e.occurrenceId === c.occurrenceId && e.action.type === 'help',
          )
            ? 2
            : 1;
          if (s.hintLevel === 2) s.questionStatus = 'demonstrated';
          result = {
            outcome: s.hintLevel === 2 ? 'demonstrated' : 'hint',
            firstResponse: false,
            assisted: true,
          };
        } else {
          check(policy.soundReview !== 'pending', 'INVALID_TRANSITION');
          check(c.q.choices.some((q) => q.choiceId === a.payload.choiceId));
          const first = s.attempts === 0,
            correct = a.payload.choiceId === c.q.correctChoiceId;
          const assisted = s.assisted || !first;
          s.attempts++;
          if (correct) {
            s.questionStatus = 'answered';
            s.assisted = assisted;
          } else {
            s.assisted = true;
            s.hintLevel = 1;
            if (s.attempts >= 2) s.questionStatus = 'demonstrated';
          }
          result = {
            outcome: correct
              ? 'correct'
              : s.attempts >= 2
                ? 'demonstrated'
                : 'incorrect',
            firstResponse: first,
            assisted: correct ? assisted : assisted,
          };
        }
      }
    }
    const event: PairedEvent = {
      eventId: a.eventId,
      sequence: run.revision + 1,
      phase: run.state.phase,
      stepId: run.state.stepId,
      occurrenceId: c?.occurrenceId ?? null,
      checkId: c?.q.checkId ?? null,
      characterId: c?.q.characterId ?? null,
      serverTime: timestamp,
      soundReview: policy.soundReview,
      action: a,
      result,
    };
    r.revision++;
    r.updatedAt = timestamp;
    r.events.push(event);
    return {
      run: r,
      event,
      ack: { eventId: a.eventId, revision: r.revision, result } as PairedAck,
      replayed: false,
    };
  }
  function validatePairedRun(
    l: CompiledPairedLesson,
    input: unknown,
  ): PairedRun {
    const r = safeCopy(input) as PairedRun;
    check(
      exact(r, [
        'schemaVersion',
        'runId',
        'identity',
        'seed',
        'revision',
        'createdAt',
        'updatedAt',
        'state',
        'events',
      ]) && r.schemaVersion === runSchema,
      'RUNTIME_STATE_INVALID',
    );
    check(
      canonicalPackage(r.identity) === canonicalPackage(l.identity),
      'RUNTIME_IDENTITY_MISMATCH',
    );
    check(
      Array.isArray(r.events) &&
        r.events.length <= 160 &&
        r.revision === r.events.length &&
        r.state &&
        ['initial', 'review-24h', 'review-7d'].includes(r.state.phase),
      'RUNTIME_STATE_INVALID',
    );
    let replay = createPairedRun(l, {
      runId: r.runId,
      seed: r.seed,
      phase: r.state.phase,
      now: r.createdAt,
    });
    const ids = new Set<string>();
    for (const e of r.events) {
      check(
        e && validId(e.eventId) && !ids.has(e.eventId),
        'RUNTIME_STATE_INVALID',
      );
      ids.add(e.eventId);
      const next = reduce(l, replay, validateAction(e.action), {
        now: e.serverTime,
        soundReview: e.soundReview,
      });
      check(
        canonicalPackage(next.event) === canonicalPackage(e),
        'RUNTIME_STATE_INVALID',
      );
      replay = next.run;
    }
    check(
      canonicalPackage(replay) === canonicalPackage(r),
      'RUNTIME_STATE_INVALID',
    );
    return r;
  }
  function applyPairedAction(
    l: CompiledPairedLesson,
    input: unknown,
    action: unknown,
    policy: { now: string | number; soundReview: PairedSound },
  ) {
    const r = validatePairedRun(l, input),
      a = validateAction(action);
    const old = r.events.find((e) => e.eventId === a.eventId);
    if (old) {
      check(
        canonicalPackage(old.action) === canonicalPackage(a),
        'EVENT_CONFLICT',
      );
      return {
        run: r,
        event: old,
        ack: {
          eventId: old.eventId,
          revision: old.sequence,
          result: old.result,
        },
        replayed: true,
      };
    }
    return reduce(l, r, a, policy);
  }
  function group(
    p: PairedPackage,
    r: PairedRun,
    step: PairedState['stepId'],
  ): PairedGroup {
    const refs = checkIds(p, { ...r.state, stepId: step });
    let independent = 0,
      supported = 0,
      unavailable = 0,
      pending = 0,
      helpCount = 0;
    const firstResponses: PairedGroup['firstResponses'] = [];
    refs.forEach((ref) => {
      const occurrenceId = `${r.state.phase}:${step}:${ref}`,
        events = r.events.filter((e) => e.occurrenceId === occurrenceId);
      const first = events.find((e) => e.result.firstResponse);
      if (first && first.characterId)
        firstResponses.push({
          occurrenceId,
          characterId: first.characterId,
          correct: first.result.outcome === 'correct',
          assisted: first.result.assisted,
        });
      helpCount += events.filter((e) => e.action.type === 'help').length;
      if (events.some((e) => e.result.outcome === 'unavailable')) unavailable++;
      else if (first?.result.outcome === 'correct' && !first.result.assisted)
        independent++;
      else if (
        events.some(
          (e) =>
            e.result.outcome === 'correct' ||
            e.result.outcome === 'demonstrated',
        )
      )
        supported++;
      else pending++;
    });
    return {
      total: refs.length,
      independent,
      supported,
      unavailable,
      pending,
      firstResponses,
      helpCount,
    };
  }
  function projectPairedRun(
    l: CompiledPairedLesson,
    input: unknown,
    policy: { soundReview: PairedSound },
  ) {
    const r = validatePairedRun(l, input),
      p = pkg(l),
      s = r.state,
      c = current(p, r);
    check(['pending', 'reviewed', 'synthetic'].includes(policy.soundReview));
    let question: CollectionQuestion | null = null,
      teachingPanel: CollectionTeachingPanel | null = null,
      readerPanel: CollectionReaderPanel | null = null;
    if (c) {
      const char = p.characters[c.targetIndex];
      question = {
        occurrenceId: c.occurrenceId,
        characterId: c.q.characterId,
        checkId: c.q.checkId,
        kind: c.q.kind,
        instructionEnglish: c.q.instructionEnglish,
        promptEnglish: c.q.prompt.english,
        audioText: c.q.prompt.hanzi,
        requiresAudio: true,
        status: s.questionStatus as CollectionQuestion['status'],
        attempts: s.attempts,
        assisted: s.assisted,
        hintLevel: s.hintLevel,
        choices: choices(p, r),
        hintEnglish: s.hintLevel > 0 ? char.teaching.hintEnglish : null,
        demonstrationEnglish:
          s.questionStatus === 'demonstrated'
            ? char.teaching.demonstrationEnglish
            : null,
      };
    }
    if (s.stepId === 'teach') {
      const char = p.characters[s.panelIndex];
      teachingPanel = {
        panelId: `teach-${char.characterId}`,
        characterId: char.characterId,
        hanzi: char.hanzi,
        mode: s.targetRoutes?.[s.panelIndex].mode ?? 'full',
        instructionEnglish: char.teaching.instructionEnglish,
        hintEnglish: char.teaching.hintEnglish,
        demonstrationEnglish: char.teaching.demonstrationEnglish,
        readings: char.readings
          .filter(
            (v) =>
              v.readingId === p.pairedStory.targets[s.panelIndex].readingId,
          )
          .map((v) => ({
            readingId: v.readingId,
            pinyin: v.pinyin,
            audioText: v.audioText,
          })),
        meanings: char.meanings.map((v) => v.english),
        words: char.wordAssociations.map((v) => ({
          wordId: v.wordId,
          text: v.text,
          pinyin: v.pinyin,
          english: v.english,
          context: { hanzi: v.context.hanzi, english: v.context.english },
        })),
      };
    }
    if (s.stepId === 'reader') {
      const word = p.characters
        .flatMap((c) => c.wordAssociations)
        .find((w) => w.wordId === p.pairedStory.reader.wordIds[s.panelIndex]);
      check(word, 'RUNTIME_STATE_INVALID');
      readerPanel = {
        title: p.pairedStory.reader.title,
        instructionEnglish: p.pairedStory.reader.instructionEnglish,
        panelId: `reader-${word.wordId}`,
        text: word.context.hanzi,
        english: word.context.english,
        audioText: word.context.hanzi,
        highlight: word.text,
      };
    }
    const empty: PairedGroup = {
      total: 0,
      independent: 0,
      supported: 0,
      unavailable: 0,
      pending: 0,
      firstResponses: [],
      helpCount: 0,
    };
    const publicGroup = (g: PairedGroup) => ({
      ...g,
      firstResponses: g.firstResponses.length,
    });
    const recap: CollectionRecap = {
      phase: s.phase,
      completedAt: s.completedAt,
      familiarity: publicGroup(
        s.phase === 'initial' ? group(p, r, 'familiarity') : empty,
      ),
      practice: publicGroup(
        s.phase === 'initial' ? group(p, r, 'practice') : empty,
      ),
      check: publicGroup(group(p, r, 'check')),
      evidenceLimits: [
        'These responses are practice evidence, not mastery or fluency.',
        'Missing visits provide no evidence.',
        'Synthetic review is test-only and does not grant human acceptance.',
      ],
    };
    const needed = c
      ? p.pairedStory.playback.cues.filter((q) => q.checkId === c.q.checkId)
      : s.stepId === 'teach'
        ? p.pairedStory.playback.cues.filter(
            (q) =>
              q.readingId === p.pairedStory.targets[s.panelIndex].readingId ||
              p.pairedStory.targets[s.panelIndex].practice.some(
                (w) => w.checkId === q.checkId,
              ),
          )
        : s.stepId === 'reader'
          ? p.pairedStory.playback.cues.filter(
              (q) => q.wordId === p.pairedStory.reader.wordIds[s.panelIndex],
            )
          : [];
    const playback = { ...p.pairedStory.playback, cues: needed };
    const events: CollectionEvent[] = r.events.map((e) => ({
      eventId: e.eventId,
      sequence: e.sequence,
      occurrenceId: e.occurrenceId,
      type: e.action.type,
      serverAt: e.serverTime,
      result: e.result,
      choiceId:
        typeof e.action.payload.choiceId === 'string'
          ? e.action.payload.choiceId
          : null,
    }));
    return {
      schemaVersion: viewSchema,
      ...l.identity,
      runId: r.runId,
      revision: r.revision,
      state: s,
      soundReview: policy.soundReview,
      question,
      teachingPanel,
      readerPanel,
      welcomePanel: s.stepId === 'welcome' ? p.pairedStory.welcome : null,
      lesson: {
        title: l.title,
        targets: p.characters.map((c) => ({
          characterId: c.characterId,
          hanzi: c.hanzi,
        })),
        instructionsEnglish: {
          welcome: p.pairedStory.welcome.instructionEnglish,
          objective: p.instructionsEnglish.objective,
          completion: p.instructionsEnglish.completion,
          recovery: p.instructionsEnglish.recovery,
        },
        playback,
      },
      events,
      recap,
      canContinue: s.stepId !== 'recap' && (!c || terminal(s)),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  return {
    compile: compilePairedRuntime,
    create: createPairedRun,
    validate: validatePairedRun,
    apply: applyPairedAction,
    project: projectPairedRun,
  };
}
