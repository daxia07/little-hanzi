import { canonicalPackage, curriculumDigest } from './digest.ts';
import { inspectJson } from './json.ts';
import { validateCurriculumPackage } from './validate.ts';

export type CurriculumRuntimeErrorCode =
  | 'INVALID_PACKAGE'
  | 'RUNTIME_ADAPTER_UNAVAILABLE'
  | 'RUNTIME_PACKAGE_UNSUPPORTED'
  | 'INVALID_REQUEST'
  | 'RUNTIME_IDENTITY_MISMATCH'
  | 'RUNTIME_STATE_INVALID'
  | 'EVENT_CONFLICT'
  | 'STALE_REVISION'
  | 'INVALID_TRANSITION'
  | 'REVIEW_NOT_DUE';

const ERROR_MESSAGES: Record<CurriculumRuntimeErrorCode, string> = {
  INVALID_PACKAGE: 'Curriculum package is invalid.',
  RUNTIME_ADAPTER_UNAVAILABLE: 'The declared curriculum renderer is unavailable.',
  RUNTIME_PACKAGE_UNSUPPORTED: 'The curriculum package is not supported by this runtime.',
  INVALID_REQUEST: 'The curriculum request is invalid.',
  RUNTIME_IDENTITY_MISMATCH: 'The curriculum identity does not match the run.',
  RUNTIME_STATE_INVALID: 'The stored curriculum state is invalid.',
  EVENT_CONFLICT: 'The event ID conflicts with an earlier action.',
  STALE_REVISION: 'The curriculum revision is stale.',
  INVALID_TRANSITION: 'The curriculum action is not valid here.',
  REVIEW_NOT_DUE: 'The delayed review is not due yet.',
};

export class CurriculumRuntimeError extends Error {
  readonly code: CurriculumRuntimeErrorCode;

  constructor(code: CurriculumRuntimeErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'CurriculumRuntimeError';
    this.code = code;
  }
}

const CAPABILITIES = [
  'selection-v1',
  'recognition-v1',
  'delayed-review-v1',
  'progress-export-v1',
] as const;

const SERVER_ADAPTER: ServerRendererAdapter = Object.freeze({
  adapterId: 'forest-scripted',
  adapterVersion: 'forest-scripted-v1',
  capabilities: Object.freeze([...CAPABILITIES]),
});

const DAY_MS = 86_400_000;
const MAX_CLOCK = 8_640_000_000_000_000;
const RUN_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const OCCURRENCE_ID = /^[a-zA-Z0-9:$._-]{1,160}$/u;
const ACTION_TYPES = new Set([
  'continue',
  'answer',
  'hint',
  'audio-unavailable',
  'start-review',
]);
const OUTCOMES = new Set([
  'recorded',
  'correct',
  'incorrect',
  'demonstrated',
  'unavailable',
]);
const QUESTION_STATUSES = new Set([
  'open',
  'answered',
  'demonstrated',
  'unavailable',
]);
const GROUPS = ['familiarity', 'practice', 'final', 'delayed'] as const;
type CurriculumGroup = (typeof GROUPS)[number];
type StepKind = 'familiarity' | 'teach' | 'practice' | 'plain-print-check' | 'recap';
type RuntimeQuestionKind = 'plain-print' | 'word-context';

export interface ServerRendererAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly capabilities: readonly string[];
}

export interface CurriculumIdentity {
  readonly lessonId: string;
  readonly lessonVersion: string;
  readonly contentDigest: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
}

export interface CurriculumRunState {
  phase: 'initial' | 'delayed';
  stepIndex: number;
  questionIndex: number;
  questionStatus: 'open' | 'answered' | 'demonstrated' | 'unavailable' | null;
  attempts: number;
  hintLevel: 0 | 1 | 2;
  assisted: boolean;
  initialCompletedAt: number | null;
  reviewAvailableAt: number | null;
  reviewCompletedAt: number | null;
}

export interface CurriculumRun {
  schemaVersion: 's3-runtime-1';
  runId: string;
  identity: CurriculumIdentity;
  seed: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
  state: CurriculumRunState;
}

export interface CurriculumAction {
  eventId: string;
  expectedRevision: number;
  occurrenceId: string | null;
  type: 'continue' | 'answer' | 'hint' | 'audio-unavailable' | 'start-review';
  payload: Record<string, unknown>;
}

export interface CurriculumEventResult {
  outcome: 'recorded' | 'correct' | 'incorrect' | 'demonstrated' | 'unavailable';
  firstResponse: boolean;
  assisted: boolean;
}

export interface CurriculumAck {
  eventId: string;
  revision: number;
  result: CurriculumEventResult;
}

export interface CurriculumEvent {
  runId: string;
  eventId: string;
  sequence: number;
  phase: 'initial' | 'delayed';
  stepId: string;
  occurrenceId: string | null;
  checkId: string | null;
  characterId: string | null;
  type: CurriculumAction['type'];
  action: CurriculumAction;
  serverTime: number;
  result: CurriculumEventResult;
  ack: CurriculumAck;
}

export interface CurriculumActionResult {
  run: CurriculumRun;
  event: CurriculumEvent;
  ack: CurriculumAck;
  replayed: boolean;
}

export interface CurriculumQuestionChoice {
  choiceId: string;
  hanzi: string;
}

export interface CurriculumQuestionView {
  occurrenceId: string;
  checkId: string;
  kind: RuntimeQuestionKind;
  instructionEnglish: string;
  promptEnglish: string;
  audioText: string;
  requiresAudio: true;
  choices: CurriculumQuestionChoice[];
  questionStatus: Exclude<CurriculumRunState['questionStatus'], null>;
  attempts: number;
  hintEnglish: string | null;
  demonstrationEnglish: string | null;
}

export interface CurriculumTeachingView {
  characterId: string;
  hanzi: string;
  introduction: 'full' | 'reminder';
  instructionEnglish: string;
  demonstrationEnglish: string;
  readings: Array<{ readingId: string; pinyin: string; audioText: string }>;
  meanings: string[];
  words: Array<{
    wordId: string;
    text: string;
    pinyin: string;
    english: string;
    context: { hanzi: string; english: string };
  }>;
}

export interface CurriculumRunView {
  schemaVersion: 's3-runtime-1';
  runId: string;
  identity: CurriculumIdentity;
  revision: number;
  phase: 'initial' | 'delayed';
  step: {
    stepId: string;
    kind: StepKind | 'delayed-review';
    instructionEnglish: string;
    index: number;
    total: number;
  };
  question: CurriculumQuestionView | null;
  teaching: CurriculumTeachingView[];
  completion: {
    initialCompletedAt: number | null;
    reviewAvailableAt: number | null;
    reviewCompletedAt: number | null;
    reviewPolicyVersion: 's3-review-delay-1';
  };
  canContinue: boolean;
  canStartReview: boolean;
}

export interface CurriculumProgressGroup {
  total: number;
  independentCorrect: number;
  supported: number;
  unavailable: number;
  pending: number;
}

export interface CurriculumProgress {
  schemaVersion: 's3-progress-1';
  runId: string;
  identity: CurriculumIdentity;
  completion: CurriculumRunView['completion'];
  groups: Record<CurriculumGroup, CurriculumProgressGroup>;
  characters: Array<{
    characterId: string;
    hanzi: string;
    introduction: 'full' | 'reminder';
    groups: Record<CurriculumGroup, CurriculumProgressGroup>;
  }>;
  evidenceLimits: Record<string, string>;
}

interface CharacterManifest {
  characterId: string;
  hanzi: string;
  readings: Array<{ readingId: string; pinyin: string; audioText: string }>;
  meanings: Array<{ english: string }>;
  wordAssociations: Array<{
    wordId: string;
    text: string;
    pinyin: string;
    english: string;
    readingId: string;
    context: { hanzi: string; english: string; targetCharacter: string };
  }>;
  teaching: {
    instructionEnglish: string;
    hintEnglish: string;
    demonstrationEnglish: string;
    recognitionCheckId: string;
    delayedReview: {
      promptId: string;
      instructionEnglish: string;
      cueEnglish: string;
      recognitionCheckId: string;
    };
  };
}

interface CheckManifest {
  checkId: string;
  characterId: string;
  kind: RuntimeQuestionKind;
  instructionEnglish: string;
  prompt: { english: string; hanzi: string };
  choices: Array<{ choiceId: string; hanzi: string }>;
  correctChoiceId: string;
}

interface StepManifest {
  stepId: string;
  instructionEnglish: string;
  kind: StepKind;
  recognitionCheckIds: string[];
}

interface CurriculumManifest {
  lessonId: string;
  lessonVersion: string;
  title: string;
  canonicalizationVersion: string;
  placement: { trackId: string; sequence: number };
  renderer: {
    adapterId: string;
    adapterVersion: string;
    capabilities: string[];
  };
  instructionsEnglish: {
    welcome: string;
    objective: string;
    completion: string;
    recovery: string;
  };
  characters: CharacterManifest[];
  steps: StepManifest[];
  recognitionChecks: CheckManifest[];
  assets: unknown[];
}

interface RuntimeOccurrence {
  occurrenceId: string;
  phase: 'initial' | 'delayed';
  group: CurriculumGroup;
  stepIndex: number;
  referenceIndex: number;
  stepId: string;
  check: CheckManifest;
  character: CharacterManifest;
}

interface RuntimeStep {
  manifest: StepManifest;
  index: number;
  occurrences: RuntimeOccurrence[];
  teachCharacterIds: string[];
}

interface CompiledInternals {
  manifest: CurriculumManifest;
  characters: CharacterManifest[];
  characterById: Map<string, CharacterManifest>;
  checkById: Map<string, CheckManifest>;
  steps: RuntimeStep[];
  delayedOccurrences: RuntimeOccurrence[];
  finalRecapIndex: number;
}

export interface CompiledCurriculumLesson {
  readonly identity: CurriculumIdentity;
  readonly adapter: ServerRendererAdapter;
  readonly manifest: CurriculumManifest;
  readonly characters: readonly CharacterManifest[];
  readonly steps: readonly RuntimeStep[];
  readonly delayedOccurrences: readonly RuntimeOccurrence[];
}

function runtimeError(code: CurriculumRuntimeErrorCode): never {
  throw new CurriculumRuntimeError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) copy[key] = cloneValue(child);
    return copy as T;
  }
  return value;
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item, seen);
  } else {
    for (const child of Object.values(value)) freezeDeep(child, seen);
  }
  return Object.freeze(value);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalPackage(left) === canonicalPackage(right);
  } catch {
    return false;
  }
}

function isClock(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_CLOCK;
}

function isRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID.test(value);
}

function isOccurrenceId(value: unknown): value is string {
  return typeof value === 'string' && OCCURRENCE_ID.test(value);
}

function resetQuestion(state: CurriculumRunState, status: CurriculumRunState['questionStatus']): void {
  state.questionStatus = status;
  state.attempts = 0;
  state.hintLevel = 0;
  state.assisted = false;
}

function identityCopy(identity: CurriculumIdentity): CurriculumIdentity {
  return {
    lessonId: identity.lessonId,
    lessonVersion: identity.lessonVersion,
    contentDigest: identity.contentDigest,
    adapterId: identity.adapterId,
    adapterVersion: identity.adapterVersion,
  };
}

function identityEqual(left: unknown, right: CurriculumIdentity): left is CurriculumIdentity {
  return (
    isRecord(left) &&
    exactKeys(left, ['lessonId', 'lessonVersion', 'contentDigest', 'adapterId', 'adapterVersion']) &&
    left.lessonId === right.lessonId &&
    left.lessonVersion === right.lessonVersion &&
    left.contentDigest === right.contentDigest &&
    left.adapterId === right.adapterId &&
    left.adapterVersion === right.adapterVersion
  );
}

function checkProfile(manifest: CurriculumManifest): void {
  const recapIndices = manifest.steps
    .map((step, index) => (step.kind === 'recap' ? index : -1))
    .filter((index) => index >= 0);
  if (recapIndices.length !== 1 || recapIndices[0] !== manifest.steps.length - 1) {
    runtimeError('RUNTIME_PACKAGE_UNSUPPORTED');
  }

  const order: Record<StepKind, number> = {
    familiarity: 0,
    teach: 1,
    practice: 2,
    'plain-print-check': 3,
    recap: 4,
  };
  let previous = 0;
  let teachCount = 0;
  let practiceCount = 0;
  let finalCount = 0;
  const finalChecks = new Set<string>();
  const checkById = new Map(manifest.recognitionChecks.map((check) => [check.checkId, check]));
  for (const step of manifest.steps) {
    if (order[step.kind] < previous) runtimeError('RUNTIME_PACKAGE_UNSUPPORTED');
    previous = order[step.kind];
    if (step.kind === 'teach') teachCount += 1;
    if (step.kind === 'practice') practiceCount += 1;
    if (step.kind === 'plain-print-check') {
      finalCount += 1;
      for (const checkId of step.recognitionCheckIds) finalChecks.add(checkId);
    }
    if ((step.kind === 'practice' || step.kind === 'plain-print-check') && step.recognitionCheckIds.length === 0) {
      runtimeError('RUNTIME_PACKAGE_UNSUPPORTED');
    }
    if (step.kind === 'recap' && step.recognitionCheckIds.length > 0) {
      runtimeError('RUNTIME_PACKAGE_UNSUPPORTED');
    }
  }
  if (teachCount === 0 || practiceCount === 0 || finalCount === 0) {
    runtimeError('RUNTIME_PACKAGE_UNSUPPORTED');
  }

  for (const character of manifest.characters) {
    const taught = manifest.steps.some(
      (step) =>
        step.kind === 'teach' &&
        (step.recognitionCheckIds.length === 0 ||
          step.recognitionCheckIds.some((checkId) => checkById.get(checkId)?.characterId === character.characterId)),
    );
    const practiced = manifest.steps.some(
      (step) =>
        step.kind === 'practice' &&
        step.recognitionCheckIds.some((checkId) => checkById.get(checkId)?.characterId === character.characterId),
    );
    if (!taught || !practiced || !finalChecks.has(character.teaching.recognitionCheckId)) {
      runtimeError('RUNTIME_PACKAGE_UNSUPPORTED');
    }
  }
}

function buildInternals(manifest: CurriculumManifest): CompiledInternals {
  const characters = manifest.characters;
  const characterById = new Map(characters.map((character) => [character.characterId, character]));
  const checkById = new Map(manifest.recognitionChecks.map((check) => [check.checkId, check]));
  const finalRecapIndex = manifest.steps.length - 1;
  const steps: RuntimeStep[] = manifest.steps.map((step, index) => {
    const occurrences: RuntimeOccurrence[] = [];
    if (step.kind === 'familiarity' || step.kind === 'practice' || step.kind === 'plain-print-check') {
      const group: CurriculumGroup =
        step.kind === 'familiarity' ? 'familiarity' : step.kind === 'practice' ? 'practice' : 'final';
      step.recognitionCheckIds.forEach((checkId, referenceIndex) => {
        const check = checkById.get(checkId);
        const character = check ? characterById.get(check.characterId) : undefined;
        if (check && character) {
          occurrences.push({
            occurrenceId: `initial:${index}:${referenceIndex}`,
            phase: 'initial',
            group,
            stepIndex: index,
            referenceIndex,
            stepId: step.stepId,
            check,
            character,
          });
        }
      });
    }
    const teachCharacterIds: string[] = [];
    if (step.kind === 'teach') {
      if (step.recognitionCheckIds.length === 0) {
        teachCharacterIds.push(...characters.map((character) => character.characterId));
      } else {
        for (const checkId of step.recognitionCheckIds) {
          const characterId = checkById.get(checkId)?.characterId;
          if (characterId && !teachCharacterIds.includes(characterId)) teachCharacterIds.push(characterId);
        }
      }
    }
    return { manifest: step, index, occurrences, teachCharacterIds };
  });
  const delayedOccurrences: RuntimeOccurrence[] = characters.map((character, index) => {
    const check = checkById.get(character.teaching.delayedReview.recognitionCheckId);
    if (!check) runtimeError('RUNTIME_PACKAGE_UNSUPPORTED');
    return {
      occurrenceId: `delayed:${index}`,
      phase: 'delayed',
      group: 'delayed',
      stepIndex: finalRecapIndex,
      referenceIndex: index,
      stepId: '$delayed',
      check,
      character,
    };
  });
  return { manifest, characters, characterById, checkById, steps, delayedOccurrences, finalRecapIndex };
}

export function resolveServerRendererAdapter(
  adapterId: string,
  adapterVersion: string,
): ServerRendererAdapter | null {
  if (adapterId !== SERVER_ADAPTER.adapterId || adapterVersion !== SERVER_ADAPTER.adapterVersion) return null;
  return SERVER_ADAPTER;
}

export async function compileCurriculumRuntime(input: unknown): Promise<CompiledCurriculumLesson> {
  const inspected = inspectJson(input);
  if (inspected.errors.length || !isRecord(inspected.value)) runtimeError('INVALID_PACKAGE');
  const packageValue = inspected.value as unknown as CurriculumManifest;
  if (!validateCurriculumPackage(packageValue).ok) runtimeError('INVALID_PACKAGE');
  if (packageValue.lessonVersion === 'forest-01-v1') runtimeError('RUNTIME_PACKAGE_UNSUPPORTED');
  const adapter = resolveServerRendererAdapter(packageValue.renderer.adapterId, packageValue.renderer.adapterVersion);
  if (!adapter) runtimeError('RUNTIME_ADAPTER_UNAVAILABLE');
  checkProfile(packageValue);
  const contentDigest = await curriculumDigest(packageValue);
  const internals = buildInternals(packageValue);
  const identity: CurriculumIdentity = {
    lessonId: packageValue.lessonId,
    lessonVersion: packageValue.lessonVersion,
    contentDigest,
    adapterId: adapter.adapterId,
    adapterVersion: adapter.adapterVersion,
  };
  const lesson: CompiledCurriculumLesson = {
    identity,
    adapter,
    manifest: internals.manifest,
    characters: internals.characters,
    steps: internals.steps,
    delayedOccurrences: internals.delayedOccurrences,
  };
  return freezeDeep(lesson);
}

function internalsFor(lesson: CompiledCurriculumLesson): CompiledInternals {
  const manifest = lesson.manifest;
  const characters = [...lesson.characters];
  const characterById = new Map(characters.map((character) => [character.characterId, character]));
  const checkById = new Map(manifest.recognitionChecks.map((check) => [check.checkId, check]));
  return {
    manifest,
    characters,
    characterById,
    checkById,
    steps: [...lesson.steps],
    delayedOccurrences: [...lesson.delayedOccurrences],
    finalRecapIndex: manifest.steps.length - 1,
  };
}

function initialStateFor(lesson: CompiledCurriculumLesson): CurriculumRunState {
  const internals = internalsFor(lesson);
  const first = internals.steps[0];
  const scored = first.occurrences.length > 0;
  return {
    phase: 'initial',
    stepIndex: 0,
    questionIndex: 0,
    questionStatus: scored ? 'open' : null,
    attempts: 0,
    hintLevel: 0,
    assisted: false,
    initialCompletedAt: null,
    reviewAvailableAt: null,
    reviewCompletedAt: null,
  };
}

function makeInitialRun(lesson: CompiledCurriculumLesson, runId: string, seed: number, now: number): CurriculumRun {
  return {
    schemaVersion: 's3-runtime-1',
    runId,
    identity: identityCopy(lesson.identity),
    seed,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    state: initialStateFor(lesson),
  };
}

export function createCurriculumRun(
  lesson: CompiledCurriculumLesson,
  input: { runId: string; seed: number; now: number },
): CurriculumRun {
  if (!isRunId(input?.runId) || !Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff || !isClock(input.now)) {
    runtimeError('INVALID_REQUEST');
  }
  return makeInitialRun(lesson, input.runId, input.seed >>> 0, input.now);
}

function parseAction(value: unknown): CurriculumAction | null {
  const inspected = inspectJson(value);
  if (inspected.errors.length) return null;
  value = inspected.value;
  if (!isRecord(value) || !exactKeys(value, ['eventId', 'expectedRevision', 'occurrenceId', 'type', 'payload'])) return null;
  if (!isRunId(value.eventId)) return null;
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) return null;
  if (value.occurrenceId !== null && !isOccurrenceId(value.occurrenceId)) return null;
  if (typeof value.type !== 'string' || !ACTION_TYPES.has(value.type)) return null;
  if (!isRecord(value.payload)) return null;
  const payload = value.payload;
  if (value.type === 'answer') {
    if (!exactKeys(payload, ['choiceId']) || typeof payload.choiceId !== 'string' || payload.choiceId.length === 0) return null;
  } else if (!exactKeys(payload, [])) {
    return null;
  }
  return {
    eventId: value.eventId,
    expectedRevision: value.expectedRevision as number,
    occurrenceId: value.occurrenceId,
    type: value.type as CurriculumAction['type'],
    payload: cloneValue(payload),
  };
}

interface CurrentNode {
  phase: 'initial' | 'delayed';
  stepId: string;
  kind: StepKind | 'delayed-review';
  instructionEnglish: string;
  index: number;
  total: number;
  occurrence: RuntimeOccurrence | null;
  passive: boolean;
  recap: boolean;
  teachCharacterIds: string[];
}

function currentNode(lesson: CompiledCurriculumLesson, run: CurriculumRun): CurrentNode {
  const internals = internalsFor(lesson);
  const state = run.state;
  if (state.phase === 'delayed') {
    if (state.stepIndex !== internals.finalRecapIndex) runtimeError('RUNTIME_STATE_INVALID');
    if (state.questionIndex === internals.characters.length) {
      if (state.reviewCompletedAt === null || state.questionStatus !== null) runtimeError('RUNTIME_STATE_INVALID');
      return {
        phase: 'delayed',
        stepId: '$delayed-recap',
        kind: 'recap',
        instructionEnglish: internals.manifest.instructionsEnglish.completion,
        index: internals.characters.length,
        total: internals.characters.length,
        occurrence: null,
        passive: false,
        recap: true,
        teachCharacterIds: [],
      };
    }
    if (state.questionIndex < 0 || state.questionIndex >= internals.delayedOccurrences.length || state.reviewCompletedAt !== null) {
      runtimeError('RUNTIME_STATE_INVALID');
    }
    const occurrence = internals.delayedOccurrences[state.questionIndex];
    if (state.questionStatus === null) runtimeError('RUNTIME_STATE_INVALID');
    return {
      phase: 'delayed',
      stepId: '$delayed',
      kind: 'delayed-review',
      instructionEnglish: occurrence.character.teaching.delayedReview.instructionEnglish,
      index: state.questionIndex,
      total: internals.characters.length,
      occurrence,
      passive: false,
      recap: false,
      teachCharacterIds: [],
    };
  }
  if (state.stepIndex < 0 || state.stepIndex >= internals.steps.length) runtimeError('RUNTIME_STATE_INVALID');
  const step = internals.steps[state.stepIndex];
  if (step.manifest.kind === 'recap') {
    if (state.questionIndex !== 0 || state.questionStatus !== null || state.initialCompletedAt === null) runtimeError('RUNTIME_STATE_INVALID');
    return {
      phase: 'initial',
      stepId: step.manifest.stepId,
      kind: 'recap',
      instructionEnglish: step.manifest.instructionEnglish,
      index: step.index,
      total: internals.steps.length,
      occurrence: null,
      passive: false,
      recap: true,
      teachCharacterIds: [],
    };
  }
  if (step.manifest.kind === 'teach' || step.occurrences.length === 0) {
    if (state.questionIndex !== 0 || state.questionStatus !== null || state.attempts !== 0 || state.hintLevel !== 0 || state.assisted) {
      runtimeError('RUNTIME_STATE_INVALID');
    }
    return {
      phase: 'initial',
      stepId: step.manifest.stepId,
      kind: step.manifest.kind,
      instructionEnglish: step.manifest.instructionEnglish,
      index: step.index,
      total: internals.steps.length,
      occurrence: null,
      passive: true,
      recap: false,
      teachCharacterIds: step.teachCharacterIds,
    };
  }
  if (state.questionIndex < 0 || state.questionIndex >= step.occurrences.length || state.questionStatus === null) {
    runtimeError('RUNTIME_STATE_INVALID');
  }
  return {
    phase: 'initial',
    stepId: step.manifest.stepId,
    kind: step.manifest.kind,
    instructionEnglish: step.manifest.instructionEnglish,
    index: step.index,
    total: internals.steps.length,
    occurrence: step.occurrences[state.questionIndex],
    passive: false,
    recap: false,
    teachCharacterIds: [],
  };
}

function isTerminal(status: CurriculumRunState['questionStatus']): boolean {
  return status === 'answered' || status === 'demonstrated' || status === 'unavailable';
}

function sourceEventFields(node: CurrentNode): Pick<CurriculumEvent, 'phase' | 'stepId' | 'occurrenceId' | 'checkId' | 'characterId'> {
  return {
    phase: node.phase,
    stepId: node.stepId,
    occurrenceId: node.occurrence?.occurrenceId ?? null,
    checkId: node.occurrence?.check.checkId ?? null,
    characterId: node.occurrence?.character.characterId ?? null,
  };
}

function eventResult(
  outcome: CurriculumEventResult['outcome'],
  firstResponse: boolean,
  assisted: boolean,
): CurriculumEventResult {
  return { outcome, firstResponse, assisted };
}

function buildEvent(
  run: CurriculumRun,
  action: CurriculumAction,
  node: CurrentNode,
  now: number,
  result: CurriculumEventResult,
): { event: CurriculumEvent; ack: CurriculumAck } {
  const ack: CurriculumAck = {
    eventId: action.eventId,
    revision: run.revision + 1,
    result,
  };
  const event: CurriculumEvent = {
    runId: run.runId,
    eventId: action.eventId,
    sequence: run.revision + 1,
    ...sourceEventFields(node),
    type: action.type,
    action: cloneValue(action),
    serverTime: now,
    result,
    ack,
  };
  return { event, ack };
}

function advanceAfterContinue(lesson: CompiledCurriculumLesson, state: CurriculumRunState, node: CurrentNode, now: number): void {
  const internals = internalsFor(lesson);
  if (state.phase === 'delayed') {
    if (state.questionIndex + 1 < internals.delayedOccurrences.length) {
      state.questionIndex += 1;
      resetQuestion(state, 'open');
    } else {
      state.questionIndex = internals.characters.length;
      state.questionStatus = null;
      state.attempts = 0;
      state.hintLevel = 0;
      state.assisted = false;
      state.reviewCompletedAt = now;
    }
    return;
  }
  const step = internals.steps[state.stepIndex];
  if (!node.passive && state.questionIndex + 1 < step.occurrences.length) {
    state.questionIndex += 1;
    resetQuestion(state, 'open');
    return;
  }
  const nextIndex = state.stepIndex + 1;
  if (nextIndex >= internals.steps.length) runtimeError('INVALID_TRANSITION');
  const next = internals.steps[nextIndex];
  state.stepIndex = nextIndex;
  state.questionIndex = 0;
  if (next.manifest.kind === 'recap') {
    if (state.initialCompletedAt !== null) runtimeError('INVALID_TRANSITION');
    const reviewAvailableAt = now + DAY_MS;
    if (!isClock(reviewAvailableAt)) runtimeError('INVALID_REQUEST');
    state.initialCompletedAt = now;
    state.reviewAvailableAt = reviewAvailableAt;
    resetQuestion(state, null);
  } else if (next.manifest.kind === 'teach' || next.occurrences.length === 0) {
    resetQuestion(state, null);
  } else {
    resetQuestion(state, 'open');
  }
}

function reduceCore(
  lesson: CompiledCurriculumLesson,
  inputRun: CurriculumRun,
  action: CurriculumAction,
  now: number,
): CurriculumActionResult {
  if (action.expectedRevision !== inputRun.revision) runtimeError('STALE_REVISION');
  if (!isClock(now) || now < inputRun.updatedAt) runtimeError('INVALID_REQUEST');
  const node = currentNode(lesson, inputRun);
  if (action.occurrenceId !== (node.occurrence?.occurrenceId ?? null)) runtimeError('INVALID_TRANSITION');
  const run = cloneValue(inputRun);
  const state = run.state;
  let result: CurriculumEventResult;

  if (action.type === 'continue') {
    if (node.recap || (!node.passive && !isTerminal(state.questionStatus))) runtimeError('INVALID_TRANSITION');
    result = eventResult('recorded', false, false);
    advanceAfterContinue(lesson, state, node, now);
  } else if (action.type === 'start-review') {
    if (node.phase !== 'initial' || !node.recap || state.reviewAvailableAt === null || state.reviewCompletedAt !== null) {
      runtimeError('INVALID_TRANSITION');
    }
    if (now < state.reviewAvailableAt) runtimeError('REVIEW_NOT_DUE');
    state.phase = 'delayed';
    state.stepIndex = internalsFor(lesson).finalRecapIndex;
    state.questionIndex = 0;
    resetQuestion(state, 'open');
    result = eventResult('recorded', false, false);
  } else {
    if (node.occurrence === null || state.questionStatus !== 'open') runtimeError('INVALID_TRANSITION');
    const occurrence = node.occurrence;
    if (action.type === 'hint') {
      if (state.hintLevel >= 2) runtimeError('INVALID_TRANSITION');
      state.hintLevel = (state.hintLevel + 1) as 1 | 2;
      state.assisted = true;
      result = eventResult('recorded', false, true);
    } else if (action.type === 'audio-unavailable') {
      const firstResponse = state.attempts === 0;
      state.questionStatus = 'unavailable';
      result = eventResult('unavailable', firstResponse, state.assisted);
    } else {
      const choiceId = action.payload.choiceId;
      if (typeof choiceId !== 'string' || !occurrence.check.choices.some((choice) => choice.choiceId === choiceId)) {
        runtimeError('INVALID_REQUEST');
      }
      const firstResponse = state.attempts === 0;
      const assistedBefore = state.assisted;
      state.attempts += 1;
      if (choiceId === occurrence.check.correctChoiceId) {
        state.questionStatus = 'answered';
        result = eventResult('correct', firstResponse, assistedBefore);
      } else if (state.attempts >= 2) {
        state.questionStatus = 'demonstrated';
        state.hintLevel = 2;
        state.assisted = true;
        result = eventResult('demonstrated', false, true);
      } else {
        state.hintLevel = Math.max(1, state.hintLevel) as 1 | 2;
        state.assisted = true;
        result = eventResult('incorrect', firstResponse, assistedBefore);
      }
    }
  }

  run.revision += 1;
  run.updatedAt = now;
  const built = buildEvent(inputRun, action, node, now, result);
  return { run, event: built.event, ack: built.ack, replayed: false };
}

function stateScalarsValid(state: unknown): state is CurriculumRunState {
  if (!isRecord(state) || !exactKeys(state, [
    'phase',
    'stepIndex',
    'questionIndex',
    'questionStatus',
    'attempts',
    'hintLevel',
    'assisted',
    'initialCompletedAt',
    'reviewAvailableAt',
    'reviewCompletedAt',
  ])) return false;
  return (
    (state.phase === 'initial' || state.phase === 'delayed') &&
    Number.isSafeInteger(state.stepIndex) &&
    (state.stepIndex as number) >= 0 &&
    Number.isSafeInteger(state.questionIndex) &&
    (state.questionIndex as number) >= 0 &&
    (state.questionStatus === null || (typeof state.questionStatus === 'string' && QUESTION_STATUSES.has(state.questionStatus))) &&
    Number.isSafeInteger(state.attempts) &&
    (state.attempts as number) >= 0 &&
    (state.hintLevel === 0 || state.hintLevel === 1 || state.hintLevel === 2) &&
    typeof state.assisted === 'boolean' &&
    (state.initialCompletedAt === null || isClock(state.initialCompletedAt)) &&
    (state.reviewAvailableAt === null || isClock(state.reviewAvailableAt)) &&
    (state.reviewCompletedAt === null || isClock(state.reviewCompletedAt))
  );
}

function runScalarsValid(run: unknown): run is CurriculumRun {
  if (!isRecord(run) || !exactKeys(run, ['schemaVersion', 'runId', 'identity', 'seed', 'revision', 'createdAt', 'updatedAt', 'state'])) return false;
  return (
    run.schemaVersion === 's3-runtime-1' &&
    isRunId(run.runId) &&
    Number.isSafeInteger(run.seed) &&
    (run.seed as number) >= 0 &&
    (run.seed as number) <= 0xffffffff &&
    Number.isSafeInteger(run.revision) &&
    (run.revision as number) >= 0 &&
    isClock(run.createdAt) &&
    isClock(run.updatedAt) &&
    (run.updatedAt as number) >= (run.createdAt as number) &&
    stateScalarsValid(run.state)
  );
}

function eventScalarsValid(event: unknown): event is CurriculumEvent {
  if (!isRecord(event) || !exactKeys(event, [
    'runId',
    'eventId',
    'sequence',
    'phase',
    'stepId',
    'occurrenceId',
    'checkId',
    'characterId',
    'type',
    'action',
    'serverTime',
    'result',
    'ack',
  ])) return false;
  const result = event.result;
  const ack = event.ack;
  return (
    isRunId(event.runId) &&
    isRunId(event.eventId) &&
    Number.isSafeInteger(event.sequence) &&
    (event.sequence as number) > 0 &&
    (event.phase === 'initial' || event.phase === 'delayed') &&
    typeof event.stepId === 'string' &&
    (event.occurrenceId === null || isOccurrenceId(event.occurrenceId)) &&
    (event.checkId === null || typeof event.checkId === 'string') &&
    (event.characterId === null || typeof event.characterId === 'string') &&
    typeof event.type === 'string' &&
    ACTION_TYPES.has(event.type) &&
    parseAction(event.action) !== null &&
    isClock(event.serverTime) &&
    isRecord(result) &&
    exactKeys(result, ['outcome', 'firstResponse', 'assisted']) &&
    typeof result.outcome === 'string' &&
    OUTCOMES.has(result.outcome) &&
    typeof result.firstResponse === 'boolean' &&
    typeof result.assisted === 'boolean' &&
    isRecord(ack) &&
    exactKeys(ack, ['eventId', 'revision', 'result']) &&
    isRunId(ack.eventId) &&
    Number.isSafeInteger(ack.revision) &&
    isRecord(ack.result) &&
    exactKeys(ack.result, ['outcome', 'firstResponse', 'assisted'])
  );
}

function replayLedger(
  lesson: CompiledCurriculumLesson,
  run: CurriculumRun,
  events: CurriculumEvent[],
): void {
  if (!runScalarsValid(run) || !Array.isArray(events) || events.length !== run.revision) runtimeError('RUNTIME_STATE_INVALID');
  const internals = internalsFor(lesson);
  if (!identityEqual(run.identity, lesson.identity)) runtimeError('RUNTIME_IDENTITY_MISMATCH');
  const current = makeInitialRun(lesson, run.runId, run.seed, run.createdAt);
  const ids = new Set<string>();
  let replayed = current;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!eventScalarsValid(event) || event.runId !== run.runId || event.sequence !== index + 1 || ids.has(event.eventId)) {
      runtimeError('RUNTIME_STATE_INVALID');
    }
    ids.add(event.eventId);
    const action = parseAction(event.action);
    if (!action || action.expectedRevision !== replayed.revision || event.eventId !== action.eventId) {
      runtimeError('RUNTIME_STATE_INVALID');
    }
    let result: CurriculumActionResult;
    try {
      result = reduceCore(lesson, replayed, action, event.serverTime);
    } catch (error) {
      if (error instanceof CurriculumRuntimeError) runtimeError('RUNTIME_STATE_INVALID');
      runtimeError('RUNTIME_STATE_INVALID');
    }
    if (!canonicalEqual(result.event, event)) runtimeError('RUNTIME_STATE_INVALID');
    if (!canonicalEqual(result.ack, event.ack)) runtimeError('RUNTIME_STATE_INVALID');
    replayed = result.run;
  }
  if (!canonicalEqual(replayed, run)) runtimeError('RUNTIME_STATE_INVALID');
  // Keep this read so the semantic replay remains explicitly tied to the compiled package.
  if (internals.steps.length === 0) runtimeError('RUNTIME_STATE_INVALID');
}

function validateRunAndLedger(
  lesson: CompiledCurriculumLesson,
  run: CurriculumRun,
  events: CurriculumEvent[],
): void {
  if (!isRecord(run) || !identityEqual(run.identity, lesson.identity)) runtimeError('RUNTIME_IDENTITY_MISMATCH');
  replayLedger(lesson, run, events);
  try {
    currentNode(lesson, run);
  } catch (error) {
    if (error instanceof CurriculumRuntimeError && error.code === 'RUNTIME_IDENTITY_MISMATCH') throw error;
    runtimeError('RUNTIME_STATE_INVALID');
  }
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function orderedChoices(run: CurriculumRun, occurrence: RuntimeOccurrence): CurriculumQuestionChoice[] {
  const choices = occurrence.check.choices.map((choice) => ({ choiceId: choice.choiceId, hanzi: choice.hanzi }));
  let state = (run.seed ^ hashString(occurrence.occurrenceId)) >>> 0;
  for (let index = choices.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state ^ (state >>> 16), 1_664_525) + 1_013_904_223) >>> 0;
    const swap = state % (index + 1);
    const item = choices[index];
    choices[index] = choices[swap];
    choices[swap] = item;
  }
  return choices;
}

function familiarityIndependent(
  lesson: CompiledCurriculumLesson,
  events: CurriculumEvent[],
  characterId: string,
): boolean {
  const occurrences = internalsFor(lesson).steps
    .filter((step) => step.manifest.kind === 'familiarity')
    .flatMap((step) => step.occurrences)
    .filter((occurrence) => occurrence.character.characterId === characterId);
  if (occurrences.length === 0) return false;
  return occurrences.every((occurrence) => {
    const firstAnswer = events.find(
      (event) =>
        event.phase === 'initial' &&
        event.occurrenceId === occurrence.occurrenceId &&
        (event.type === 'answer' || event.type === 'audio-unavailable'),
    );
    return firstAnswer?.type === 'answer' && firstAnswer.result.outcome === 'correct' && firstAnswer.result.firstResponse && !firstAnswer.result.assisted;
  });
}

function teachingView(
  lesson: CompiledCurriculumLesson,
  events: CurriculumEvent[],
  node: CurrentNode,
): CurriculumTeachingView[] {
  const internals = internalsFor(lesson);
  if (node.kind !== 'teach') return [];
  return node.teachCharacterIds.map((characterId) => {
    const character = internals.characterById.get(characterId);
    if (!character) runtimeError('RUNTIME_STATE_INVALID');
    return {
      characterId: character.characterId,
      hanzi: character.hanzi,
      introduction: familiarityIndependent(lesson, events, character.characterId) ? 'reminder' : 'full',
      instructionEnglish: character.teaching.instructionEnglish,
      demonstrationEnglish: character.teaching.demonstrationEnglish,
      readings: character.readings.map((reading) => ({
        readingId: reading.readingId,
        pinyin: reading.pinyin,
        audioText: reading.audioText,
      })),
      meanings: character.meanings.map((meaning) => meaning.english),
      words: character.wordAssociations.map((word) => ({
        wordId: word.wordId,
        text: word.text,
        pinyin: word.pinyin,
        english: word.english,
        context: { hanzi: word.context.hanzi, english: word.context.english },
      })),
    };
  });
}

function questionView(run: CurriculumRun, node: CurrentNode): CurriculumQuestionView | null {
  if (!node.occurrence || node.recap || node.passive) return null;
  const occurrence = node.occurrence;
  const check = occurrence.check;
  return {
    occurrenceId: occurrence.occurrenceId,
    checkId: check.checkId,
    kind: check.kind,
    instructionEnglish: node.phase === 'delayed' ? occurrence.character.teaching.delayedReview.instructionEnglish : check.instructionEnglish,
    promptEnglish: node.phase === 'delayed' ? occurrence.character.teaching.delayedReview.cueEnglish : check.prompt.english,
    audioText: check.prompt.hanzi,
    requiresAudio: true,
    choices: orderedChoices(run, occurrence),
    questionStatus: run.state.questionStatus as Exclude<CurriculumRunState['questionStatus'], null>,
    attempts: run.state.attempts,
    hintEnglish: run.state.hintLevel >= 1 ? occurrence.character.teaching.hintEnglish : null,
    demonstrationEnglish: run.state.hintLevel >= 2 ? occurrence.character.teaching.demonstrationEnglish : null,
  };
}

function completionView(run: CurriculumRun): CurriculumRunView['completion'] {
  return {
    initialCompletedAt: run.state.initialCompletedAt,
    reviewAvailableAt: run.state.reviewAvailableAt,
    reviewCompletedAt: run.state.reviewCompletedAt,
    reviewPolicyVersion: 's3-review-delay-1',
  };
}

export function projectCurriculumRun(
  lesson: CompiledCurriculumLesson,
  run: CurriculumRun,
  events: CurriculumEvent[],
  now: number,
): CurriculumRunView {
  if (!isClock(now)) runtimeError('INVALID_REQUEST');
  validateRunAndLedger(lesson, run, events);
  const node = currentNode(lesson, run);
  const step: CurriculumRunView['step'] = {
    stepId: node.stepId,
    kind: node.kind,
    instructionEnglish: node.instructionEnglish,
    index: node.index,
    total: node.total,
  };
  const canContinue = !node.recap && (node.passive || isTerminal(run.state.questionStatus));
  const canStartReview = node.phase === 'initial' && node.recap && run.state.reviewAvailableAt !== null && run.state.reviewCompletedAt === null && now >= run.state.reviewAvailableAt;
  return {
    schemaVersion: 's3-runtime-1',
    runId: run.runId,
    identity: identityCopy(lesson.identity),
    revision: run.revision,
    phase: run.state.phase,
    step,
    question: questionView(run, node),
    teaching: teachingView(lesson, events, node),
    completion: completionView(run),
    canContinue,
    canStartReview,
  };
}

function emptyProgressGroup(): CurriculumProgressGroup {
  return { total: 0, independentCorrect: 0, supported: 0, unavailable: 0, pending: 0 };
}

function occurrenceProgress(
  occurrence: RuntimeOccurrence,
  events: CurriculumEvent[],
): keyof Omit<CurriculumProgressGroup, 'total'> {
  const terminal = [...events]
    .filter((event) => event.phase === occurrence.phase && event.occurrenceId === occurrence.occurrenceId)
    .filter((event) => event.result.outcome === 'correct' || event.result.outcome === 'demonstrated' || event.result.outcome === 'unavailable')
    .at(-1);
  if (!terminal) return 'pending';
  if (terminal.result.outcome === 'unavailable') return 'unavailable';
  if (terminal.result.outcome === 'correct' && terminal.result.firstResponse && !terminal.result.assisted) return 'independentCorrect';
  return 'supported';
}

function allOccurrences(lesson: CompiledCurriculumLesson): RuntimeOccurrence[] {
  const internals = internalsFor(lesson);
  return [
    ...internals.steps.flatMap((step) => step.occurrences),
    ...internals.delayedOccurrences,
  ];
}

function progressForOccurrences(occurrences: RuntimeOccurrence[], events: CurriculumEvent[]): CurriculumProgressGroup {
  const result = emptyProgressGroup();
  result.total = occurrences.length;
  for (const occurrence of occurrences) result[occurrenceProgress(occurrence, events)] += 1;
  return result;
}

export function projectCurriculumProgress(
  lesson: CompiledCurriculumLesson,
  run: CurriculumRun,
  events: CurriculumEvent[],
): CurriculumProgress {
  validateRunAndLedger(lesson, run, events);
  const internals = internalsFor(lesson);
  const grouped = new Map<CurriculumGroup, RuntimeOccurrence[]>();
  for (const group of GROUPS) grouped.set(group, []);
  for (const occurrence of allOccurrences(lesson)) grouped.get(occurrence.group)?.push(occurrence);
  const groups = {
    familiarity: progressForOccurrences(grouped.get('familiarity') ?? [], events),
    practice: progressForOccurrences(grouped.get('practice') ?? [], events),
    final: progressForOccurrences(grouped.get('final') ?? [], events),
    delayed: progressForOccurrences(grouped.get('delayed') ?? [], events),
  };
  const characters = internals.characters.map((character) => {
    const characterOccurrences = allOccurrences(lesson).filter((occurrence) => occurrence.character.characterId === character.characterId);
    const byGroup = new Map<CurriculumGroup, RuntimeOccurrence[]>();
    for (const group of GROUPS) byGroup.set(group, characterOccurrences.filter((occurrence) => occurrence.group === group));
    const introduction: 'full' | 'reminder' = familiarityIndependent(lesson, events, character.characterId) ? 'reminder' : 'full';
    return {
      characterId: character.characterId,
      hanzi: character.hanzi,
      introduction,
      groups: {
        familiarity: progressForOccurrences(byGroup.get('familiarity') ?? [], events),
        practice: progressForOccurrences(byGroup.get('practice') ?? [], events),
        final: progressForOccurrences(byGroup.get('final') ?? [], events),
        delayed: progressForOccurrences(byGroup.get('delayed') ?? [], events),
      },
    };
  });
  return {
    schemaVersion: 's3-progress-1',
    runId: run.runId,
    identity: identityCopy(lesson.identity),
    completion: completionView(run),
    groups,
    characters,
    evidenceLimits: {
      completion: 'Completion records a finished activity and does not establish mastery.',
      firstResponse: 'Independent evidence means a correct first response without assistance.',
      assistance: 'Hints, corrections and demonstrations remain supported evidence.',
      audio: 'Unavailable audio is recorded separately and is not scored as correct.',
      delayed: 'Delayed review is a later practice occurrence and remains separate from initial evidence.',
    },
  };
}

export function applyCurriculumAction(
  lesson: CompiledCurriculumLesson,
  run: CurriculumRun,
  events: CurriculumEvent[],
  input: unknown,
  now: number,
): CurriculumActionResult {
  const action = parseAction(input);
  if (!action || !isClock(now)) runtimeError('INVALID_REQUEST');
  validateRunAndLedger(lesson, run, events);
  const duplicate = events.find((event) => event.eventId === action.eventId);
  if (duplicate) {
    if (!canonicalEqual(duplicate.action, action)) runtimeError('EVENT_CONFLICT');
    return {
      run: cloneValue(run),
      event: cloneValue(duplicate),
      ack: cloneValue(duplicate.ack),
      replayed: true,
    };
  }
  if (action.expectedRevision !== run.revision) runtimeError('STALE_REVISION');
  return reduceCore(lesson, run, action, now);
}
