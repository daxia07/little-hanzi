import { expect, type Locator, type Page } from '@playwright/test';

export type SpeechMode = 'success' | 'failure' | 'no-voice';

const BASE_CHOICES: Record<string, string[]> = {
  'fam-mu': ['mu', 'lin', 'ren'],
  'fam-lin': ['lin', 'mu', 'da'],
  'find-mu': ['mu', 'lin', 'ren', 'da'],
  'find-lin': ['mu', 'lin', 'ren', 'da'],
  'check-mu-sound': ['mu', 'lin', 'ren'],
  'check-lin-sound': ['lin', 'mu', 'da'],
  'check-mu-reading': ['audio-mu', 'audio-lin', 'audio-ren'],
  'check-lin-reading': ['audio-lin', 'audio-mu', 'audio-da'],
  'review-mu-sound': ['mu', 'lin', 'ren'],
  'review-lin-sound': ['lin', 'mu', 'da'],
};

const QUESTION_ORDINAL: Record<string, number> = {
  'fam-mu': 0,
  'fam-lin': 1,
  'find-mu': 2,
  'find-lin': 3,
  'check-mu-sound': 4,
  'check-lin-sound': 5,
  'check-mu-reading': 6,
  'check-lin-reading': 7,
  'review-mu-sound': 8,
  'review-lin-sound': 9,
};

export function rotatedChoices(questionId: string, seed: number): string[] {
  const base = BASE_CHOICES[questionId] ?? [];
  if (!base.length) return [];
  const shift =
    (Math.abs(seed >>> 0) + (QUESTION_ORDINAL[questionId] ?? 0)) % base.length;
  return base.slice(shift).concat(base.slice(0, shift));
}

export async function installSpeechStub(
  page: Page,
  mode: SpeechMode = 'success',
): Promise<void> {
  await page.addInitScript((selectedMode: SpeechMode) => {
    const calls: Array<{ text: string; lang: string }> = [];
    const voices =
      selectedMode === 'no-voice'
        ? []
        : [
            {
              lang: 'zh-CN',
              name: 'Synthetic Mandarin',
              localService: true,
              voiceURI: 'synthetic-zh',
            },
          ];
    class FakeSpeechSynthesisUtterance {
      text: string;
      lang = '';
      voice: unknown = null;
      onstart: ((event: SpeechSynthesisEvent) => void) | null = null;
      onend: ((event: SpeechSynthesisEvent) => void) | null = null;
      onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;

      constructor(value = '') {
        this.text = value;
      }
    }
    const fakeSpeech = {
      speaking: false,
      paused: false,
      pending: false,
      getVoices: () => voices,
      cancel: () => {
        fakeSpeech.speaking = false;
      },
      pause: () => {
        fakeSpeech.paused = true;
      },
      resume: () => {
        fakeSpeech.paused = false;
      },
      speak: (utterance: FakeSpeechSynthesisUtterance) => {
        calls.push({ text: utterance.text, lang: utterance.lang });
        if (selectedMode === 'no-voice') return;
        fakeSpeech.speaking = true;
        utterance.onstart?.(new Event('start') as SpeechSynthesisEvent);
        queueMicrotask(() => {
          fakeSpeech.speaking = false;
          if (selectedMode === 'failure') {
            utterance.onerror?.({
              type: 'error',
              error: 'synthesis-failed',
            } as SpeechSynthesisErrorEvent);
          } else {
            utterance.onend?.(new Event('end') as SpeechSynthesisEvent);
          }
        });
      },
    };
    Object.defineProperty(window, '__forestSpeechCalls', {
      configurable: true,
      value: calls,
    });
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: fakeSpeech as unknown as SpeechSynthesis,
    });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: FakeSpeechSynthesisUtterance,
    });
  }, mode);
}

export async function speechCalls(
  page: Page,
): Promise<Array<{ text: string; lang: string }>> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __forestSpeechCalls?: Array<{ text: string; lang: string }>;
        }
      ).__forestSpeechCalls ?? [],
  );
}

export async function openForestRun(page: Page, runId: string): Promise<void> {
  await page.goto(`/preview/forest-01?run=${encodeURIComponent(runId)}`);
  await expect(page).toHaveURL(/\/preview\/forest-01/);
  await expect(
    page.locator(`[data-run-id="${runId}"][data-step-id]`).first(),
  ).toBeVisible();
}

export function question(page: Page, questionId: string): Locator {
  return page.locator(`[data-question-id="${questionId}"]`).first();
}

export function step(page: Page, stepId: string): Locator {
  const explicit = page.locator(`[data-step-id="${stepId}"]`);
  const fallback: Record<string, RegExp> = {
    welcome: /Build a little forest/i,
    familiarity: /What sounds familiar|Which character is in this word/i,
    learn: /Meet the two trees|quick reminder|look a little closer/i,
    build: /Build 林 together|Two 木 make 林/i,
    find: /Find the character|Find the character in the scene/i,
    read: /Read together|read one line|little more forest/i,
    check: /A quiet check|Which character did you hear|Which sound belongs/i,
    recap: /Your forest recap|Small steps count/i,
    'delayed-review': /A short follow-up|later recall/i,
  };
  return explicit
    .or(
      page.getByRole('heading', {
        name: fallback[stepId] ?? new RegExp(stepId, 'i'),
      }),
    )
    .first();
}

export async function startLesson(page: Page): Promise<void> {
  await page.getByRole('button', { name: /start/i }).first().click();
}

export async function continueLesson(page: Page): Promise<void> {
  const button = page
    .getByRole('button', {
      name: /^(continue|next|keep going|done|save|finish)/i,
    })
    .first();
  await expect(button).toBeVisible();
  await button.click();
}

export async function answerChoice(
  page: Page,
  questionId: string,
  choiceId: string,
  seed?: number,
  options: { expectSuccess?: boolean } = {},
): Promise<void> {
  const root = question(page, questionId);
  await expect(root).toBeVisible();
  const explicit = root.locator(`[data-choice-id="${choiceId}"]`).first();
  const isAudioOption = choiceId.startsWith('audio-');
  if (isAudioOption) {
    await expect(explicit).toBeVisible();
    const option = explicit.locator('..');
    const listen = option.getByRole('button', {
      name: /^Listen to option \d+$/i,
    });
    await expect(listen).toBeVisible();
    await listen.click();
    await expect(explicit).toBeEnabled();
    await submitAnswer(page, explicit, options.expectSuccess !== false);
    return;
  }
  if (await explicit.count()) {
    if (await explicit.isDisabled().catch(() => false)) {
      await playQuestionCueIfNeeded(root);
      await expect(explicit).toBeEnabled();
    }
    await submitAnswer(page, explicit, options.expectSuccess !== false);
    return;
  }
  const glyphs: Record<string, string> = {
    mu: '木',
    lin: '林',
    ren: '人',
    da: '大',
  };
  const named = choiceId.startsWith('audio-')
    ? root
        .getByRole('button', { name: /Select option/i })
        .nth(
          Math.max(
            0,
            seed === undefined
              ? 0
              : rotatedChoices(questionId, seed).indexOf(choiceId),
          ),
        )
    : root
        .getByRole('button', {
          name: new RegExp(`^${glyphs[choiceId] ?? choiceId}$`),
        })
        .first();
  await expect(named).toBeVisible();
  if (await named.isDisabled().catch(() => false)) {
    const option = named.locator('..');
    await option
      .getByRole('button', { name: /^Listen to option \d+$/i })
      .click();
    await expect(named).toBeEnabled();
  }
  await submitAnswer(page, named, options.expectSuccess !== false);
}

async function submitAnswer(
  page: Page,
  choice: Locator,
  expectSuccess: boolean,
): Promise<void> {
  const actionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/preview\/runs\/[^/]+\/actions$/.test(response.url()),
  );
  await choice.click();
  const response = await actionResponse;
  if (expectSuccess) expect(response.ok()).toBe(true);
}

export async function answerVisibleCharacter(
  page: Page,
  questionId: string,
  character: string,
): Promise<void> {
  const root = question(page, questionId);
  await expect(root).toBeVisible();
  const choice = root
    .getByRole('button', { name: new RegExp(`^${character}$`) })
    .first();
  await expect(choice).toBeVisible();
  if (await choice.isDisabled().catch(() => false)) {
    await playQuestionCueIfNeeded(root);
    await expect(choice).toBeEnabled();
  }
  await submitAnswer(page, choice, true);
}

async function playQuestionCueIfNeeded(root: Locator): Promise<void> {
  const cue = root
    .getByRole('button', {
      name: /play sound|play question sound|replay sound|mandarin word cue/i,
    })
    .first();
  await expect(cue).toBeVisible();
  await cue.click();
}

export async function requestHint(
  page: Page,
  questionId: string,
): Promise<void> {
  const root = question(page, questionId);
  await expect(root).toBeVisible();
  const actionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/preview\/runs\/[^/]+\/actions$/.test(response.url()),
  );
  await root.getByRole('button', { name: /hint|help|clue/i }).click();
  expect((await actionResponse).ok()).toBe(true);
}

export async function playRequiredAudio(
  page: Page,
  questionId: string,
): Promise<void> {
  const root = question(page, questionId);
  await expect(root).toBeVisible();
  const listen = root
    .getByRole('button', { name: /listen|play|hear/i })
    .first();
  await expect(listen).toBeVisible();
  await listen.click();
}

export async function component(
  page: Page,
  componentId: string,
): Promise<Locator> {
  const locator = page.locator(`[data-component-id="${componentId}"]`);
  if (await locator.count()) {
    await expect(locator).toBeVisible();
    return locator;
  }
  const fallback = page
    .getByRole('button', { name: '木', exact: true })
    .nth(componentId === 'mu-a' ? 0 : 1);
  await expect(fallback).toBeVisible();
  return fallback;
}

export async function componentSlot(
  page: Page,
  slot: string,
): Promise<Locator> {
  const locator = page.locator(`[data-component-slot="${slot}"]`);
  if (await locator.count()) {
    await expect(locator).toBeVisible();
    return locator;
  }
  const fallback = page.getByRole('button', {
    name: new RegExp(`${slot} tree slot`, 'i'),
  });
  await expect(fallback).toBeVisible();
  return fallback;
}

export async function completeBuildByTap(page: Page): Promise<void> {
  const first = await component(page, 'mu-a');
  const left = await componentSlot(page, 'left');
  await first.click();
  await left.click();
  await expect(left).toHaveAttribute('data-filled', 'true');
  const second = await component(page, 'mu-b');
  const right = await componentSlot(page, 'right');
  await second.click();
  await right.click();
  await expect(right).toHaveAttribute('data-filled', 'true');
  await expect(page.getByText('林', { exact: true })).toBeVisible();
}

export async function completeBuildByKeyboard(page: Page): Promise<void> {
  const first = await component(page, 'mu-a');
  await first.focus();
  await first.press('Enter');
  const left = await componentSlot(page, 'left');
  await left.press('Enter');
  await expect(left).toHaveAttribute('data-filled', 'true');
  const second = await component(page, 'mu-b');
  await second.focus();
  await second.press('Enter');
  const right = await componentSlot(page, 'right');
  await right.press('Enter');
  await expect(right).toHaveAttribute('data-filled', 'true');
  await expect(page.getByText('林', { exact: true })).toBeVisible();
}

export async function completeBuildByDrag(page: Page): Promise<void> {
  const first = await component(page, 'mu-a');
  const left = await componentSlot(page, 'left');
  await first.dragTo(left);
  await expect(left).toHaveAttribute('data-filled', 'true');
  const second = await component(page, 'mu-b');
  const right = await componentSlot(page, 'right');
  await second.dragTo(right);
  await expect(right).toHaveAttribute('data-filled', 'true');
  await expect(page.getByText('林', { exact: true })).toBeVisible();
}

export async function advanceUntil(
  page: Page,
  targetStepId: string,
  maxClicks = 12,
): Promise<void> {
  for (let i = 0; i < maxClicks; i += 1) {
    if (
      await step(page, targetStepId)
        .isVisible()
        .catch(() => false)
    )
      return;
    await continueLesson(page);
  }
  await expect(step(page, targetStepId)).toBeVisible();
}

export async function answerFamiliarity(
  page: Page,
  mode: 'new-reader' | 'familiar-reader' | 'mixed-reader',
): Promise<void> {
  await answerVisibleCharacter(
    page,
    'fam-mu',
    mode === 'new-reader' ? '林' : '木',
  );
  if (mode === 'new-reader') await answerVisibleCharacter(page, 'fam-mu', '木');
  await continueLesson(page);
  if (mode === 'new-reader' || mode === 'mixed-reader') {
    await answerVisibleCharacter(page, 'fam-lin', '木');
    await answerVisibleCharacter(page, 'fam-lin', '林');
  } else {
    await answerVisibleCharacter(page, 'fam-lin', '林');
  }
  await continueLesson(page);
}

export async function finishOrdinaryRead(page: Page): Promise<void> {
  await expect(page.getByText('这是木头。', { exact: true })).toBeVisible();
  await continueLesson(page);
  await expect(
    page.getByText('小鸟住在树林里。', { exact: true }),
  ).toBeVisible();
  await continueLesson(page);
}

export async function finishAllCorrectChecks(page: Page): Promise<void> {
  await answerChoice(page, 'check-mu-sound', 'mu');
  await continueLesson(page);
  await answerChoice(page, 'check-lin-sound', 'lin');
  await continueLesson(page);
  await playRequiredAudio(page, 'check-mu-reading');
  await answerChoice(page, 'check-mu-reading', 'audio-mu');
  await continueLesson(page);
  await playRequiredAudio(page, 'check-lin-reading');
  await answerChoice(page, 'check-lin-reading', 'audio-lin');
  await continueLesson(page);
}

export async function completeNewReader(
  page: Page,
  seed?: number,
): Promise<void> {
  await startLesson(page);
  await answerFamiliarity(page, 'new-reader');
  await advanceUntil(page, 'build');
  await completeBuildByTap(page);
  await continueLesson(page);
  await answerChoice(page, 'find-mu', 'mu');
  await continueLesson(page);
  await answerChoice(page, 'find-lin', 'lin');
  await continueLesson(page);
  await finishOrdinaryRead(page);
  await answerChoice(page, 'check-mu-sound', 'mu', seed);
  await continueLesson(page);
  await answerChoice(page, 'check-lin-sound', 'lin', seed);
  await continueLesson(page);
  await playRequiredAudio(page, 'check-mu-reading');
  await answerChoice(page, 'check-mu-reading', 'audio-mu', seed);
  await continueLesson(page);
  await playRequiredAudio(page, 'check-lin-reading');
  await answerChoice(page, 'check-lin-reading', 'audio-lin', seed);
  await continueLesson(page);
  await expect(
    page.getByText(/saved|complete|finished/i).first(),
  ).toBeVisible();
}
