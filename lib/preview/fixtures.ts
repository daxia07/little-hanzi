import { isLessonVersion } from './content.ts';
import { makeRunId, type PreviewStore } from './store.ts';
import type { PreviewAction, PreviewRun, LessonVersion } from './types.ts';

export const FIXTURE_NOW = '2026-09-25T00:00:00.000Z';
export const FIXTURE_SCENARIOS = [
  'new-reader',
  'familiar-reader',
  'mixed-reader',
  'needs-help',
  'in-progress',
  'completed-not-due',
  'review-due',
  'legacy-and-two-runs',
] as const;
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number];

export interface FixtureResult {
  scenario: FixtureScenario;
  seed: number;
  runIds: string[];
  legacyProfile?: string;
  expected: Record<string, unknown>;
}

function isScenario(value: string): value is FixtureScenario {
  return (FIXTURE_SCENARIOS as readonly string[]).includes(value);
}

async function send(
  store: PreviewStore,
  runId: string,
  type: PreviewAction['type'],
  stepId: PreviewAction['stepId'],
  payload: Record<string, unknown>,
  counter: { value: number },
): Promise<void> {
  const run = await store.getRun(runId);
  if (!run) throw new Error('fixture run disappeared');
  counter.value += 1;
  await store.applyAction(runId, {
    eventId: `fixture-${counter.value}`,
    expectedRevision: run.revision,
    stepId,
    type,
    payload,
  });
}

async function startLesson(
  store: PreviewStore,
  runId: string,
  counter: { value: number },
): Promise<void> {
  await send(store, runId, 'continue', 'welcome', {}, counter);
}

async function answer(
  store: PreviewStore,
  runId: string,
  questionId: string,
  choiceId: string,
  counter: { value: number },
): Promise<void> {
  const run = await store.getRun(runId);
  if (!run) throw new Error('fixture run disappeared');
  await send(
    store,
    runId,
    'answer',
    run.state.stepId,
    { questionId, choiceId },
    counter,
  );
}

async function continueRun(
  store: PreviewStore,
  runId: string,
  counter: { value: number },
): Promise<void> {
  const run = await store.getRun(runId);
  if (!run) throw new Error('fixture run disappeared');
  await send(store, runId, 'continue', run.state.stepId, {}, counter);
}

async function familiarFirstQuestions(
  store: PreviewStore,
  runId: string,
  mode: 'new' | 'familiar' | 'mixed',
  counter: { value: number },
): Promise<void> {
  await startLesson(store, runId, counter);
  if (mode === 'familiar' || mode === 'mixed')
    await answer(store, runId, 'fam-mu', 'mu', counter);
  else {
    await answer(store, runId, 'fam-mu', 'lin', counter);
    await answer(store, runId, 'fam-mu', 'mu', counter);
  }
  await continueRun(store, runId, counter);
  if (mode === 'familiar')
    await answer(store, runId, 'fam-lin', 'lin', counter);
  else if (mode === 'mixed') {
    await answer(store, runId, 'fam-lin', 'mu', counter);
    await answer(store, runId, 'fam-lin', 'lin', counter);
  } else {
    await answer(store, runId, 'fam-lin', 'mu', counter);
    await answer(store, runId, 'fam-lin', 'lin', counter);
  }
  await continueRun(store, runId, counter);
}

async function buildFindRead(
  store: PreviewStore,
  runId: string,
  counter: { value: number },
): Promise<void> {
  await continueRun(store, runId, counter); // V1/combined reminder -> build; V3 first panel -> second
  const afterPanel = await store.getRun(runId);
  if (
    afterPanel?.lessonVersion === 'forest-01-v3' &&
    afterPanel.state.stepId === 'learn'
  )
    await continueRun(store, runId, counter);
  await send(
    store,
    runId,
    'place-component',
    'build',
    { componentId: 'mu-a', slot: 'left' },
    counter,
  );
  await send(
    store,
    runId,
    'place-component',
    'build',
    { componentId: 'mu-b', slot: 'right' },
    counter,
  );
  await continueRun(store, runId, counter); // build -> find
  await answer(store, runId, 'find-mu', 'mu', counter);
  await continueRun(store, runId, counter);
  await answer(store, runId, 'find-lin', 'lin', counter);
  await continueRun(store, runId, counter); // find -> read
  await continueRun(store, runId, counter); // read wood -> grove
  await continueRun(store, runId, counter); // read -> check
}

async function finalChecks(
  store: PreviewStore,
  runId: string,
  counter: { value: number },
  needsHelp = false,
): Promise<void> {
  if (needsHelp) {
    await answer(store, runId, 'check-mu-sound', 'lin', counter);
    await answer(store, runId, 'check-mu-sound', 'ren', counter);
    await continueRun(store, runId, counter);
    await answer(store, runId, 'check-lin-sound', 'lin', counter);
    await continueRun(store, runId, counter);
    const run = await store.getRun(runId);
    if (!run) throw new Error('fixture run disappeared');
    await send(
      store,
      runId,
      'hint',
      run.state.stepId,
      { questionId: 'check-mu-reading' },
      counter,
    );
    await answer(store, runId, 'check-mu-reading', 'audio-mu', counter);
    await continueRun(store, runId, counter);
    await send(
      store,
      runId,
      'audio-unavailable',
      'check',
      { questionId: 'check-lin-reading' },
      counter,
    );
    await continueRun(store, runId, counter);
    return;
  }
  await answer(store, runId, 'check-mu-sound', 'mu', counter);
  await continueRun(store, runId, counter);
  await answer(store, runId, 'check-lin-sound', 'lin', counter);
  await continueRun(store, runId, counter);
  await answer(store, runId, 'check-mu-reading', 'audio-mu', counter);
  await continueRun(store, runId, counter);
  await answer(store, runId, 'check-lin-reading', 'audio-lin', counter);
  await continueRun(store, runId, counter);
}

async function makeOne(
  store: PreviewStore,
  scenario: FixtureScenario,
  seed: number,
  counter: { value: number },
  lessonVersion: LessonVersion,
): Promise<PreviewRun> {
  const run = await store.createRun({
    runId: makeRunId(`fixture-${scenario}`),
    seed,
    now: FIXTURE_NOW,
    synthetic: true,
    scenario,
    lessonVersion,
  });
  if (
    scenario === 'new-reader' ||
    scenario === 'familiar-reader' ||
    scenario === 'mixed-reader' ||
    scenario === 'needs-help' ||
    scenario === 'in-progress' ||
    scenario === 'completed-not-due' ||
    scenario === 'review-due'
  ) {
    const mode =
      scenario === 'familiar-reader'
        ? 'familiar'
        : scenario === 'mixed-reader'
          ? 'mixed'
          : 'new';
    await familiarFirstQuestions(store, run.runId, mode, counter);
    await buildFindRead(store, run.runId, counter);
    if (scenario === 'in-progress') {
      await answer(store, run.runId, 'check-mu-sound', 'mu', counter);
      await continueRun(store, run.runId, counter);
    } else {
      await finalChecks(store, run.runId, counter, scenario === 'needs-help');
      if (scenario === 'completed-not-due')
        await store.setClock(run.runId, '2026-09-25T23:00:00.000Z');
      if (scenario === 'review-due')
        await store.setClock(run.runId, '2026-09-26T00:00:00.000Z');
    }
  }
  return (await store.getRun(run.runId)) as PreviewRun;
}

export async function createFixture(
  store: PreviewStore,
  scenarioInput: string,
  seed: number,
  lessonVersion: LessonVersion = 'forest-01-v1',
): Promise<FixtureResult> {
  if (!isLessonVersion(lessonVersion))
    throw new Error('lesson version is unsupported');
  if (!isScenario(scenarioInput)) throw new Error('unknown fixture scenario');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error('seed must be an unsigned 32-bit integer');
  const counter = { value: 0 };
  if (scenarioInput === 'legacy-and-two-runs') {
    const first = await makeOne(
      store,
      'in-progress',
      seed,
      counter,
      lessonVersion,
    );
    const second = await makeOne(
      store,
      'in-progress',
      seed,
      counter,
      lessonVersion,
    );
    const legacyProfile = await store.seedLegacyProfile();
    return {
      scenario: scenarioInput,
      seed,
      runIds: [first.runId, second.runId],
      expected: { legacyFixture: 'synthetic-poc-1', independentRuns: 2 },
      legacyProfile,
    };
  }
  const run = await makeOne(store, scenarioInput, seed, counter, lessonVersion);
  const expected =
    scenarioInput === 'needs-help'
      ? { familiarity: [0, 2, 0], final: [1, 2, 1] }
      : scenarioInput === 'in-progress'
        ? { currentQuestion: 'check-lin-sound', final: [1, 0, 3] }
        : { lessonVersion };
  return { scenario: scenarioInput, seed, runIds: [run.runId], expected };
}
