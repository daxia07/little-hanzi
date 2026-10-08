'use client';

import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  Headphones,
  HelpCircle,
  Home,
  LockKeyhole,
  MessageCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Volume2,
  WifiOff,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FOREST_AUDIO_TEXT,
  FOREST_CHOICE_IDS,
  FOREST_HELP,
  FOREST_LABELS,
  FOREST_LESSON_VERSION,
  ForestActionResponse,
  ForestApiError,
  ForestRun,
  ForestState,
  ForestActionType,
  createForestRun,
  getForestRun,
  newForestId,
  readForestOutbox,
  rotateForestChoices,
  sendForestAction,
  sendForestFeedback,
  speakForest,
  stopForestSpeech,
  writeForestOutbox,
  clearForestOutbox,
  forestRecoveryAvailable,
  type ForestPendingAction,
} from '@/lib/forest-client';
import type {
  ForestLessonTransport,
  ForestRecoveryScope,
  ForestRecoveryStore,
} from '@/lib/forest-transport';
import styles from './forest.module.css';
import { ForestIllustration, ReadingIllustration } from './illustrations';

type Screen =
  | 'welcome'
  | 'familiarity'
  | 'learn'
  | 'build'
  | 'find'
  | 'read'
  | 'check'
  | 'recap'
  | 'review';
type SaveState = 'saved' | 'pending' | 'error' | 'offline';

const SCREEN_ORDER: Screen[] = [
  'welcome',
  'familiarity',
  'learn',
  'build',
  'find',
  'read',
  'check',
  'recap',
];
const QUESTION_IDS = new Set(Object.keys(FOREST_CHOICE_IDS));
const READING_AUDIO: Record<string, string> = {
  'audio-mu': '木。',
  'audio-lin': '林。',
  'audio-ren': '人。',
  'audio-da': '大。',
};
function stateQuestion(state: ForestState) {
  return (
    state.questionId || (QUESTION_IDS.has(state.stepId) ? state.stepId : null)
  );
}

function screenForState(state: ForestState): Screen {
  const questionId = stateQuestion(state);
  if (state.stepId === 'recap' || state.stepId === 'complete') return 'recap';
  if (
    state.phase === 'delayed' ||
    state.stepId === 'delayed-review' ||
    state.stepId.startsWith('review')
  )
    return 'review';
  if (questionId?.startsWith('fam-') || state.stepId.startsWith('familiar'))
    return 'familiarity';
  if (questionId?.startsWith('find-') || state.stepId.startsWith('find'))
    return 'find';
  if (questionId?.startsWith('check-') || state.stepId.startsWith('check'))
    return 'check';
  if (state.stepId.startsWith('learn')) return 'learn';
  if (state.stepId.startsWith('build')) return 'build';
  if (state.stepId.startsWith('read')) return 'read';
  if (
    state.stepId === 'recap' ||
    state.stepId === 'complete' ||
    state.completedAt
  )
    return 'recap';
  return 'welcome';
}

function progressFor(screen: Screen, questionId: string | null) {
  if (screen === 'review') return 92;
  if (screen === 'recap') return 100;
  const index = SCREEN_ORDER.indexOf(screen);
  if (screen === 'familiarity' && questionId === 'fam-lin') return 20;
  if (screen === 'find' && questionId === 'find-lin') return 52;
  if (screen === 'check') {
    const checkIndex = [
      'check-mu-sound',
      'check-lin-sound',
      'check-mu-reading',
      'check-lin-reading',
    ].indexOf(questionId || '');
    return 65 + Math.max(0, checkIndex) * 6;
  }
  return Math.max(4, Math.round((index / (SCREEN_ORDER.length - 1)) * 90));
}

function dateLabel(value: string | null | undefined) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function errorText(error: unknown, authenticated = false) {
  if (error instanceof ForestApiError) {
    if (error.status === 404)
      return authenticated
        ? 'This child learning record is no longer available.'
        : 'This preview run is no longer available. Start a fresh forest lesson.';
    if (error.status === 409)
      return 'This run changed in another tab. We refreshed the latest saved step.';
    if (error.status === 503)
      return authenticated
        ? 'The learning service is temporarily unavailable. Your pending action is kept here to retry.'
        : 'The preview database is temporarily unavailable. Your pending action is kept here to retry.';
    if (error.status === 403)
      return authenticated
        ? 'This account can read the record but cannot change it.'
        : 'This local preview is not enabled for this server.';
    return error.message;
  }
  const status =
    typeof error === 'object' && error && 'status' in error
      ? Number((error as { status?: unknown }).status)
      : 0;
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  if (authenticated) {
    if (code === 'ONBOARDING_REQUIRED')
      return 'Complete the child plan before starting this lesson.';
    if (code === 'LESSON_NOT_RELEASED')
      return 'This lesson is not available for this pilot installation yet.';
    if (code === 'ASSIGNMENT_REQUIRED')
      return 'A parent must assign this lesson before it can start.';
    if (status === 401)
      return 'Your invited session changed. Sign in again to continue.';
    if (status === 403)
      return 'This account can read the record but cannot change it.';
    if (status === 404)
      return 'This child learning record is no longer available.';
    if (status >= 500)
      return 'The learning service is temporarily unavailable. Check the connection and retry.';
    if (error instanceof Error) return error.message;
    return 'We could not reach this child learning record. Check the connection and retry.';
  }
  return 'We could not reach the forest preview. Check the connection and try again.';
}

function runWithAction(run: ForestRun, response: ForestActionResponse) {
  return { ...run, state: response.state, revision: response.revision };
}

function isDue(run: ForestRun) {
  if (typeof run.reviewDue === 'boolean') return run.reviewDue;
  return Boolean(
    run.reviewAvailableAt &&
    new Date(run.reviewAvailableAt).getTime() <= Date.now(),
  );
}

function hintPresentation(run: ForestRun, lastOutcome: string | null) {
  const hintLevel =
    typeof run.state.hintLevel === 'number' ? run.state.hintLevel : 0;
  const demonstrated =
    run.state.questionStatus === 'demonstrated' ||
    hintLevel >= 2 ||
    lastOutcome === 'demonstrated';
  const hinted =
    hintLevel >= 1 || lastOutcome === 'incorrect' || lastOutcome === 'recorded';
  return { hinted, demonstrated };
}

function actionPayload(
  run: ForestRun,
  stepId: string,
  type: ForestActionType,
  payload: Record<string, unknown>,
  eventId: string,
): ForestPendingAction {
  return {
    runId: run.runId,
    lessonVersion: run.lessonVersion,
    eventId,
    expectedRevision: run.revision,
    stepId,
    type,
    payload,
    createdAt: new Date().toISOString(),
  };
}

function readLastForestRunId() {
  try {
    return window.localStorage.getItem('little-hanzi:forest:last-run');
  } catch {
    return null;
  }
}

function writeLastForestRunId(runId: string) {
  try {
    window.localStorage.setItem('little-hanzi:forest:last-run', runId);
    return true;
  } catch {
    return false;
  }
}

const previewTransport: ForestLessonTransport = {
  createRun: createForestRun,
  getRun: getForestRun,
  sendAction: sendForestAction,
  sendFeedback: sendForestFeedback,
};

const previewRecovery: ForestRecoveryStore = {
  available: forestRecoveryAvailable,
  read: (scope: ForestRecoveryScope) =>
    readForestOutbox(scope.runId, scope.lessonVersion),
  write: (scope: ForestRecoveryScope, actions: ForestPendingAction[]) =>
    writeForestOutbox(scope.runId, actions, scope.lessonVersion),
  clear: (scope: ForestRecoveryScope) => {
    clearForestOutbox(scope.runId, scope.lessonVersion);
    return true;
  },
};

export interface ForestLessonProps {
  transport?: ForestLessonTransport;
  recovery?: ForestRecoveryStore;
  mode?: 'preview' | 'pilot-child';
  initialRunId?: string | null;
  returnHref?: string;
}

export default function ForestLesson({
  transport = previewTransport,
  recovery = previewRecovery,
  mode = 'preview',
  initialRunId = null,
  returnHref,
}: ForestLessonProps = {}) {
  const isPilot = mode === 'pilot-child';
  const resolvedReturnHref =
    returnHref || (isPilot ? '/pilot' : '/preview/forest-01');
  const invalidPilotConfig =
    isPilot && (transport === previewTransport || recovery === previewRecovery);
  const [run, setRun] = useState<ForestRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [outboxCount, setOutboxCount] = useState(0);
  const [audioBusy, setAudioBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [audioStarted, setAudioStarted] = useState<Record<string, boolean>>({});
  const [audioFailure, setAudioFailure] = useState('');
  const [selectedChoice, setSelectedChoice] = useState('');
  const [heardOption, setHeardOption] = useState('');
  const [selectedComponent, setSelectedComponent] = useState('');
  const [readPanel, setReadPanel] = useState<1 | 2>(1);
  const [responseChoice, setResponseChoice] = useState('');
  const [sending, setSending] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<string | null>(null);
  const [summaryReady, setSummaryReady] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [showResume, setShowResume] = useState(false);
  const mounted = useRef(true);
  const runRef = useRef<ForestRun | null>(null);
  const pendingRef = useRef<ForestPendingAction[]>([]);
  const autoRetriedRef = useRef(new Set<string>());
  const loadGenerationRef = useRef(0);

  // The effect bridges browser URL/storage state into the client screen.
  // oxlint-disable react/react-compiler
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const loadRun = useCallback(
    async (runId: string) => {
      const generation = ++loadGenerationRef.current;
      setLoading(true);
      setError('');
      try {
        const loaded = await transport.getRun(runId);
        if (!mounted.current || generation !== loadGenerationRef.current)
          return;
        runRef.current = loaded;
        setRun(loaded);
        setSummaryReady(
          Boolean(loaded.recap.familiarity && loaded.recap.final),
        );
        setSummaryError('');
        const pending = recovery.read({
          runId: loaded.runId,
          lessonVersion: loaded.lessonVersion,
        });
        pendingRef.current = pending;
        setOutboxCount(pending.length);
        setShowResume(true);
        setSaveState(pending.length ? 'pending' : 'saved');
      } catch (loadError) {
        if (mounted.current && generation === loadGenerationRef.current)
          setError(errorText(loadError, isPilot));
      } finally {
        if (mounted.current && generation === loadGenerationRef.current)
          setLoading(false);
      }
    },
    [isPilot, recovery, transport],
  );

  // oxlint-disable-next-line react/react-compiler
  useEffect(() => {
    mounted.current = true;
    if (invalidPilotConfig) {
      return () => {
        mounted.current = false;
        stopForestSpeech();
      };
    }
    if (!recovery.available())
      setNotice(
        'Browser storage is unavailable. Server saves still work, but this browser cannot recover an unsaved action after closing.',
      );
    const params = new URLSearchParams(window.location.search);
    const queryRun = isPilot ? null : params.get('runId') || params.get('run');
    const lastRun = isPilot ? null : readLastForestRunId();
    const selectedRun = initialRunId || queryRun || lastRun;
    if (selectedRun) {
      void loadRun(selectedRun);
    } else {
      setLoading(false);
      // An installation-wide list cannot establish which run belongs to this
      // browser. Resume only an explicit link or this browser's saved run ID.
    }
    return () => {
      mounted.current = false;
      stopForestSpeech();
    };
  }, [initialRunId, invalidPilotConfig, isPilot, loadRun, recovery]);
  // oxlint-enable react/react-compiler

  const createRun = useCallback(async () => {
    setCreating(true);
    setError('');
    setNotice('');
    try {
      const created = await transport.createRun();
      if (!mounted.current) return;
      runRef.current = created;
      pendingRef.current = [];
      setOutboxCount(0);
      setAudioStarted({});
      setRun(created);
      setSummaryReady(false);
      setSummaryError('');
      setShowResume(true);
      if (!isPilot && !writeLastForestRunId(created.runId))
        setNotice(
          'Browser storage is unavailable. Keep this run’s link to resume server-saved work; unsaved actions cannot be recovered after closing.',
        );
      const nextUrl = new URL(window.location.href);
      if (!isPilot) {
        nextUrl.searchParams.delete('run');
        nextUrl.searchParams.set('runId', created.runId);
      }
      window.history.replaceState(window.history.state, '', nextUrl);
      setSaveState('saved');
      await speakForest(FOREST_AUDIO_TEXT.welcome, {
        onStart: () => setAudioBusy(true),
        onEnd: () => setAudioBusy(false),
        onError: () => {
          setAudioBusy(false);
          setAudioFailure(
            'Sound is unavailable on this device. You can continue with the written guidance.',
          );
        },
      });
      // A fresh run opens on the welcome step. Advance it after the first
      // Start click so the lesson begins with the first sound check.
      const response = await transport.sendAction(
        created.runId,
        created.revision,
        created.state.stepId,
        'continue',
        {},
        newForestId(),
      );
      const advanced = {
        ...created,
        state: response.state,
        revision: response.revision,
      };
      runRef.current = advanced;
      setRun(advanced);
    } catch (createError) {
      if (mounted.current) setError(errorText(createError, isPilot));
    } finally {
      if (mounted.current) setCreating(false);
    }
  }, [isPilot, transport]);

  const sendAction = useCallback(
    async (
      type: ForestActionType,
      payload: Record<string, unknown> = {},
      opts: { eventId?: string; pending?: ForestPendingAction } = {},
    ) => {
      const current = runRef.current;
      if (!current || sending) return null;
      const eventId = opts.eventId || newForestId();
      const queued = pendingRef.current[0];
      if (queued && queued.eventId !== eventId && !opts.pending) {
        setNotice(
          'A previous save is waiting. Retry it before starting another action.',
        );
        setSaveState('pending');
        return null;
      }
      const pending =
        opts.pending ||
        actionPayload(current, current.state.stepId, type, payload, eventId);
      if (
        pending.runId !== current.runId ||
        pending.lessonVersion !== current.lessonVersion
      ) {
        setNotice(
          'This pending action belongs to another run. Open that run to recover it.',
        );
        return null;
      }
      pendingRef.current = [
        ...pendingRef.current.filter((item) => item.eventId !== eventId),
        pending,
      ];
      setOutboxCount(pendingRef.current.length);
      const recoveryScope = {
        runId: current.runId,
        lessonVersion: current.lessonVersion,
      };
      if (!recovery.write(recoveryScope, pendingRef.current)) {
        setSaveState('offline');
        setNotice(
          'This browser cannot keep a recovery copy. Keep the page open while saving.',
        );
      } else {
        setSaveState('pending');
      }
      setSending(true);
      setError('');
      try {
        await transport.ensureSession?.();
        const response = await transport.sendAction(
          current.runId,
          pending.expectedRevision,
          pending.stepId,
          pending.type,
          pending.payload,
          pending.eventId,
        );
        if (!mounted.current || runRef.current?.runId !== current.runId)
          return response.result;
        const latest = runRef.current || current;
        // A replay acknowledgement may carry an older projection than a
        // newer action already visible in this tab. Never regress the UI.
        const shouldApply = response.revision >= latest.revision;
        const next = shouldApply ? runWithAction(latest, response) : latest;
        if (shouldApply) {
          runRef.current = next;
          setRun(next);
        }
        pendingRef.current = pendingRef.current.filter(
          (item) => item.eventId !== eventId,
        );
        setOutboxCount(pendingRef.current.length);
        if (pendingRef.current.length)
          recovery.write(
            { runId: next.runId, lessonVersion: next.lessonVersion },
            pendingRef.current,
          );
        else
          recovery.clear({
            runId: next.runId,
            lessonVersion: next.lessonVersion,
          });
        setSaveState('saved');
        setLastOutcome(response.result?.outcome || null);
        setSelectedChoice('');
        setHeardOption('');
        if (
          shouldApply &&
          (response.state.completedAt || response.state.reviewCompletedAt)
        ) {
          setSummaryReady(false);
          setSummaryError('');
          // Completion summaries are derived on the server. Re-read once so
          // the recap cannot display the pre-completion projection.
          try {
            const refreshed = await transport.getRun(next.runId);
            if (refreshed.revision >= (runRef.current?.revision || 0)) {
              runRef.current = refreshed;
              setRun(refreshed);
              setSummaryReady(
                Boolean(refreshed.recap.familiarity && refreshed.recap.final),
              );
            }
          } catch {
            // The acknowledged action is still valid, but withhold recap
            // counts until the server-derived summary can be read.
            setSummaryError(
              'Summary could not load yet. Retry to read the saved evidence.',
            );
          }
        }
        return response.result;
      } catch (actionError) {
        if (runRef.current?.runId !== current.runId) return null;
        const actionStatus =
          typeof actionError === 'object' &&
          actionError &&
          'status' in actionError
            ? Number((actionError as { status?: unknown }).status)
            : 0;
        const actionCode =
          typeof actionError === 'object' &&
          actionError &&
          'code' in actionError
            ? String((actionError as { code?: unknown }).code)
            : '';
        if (
          (actionError instanceof ForestApiError || actionStatus > 0) &&
          (actionStatus === 409 || actionCode === 'STALE_REVISION')
        ) {
          try {
            const refreshed = await transport.getRun(current.runId);
            if (mounted.current && runRef.current?.runId === current.runId) {
              runRef.current = refreshed;
              setRun(refreshed);
              setNotice(
                'Another tab saved a step first. The latest step is loaded; nothing was overwritten.',
              );
              setSaveState('saved');
            }
          } catch {
            if (mounted.current) setError(errorText(actionError, isPilot));
          }
          pendingRef.current = pendingRef.current.filter(
            (item) => item.eventId !== eventId,
          );
          setOutboxCount(pendingRef.current.length);
          if (pendingRef.current.length)
            recovery.write(
              { runId: current.runId, lessonVersion: current.lessonVersion },
              pendingRef.current,
            );
          else
            recovery.clear({
              runId: current.runId,
              lessonVersion: current.lessonVersion,
            });
        } else if (mounted.current) {
          setSaveState('error');
          setError(errorText(actionError, isPilot));
        }
        return null;
      } finally {
        if (mounted.current) setSending(false);
      }
    },
    [isPilot, recovery, sending, transport],
  );

  const retryPending = useCallback(async () => {
    const next = pendingRef.current[0];
    if (!next) return;
    await sendAction(next.type, next.payload, {
      eventId: next.eventId,
      pending: next,
    });
  }, [sendAction]);

  useEffect(() => {
    if (!run || !outboxCount || sending) return;
    const pending = pendingRef.current[0];
    if (!pending || autoRetriedRef.current.has(pending.eventId)) return;
    autoRetriedRef.current.add(pending.eventId);
    // Retry each event at most once after a reload or interrupted request;
    // explicit Retry handles an ongoing outage. The server event identity
    // makes this replay safe, and stale conflicts refresh the projection.
    const timer = window.setTimeout(() => void retryPending(), 450);
    return () => window.clearTimeout(timer);
  }, [run, outboxCount, retryPending, sending]);

  const speakCue = useCallback(
    async (
      key: string,
      text = FOREST_AUDIO_TEXT[key] || key,
      onStarted?: () => void,
      onFailed?: () => void,
    ) => {
      if (muted) {
        setAudioFailure('Sound is muted. Unmute it to start this sound check.');
        return 'unavailable' as const;
      }
      stopForestSpeech();
      setAudioFailure('');
      setAudioBusy(true);
      const result = await speakForest(text, {
        onStart: () => {
          setAudioBusy(true);
          setAudioStarted((old) => ({ ...old, [key]: true }));
          onStarted?.();
        },
        onEnd: () => setAudioBusy(false),
        onError: () => {
          setAudioBusy(false);
          setAudioStarted((old) => {
            const next = { ...old };
            delete next[key];
            return next;
          });
          onFailed?.();
          setAudioFailure(
            'Sound could not start. Try again, or continue with this check marked unavailable.',
          );
        },
      });
      setAudioBusy(false);
      if (result !== 'started')
        setAudioFailure(
          result === 'unavailable'
            ? 'No Mandarin voice is available on this device.'
            : 'Sound could not start.',
        );
      return result;
    },
    [muted],
  );

  const currentState = run?.state;
  const questionId = currentState ? stateQuestion(currentState) : null;
  const screen = currentState ? screenForState(currentState) : 'welcome';
  const progress = progressFor(screen, questionId);

  // oxlint-disable react/react-compiler
  useEffect(() => {
    stopForestSpeech();
    setSelectedChoice('');
    setHeardOption('');
    setLastOutcome(null);
    setAudioFailure('');
    if (run?.state.stepId === 'read')
      setReadPanel(run.state.readPanel === 'read-grove' ? 2 : 1);
  }, [
    run?.runId,
    run?.state.stepId,
    run?.state.questionId,
    run?.state.readPanel,
  ]);
  // oxlint-enable react/react-compiler

  const currentQuestionChoices =
    run && questionId ? rotateForestChoices(questionId, run.seed) : [];

  async function answer(choiceId: string) {
    if (!run || !questionId || sending) return;
    const result = await sendAction('answer', { questionId, choiceId });
    setSelectedChoice(choiceId);
    if (result?.outcome === 'incorrect')
      setNotice('Here is a small clue. Try the same question once more.');
    if (result?.outcome === 'demonstrated')
      setNotice('Let’s look together, then keep going.');
  }

  async function hint() {
    if (!run || !questionId || sending) return;
    await sendAction('hint', { questionId });
    setNotice('Clue added. The first answer stays in your learning record.');
  }

  async function markAudioUnavailable() {
    if (!run || !questionId || sending) return;
    await sendAction('audio-unavailable', { questionId });
    setNotice(
      'We marked this sound check unavailable. It does not count as right or wrong.',
    );
  }

  async function continueStep() {
    if (!run || sending) return;
    await sendAction('continue');
  }

  async function placeComponent(componentId: string, slot: 'left' | 'right') {
    if (!run || sending) return;
    setSelectedComponent(componentId);
    await sendAction('place-component', { componentId, slot });
    setSelectedComponent('');
  }

  async function chooseResponse(value: string) {
    setResponseChoice(value);
    if (!run || !transport.sendFeedback) return;
    try {
      await transport.sendFeedback(run.runId, {
        feedbackId: newForestId(),
        stepId: 'recap',
        category: 'other',
        text: value,
        source: 'child',
      });
      setFeedbackSent(true);
    } catch {
      setNotice('Your choice will stay on this screen until it can be saved.');
    }
  }

  function slotValue(slot: 'left' | 'right') {
    const placed = run?.state.placedComponents;
    if (Array.isArray(placed)) {
      const item = placed.find(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          (entry as { slot?: string }).slot === slot,
      );
      return item &&
        typeof item === 'object' &&
        typeof (item as { componentId?: string }).componentId === 'string'
        ? (item as { componentId: string }).componentId
        : '';
    }
    if (placed && typeof placed === 'object') {
      const value = (placed as Record<string, unknown>)[slot];
      return typeof value === 'string' ? value : '';
    }
    return '';
  }

  const usedComponents = ['mu-a', 'mu-b'].filter(
    (id) => slotValue('left') === id || slotValue('right') === id,
  );
  const stateStatus = currentState?.questionStatus;
  const questionFinished =
    stateStatus === 'answered' ||
    stateStatus === 'demonstrated' ||
    stateStatus === 'unavailable';
  const finalReadingQuestion = Boolean(questionId?.endsWith('-reading'));
  const soundQuestion = Boolean(
    questionId &&
    (questionId.startsWith('fam-') ||
      questionId.includes('-sound') ||
      questionId.startsWith('review-') ||
      finalReadingQuestion),
  );

  const statusLabel =
    saveState === 'saved'
      ? isPilot
        ? 'Saved to your child record'
        : 'Saved to this preview'
      : saveState === 'pending'
        ? `Saving${outboxCount ? ` · ${outboxCount} pending` : ''}`
        : saveState === 'offline'
          ? 'Recovery copy unavailable'
          : 'Save needs a retry';

  const retrySummary = useCallback(async () => {
    const current = runRef.current;
    if (!current) return;
    setSummaryError('');
    try {
      const refreshed = await transport.getRun(current.runId);
      if (!mounted.current || runRef.current?.runId !== current.runId) return;
      runRef.current = refreshed;
      setRun(refreshed);
      setSummaryReady(
        Boolean(refreshed.recap.familiarity && refreshed.recap.final),
      );
    } catch {
      setSummaryError(
        'Summary could not load yet. Retry to read the saved evidence.',
      );
    }
  }, [transport]);

  if (invalidPilotConfig) {
    return (
      <div className={styles.root} lang="en">
        <div className={styles.shell}>
          <div className={`${styles.surface} ${styles.emptyState}`}>
            <CircleAlert color="var(--cs-danger)" aria-hidden="true" />
            <h1>Lesson configuration unavailable</h1>
            <p className={styles.errorText}>
              This child lesson could not establish its authenticated record.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.root} lang="en">
        <div className={styles.shell}>
          <div className={`${styles.surface} ${styles.emptyState}`}>
            <div>
              <RefreshCw aria-hidden="true" />
              <h1>Opening the little forest…</h1>
              <p>
                {isPilot
                  ? 'Loading this child’s saved lesson.'
                  : 'Loading the saved preview on this device.'}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error && !run) {
    return (
      <div className={styles.root} lang="en">
        <div className={styles.shell}>
          <TopBar
            runId={undefined}
            isPilot={isPilot}
            returnHref={resolvedReturnHref}
          />
          <div className={`${styles.surface} ${styles.emptyState}`}>
            <CircleAlert color="var(--cs-danger)" aria-hidden="true" />
            <h1>{isPilot ? 'Lesson unavailable' : 'Preview unavailable'}</h1>
            <p className={styles.errorText}>{error}</p>
            <button
              className={styles.primaryButton}
              onClick={() => {
                setError('');
                void createRun();
              }}
              disabled={creating}
            >
              <RefreshCw size={18} /> Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!run || screen === 'welcome') {
    return (
      <div className={styles.root} lang="en">
        <div className={styles.shell}>
          <TopBar isPilot={isPilot} returnHref={resolvedReturnHref} />
          {error && <InlineAlert tone="error" text={error} />}
          {notice && <InlineAlert text={notice} />}
          {audioFailure && (
            <InlineAlert
              text={audioFailure}
              action={
                <button
                  className={styles.quietButton}
                  onClick={() => void speakCue('welcome')}
                >
                  <Volume2 size={15} /> Try sound again
                </button>
              }
            />
          )}
          <section
            className={styles.hero}
            aria-labelledby="forest-welcome-title"
            data-step-id="welcome"
            data-run-id={run?.runId}
          >
            <div className={styles.heroCopy}>
              <p className={styles.eyebrow}>
                Little Hanzi ·{' '}
                {isPilot
                  ? 'your guided reading lesson'
                  : 'a guided reading preview'}
              </p>
              <h1 id="forest-welcome-title">Build a little forest.</h1>
              <p className={styles.heroLead}>
                Listen, notice, and read two new characters: 木 and 林. A
                friendly guide will help when you need it.
              </p>
              <div className={styles.heroActions}>
                <button
                  className={styles.primaryButton}
                  onClick={() => (run ? void continueStep() : void createRun())}
                  disabled={creating || sending}
                >
                  <Play size={18} fill="currentColor" />{' '}
                  {creating
                    ? 'Preparing…'
                    : isPilot && run
                      ? 'Continue the lesson'
                      : 'Start the lesson'}
                </button>
                <button
                  className={styles.outlineButton}
                  onClick={() => void speakCue('welcome')}
                  disabled={audioBusy}
                >
                  <Volume2 size={18} /> {audioBusy ? 'Playing…' : 'Sound check'}
                </button>
              </div>
              <p className={styles.heroHint}>
                About 8–10 minutes · no timer · you can pause and come back.
              </p>
              {!isPilot && (
                <Link
                  className={styles.topLink}
                  href="/preview/forest-01/review"
                >
                  <MessageCircle size={16} /> Parent / reviewer entry
                </Link>
              )}
            </div>
            <div className={styles.heroIllustration}>
              <ForestIllustration />
              <span className={styles.mascot} aria-hidden="true">
                木
              </span>
            </div>
          </section>
          <div className={styles.homeGrid}>
            <section className={`${styles.surface} ${styles.lessonOverview}`}>
              <p className={styles.eyebrow}>Today’s tiny discovery</p>
              <h2>Two characters, one connection.</h2>
              <p>
                We start with the familiar shape 木, then put two trees together
                to meet 林.
              </p>
              <div className={styles.targetRow}>
                <div className={styles.targetTile}>
                  <span className={styles.targetGlyph}>木</span>
                  <small>tree / wood</small>
                </div>
                <div className={styles.targetTile}>
                  <span className={styles.targetGlyph}>林</span>
                  <small>woods / grove</small>
                </div>
              </div>
              <ul className={styles.promiseList}>
                <li>
                  <Check size={17} className={styles.promiseIcon} /> English
                  guidance with Mandarin sound
                </li>
                <li>
                  <Check size={17} className={styles.promiseIcon} /> Tap, drag,
                  or use a keyboard
                </li>
                <li>
                  <Check size={17} className={styles.promiseIcon} /> Your effort
                  is saved for a parent recap
                </li>
              </ul>
            </section>
            <section className={`${styles.surface} ${styles.resumePanel}`}>
              <h3>
                {showResume
                  ? 'A saved forest is waiting'
                  : 'Ready when you are'}
              </h3>
              <p>
                {showResume
                  ? isPilot
                    ? 'Continue this child-owned lesson from the saved step.'
                    : 'Continue the selected preview run, or start a fresh one for another pass.'
                  : 'There is no child name to enter. Just choose Start.'}
              </p>
              {showResume && (
                <button
                  className={styles.secondaryButton}
                  onClick={() => setRun(runRef.current)}
                >
                  <ArrowRight size={18} /> Continue saved run
                </button>
              )}
              <p className={styles.smallPrint}>
                {isPilot
                  ? 'Your parent or teacher can read saved evidence after you finish.'
                  : 'This is a local preview. A parent or reviewer can open the separate report.'}
              </p>
            </section>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root} lang="en">
      <div className={styles.shell}>
        <TopBar
          runId={run.runId}
          isPilot={isPilot}
          returnHref={resolvedReturnHref}
        />
        {error && (
          <InlineAlert
            tone="error"
            text={error}
            action={
              outboxCount ? (
                <button
                  className={styles.quietButton}
                  onClick={() => void retryPending()}
                >
                  <RotateCcw size={15} /> Retry save
                </button>
              ) : undefined
            }
          />
        )}
        {notice && <InlineAlert text={notice} />}
        {audioFailure && (
          <InlineAlert
            text={audioFailure}
            action={
              questionId ? (
                <button
                  className={styles.quietButton}
                  onClick={() => void speakCue(questionId)}
                >
                  <Volume2 size={15} /> Try sound again
                </button>
              ) : undefined
            }
          />
        )}
        <div className={styles.lessonShell}>
          <header className={styles.lessonHeader}>
            <div className={styles.lessonHeaderMain}>
              <p className={styles.lessonHeaderLabel}>
                {run.state.phase === 'delayed'
                  ? 'A later look'
                  : 'Build a little forest'}{' '}
                · {run.state.phase === 'delayed' ? 'review' : 'lesson'}
              </p>
              <h1 className={styles.lessonHeaderTitle}>
                {screen === 'recap'
                  ? 'Your forest recap'
                  : screen === 'review'
                    ? 'A short follow-up'
                    : screenTitle(screen)}
              </h1>
            </div>
            <div className={styles.inlineActions}>
              <span className={styles.statusBar} data-status={saveState}>
                <Save size={15} /> <span>{statusLabel}</span>
              </span>
              <button
                className={styles.quietButton}
                onClick={() => {
                  setMuted((value) => !value);
                  if (!muted) stopForestSpeech();
                }}
                aria-label={muted ? 'Unmute sound' : 'Mute sound'}
              >
                {muted ? <Volume2 size={17} /> : <Volume2 size={17} />}
                <span>{muted ? 'Unmute' : 'Mute'}</span>
              </button>
              {!isPilot && (
                <Link
                  className={styles.quietButton}
                  href="/preview/forest-01/review"
                >
                  <Home size={17} />
                  <span>Parent view</span>
                </Link>
              )}
            </div>
          </header>
          <progress
            className={styles.progressTrack}
            aria-label={`${progress}% complete`}
            value={progress}
            max={100}
          >
            {progress}%
          </progress>
          <main
            className={styles.lessonStage}
            data-run-id={run.runId}
            data-step-id={run.state.stepId}
          >
            {screen === 'familiarity' && (
              <FamiliarityScreen
                run={run}
                questionId={questionId || 'fam-mu'}
                choices={currentQuestionChoices}
                selectedChoice={selectedChoice}
                audioStarted={audioStarted}
                audioBusy={audioBusy}
                questionFinished={questionFinished}
                lastOutcome={lastOutcome}
                onPlay={() => void speakCue(questionId || 'fam-mu')}
                onAnswer={(choice) => void answer(choice)}
                onUnavailable={() => void markAudioUnavailable()}
                onContinue={() => void continueStep()}
              />
            )}
            {screen === 'learn' && (
              <LearnScreen
                run={run}
                onPlay={(key) => void speakCue(key)}
                onContinue={() => void continueStep()}
              />
            )}
            {screen === 'build' && (
              <BuildScreen
                run={run}
                selectedComponent={selectedComponent}
                usedComponents={usedComponents}
                slotValue={slotValue}
                onSelect={setSelectedComponent}
                onPlace={(component, slot) =>
                  void placeComponent(component, slot)
                }
                onContinue={() => void continueStep()}
              />
            )}
            {screen === 'find' && (
              <FindScreen
                run={run}
                questionId={questionId || 'find-mu'}
                choices={currentQuestionChoices}
                selectedChoice={selectedChoice}
                questionFinished={questionFinished}
                lastOutcome={lastOutcome}
                onAnswer={(choice) => void answer(choice)}
                onContinue={() => void continueStep()}
              />
            )}
            {screen === 'read' && (
              <ReadScreen
                run={run}
                panel={readPanel}
                onPlay={(key) => void speakCue(key)}
                onContinue={() => void continueStep()}
              />
            )}
            {screen === 'check' && (
              <CheckScreen
                run={run}
                questionId={questionId || 'check-mu-sound'}
                choices={currentQuestionChoices}
                selectedChoice={selectedChoice}
                heardOption={heardOption}
                audioStarted={audioStarted}
                audioBusy={audioBusy}
                questionFinished={questionFinished}
                finalReading={finalReadingQuestion}
                soundQuestion={soundQuestion}
                lastOutcome={lastOutcome}
                onPlay={() => void speakCue(questionId || 'check-mu-sound')}
                onPlayOption={(choice) => {
                  setHeardOption('');
                  void speakCue(
                    choice,
                    READING_AUDIO[choice] ||
                      FOREST_AUDIO_TEXT[choice] ||
                      FOREST_AUDIO_TEXT[questionId || ''] ||
                      choice,
                    () => setHeardOption(choice),
                    () => setHeardOption(''),
                  );
                }}
                onAnswer={(choice) => void answer(choice)}
                onHint={() => void hint()}
                onUnavailable={() => void markAudioUnavailable()}
                onContinue={() => void continueStep()}
              />
            )}
            {screen === 'review' && (
              <ReviewScreen
                run={run}
                questionId={
                  questionId ||
                  (run.state.reviewCompletedAt
                    ? 'review-mu-sound'
                    : 'review-mu-sound')
                }
                choices={currentQuestionChoices}
                selectedChoice={selectedChoice}
                audioStarted={audioStarted}
                audioBusy={audioBusy}
                questionFinished={questionFinished}
                lastOutcome={lastOutcome}
                onPlay={() =>
                  void speakCue(
                    questionId || 'review-mu-sound',
                    FOREST_AUDIO_TEXT[questionId || 'review-mu-sound'] ||
                      '木头的木。',
                  )
                }
                onUnavailable={() => void markAudioUnavailable()}
                onAnswer={(choice) => void answer(choice)}
                onContinue={() => void continueStep()}
                onStartReview={() => void sendAction('start-review')}
                isDue={isDue(run)}
                returnHref={resolvedReturnHref}
              />
            )}
            {screen === 'recap' && (
              <RecapScreen
                run={run}
                summaryReady={summaryReady}
                summaryError={summaryError}
                onRetrySummary={() => void retrySummary()}
                responseChoice={responseChoice}
                feedbackSent={feedbackSent}
                onResponse={(value) => void chooseResponse(value)}
                onStartReview={() => void sendAction('start-review')}
                onContinue={() => void continueStep()}
                isDue={isDue(run)}
                showResponse={!isPilot && Boolean(transport.sendFeedback)}
              />
            )}
          </main>
          <div className={styles.statusBar}>
            <span>
              <LockKeyhole size={14} />{' '}
              {isPilot
                ? 'Saved events belong to this child account'
                : 'Saved events belong to this preview run'}
            </span>
            <span>
              {run.runId.slice(0, 8)} · {FOREST_LESSON_VERSION}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function TopBar({
  runId,
  isPilot,
  returnHref,
}: {
  runId?: string;
  isPilot: boolean;
  returnHref: string;
}) {
  return (
    <nav
      className={styles.topbar}
      aria-label={isPilot ? 'Child lesson navigation' : 'Preview navigation'}
    >
      <Link
        className={styles.brand}
        href={isPilot ? returnHref : '/preview/forest-01'}
      >
        <span className={styles.brandMark}>字</span>
        <span>
          <span className={styles.brandName}>Little Hanzi</span>
          <span className={styles.brandSub}>listen · notice · read</span>
        </span>
      </Link>
      <div className={styles.topActions}>
        {runId && (
          <span className={styles.smallPrint}>
            {isPilot ? 'Saved lesson' : 'Preview run'} {runId.slice(0, 8)}
          </span>
        )}
        {!isPilot && (
          <Link className={styles.topLink} href="/preview/forest-01/review">
            <MessageCircle size={16} />
            <span>Parent / reviewer</span>
          </Link>
        )}
      </div>
    </nav>
  );
}

function InlineAlert({
  text,
  tone = 'warning',
  action,
}: {
  text: string;
  tone?: 'warning' | 'error';
  action?: React.ReactNode;
}) {
  return (
    <div className={styles.audioNotice} data-tone={tone}>
      <CircleAlert size={17} />
      <span>{text}</span>
      {action}
    </div>
  );
}

function screenTitle(screen: Screen) {
  const titles: Record<Screen, string> = {
    welcome: 'A tiny forest begins here',
    familiarity: 'What sounds familiar?',
    learn: 'Meet the two trees',
    build: 'Build 林 together',
    find: 'Find the character',
    read: 'Read together',
    check: 'A quiet check',
    recap: 'Your forest recap',
    review: 'A short follow-up',
  };
  return titles[screen];
}

function FamiliarityScreen({
  run,
  questionId,
  choices,
  selectedChoice,
  audioStarted,
  audioBusy,
  questionFinished,
  lastOutcome,
  onPlay,
  onAnswer,
  onUnavailable,
  onContinue,
}: {
  run: ForestRun;
  questionId: string;
  choices: string[];
  selectedChoice: string;
  audioStarted: Record<string, boolean>;
  audioBusy: boolean;
  questionFinished: boolean;
  lastOutcome: string | null;
  onPlay: () => void;
  onAnswer: (choice: string) => void;
  onUnavailable: () => void;
  onContinue: () => void;
}) {
  const cueStarted = Boolean(audioStarted[questionId]);
  const wrong = lastOutcome === 'incorrect';
  const help = FOREST_HELP[questionId];
  const { hinted, demonstrated } = hintPresentation(run, lastOutcome);
  const target = questionId.includes('lin') ? '林' : '木';
  return (
    <div
      className={styles.stageContent}
      data-step-id="familiarity"
      data-question-id={questionId}
      data-run-id={run.runId}
    >
      <div className={styles.stageCenter}>
        <p className={styles.eyebrow}>First, listen without a hint</p>
        <h2 className={styles.stageTitle}>Which character is in this word?</h2>
        <p className={styles.stageLead}>
          There is no score to chase. This helps us choose the right
          introduction.
        </p>
        <div className={styles.wordCue}>
          <div>
            <p className={styles.wordCueWord}>Listen to the word</p>
            <p className={styles.wordCueMeaning}>
              {questionId === 'fam-mu'
                ? 'wood / a piece of wood'
                : 'a grove / woods'}
            </p>
          </div>
          <button
            className={styles.soundButton}
            data-playing={audioBusy}
            onClick={onPlay}
            aria-label="Play Mandarin word cue"
          >
            <Volume2 size={20} />{' '}
            {audioBusy
              ? 'Playing…'
              : cueStarted
                ? 'Replay sound'
                : 'Play sound'}
          </button>
        </div>
      </div>
      <div className={styles.questionBlock}>
        <p className={styles.questionLabel}>Choose the character you heard</p>
        <div className={styles.choiceGrid}>
          {choices.map((choice) => (
            <button
              key={choice}
              className={styles.choiceButton}
              data-choice-id={choice}
              data-selected={selectedChoice === choice}
              disabled={!cueStarted || questionFinished}
              onClick={() => onAnswer(choice)}
            >
              <span className={styles.choiceGlyph}>
                {FOREST_LABELS[choice]}
              </span>
            </button>
          ))}
        </div>
        <div className={styles.questionTools}>
          <button
            className={styles.quietButton}
            onClick={onPlay}
            disabled={audioBusy}
          >
            <RotateCcw size={15} /> Replay
          </button>
          <button
            className={styles.quietButton}
            onClick={onUnavailable}
            disabled={questionFinished}
          >
            <WifiOff size={15} /> Sound unavailable
          </button>
        </div>
        {hinted && help && !demonstrated && (
          <div className={styles.forestTutor}>
            <span className={styles.tutorFace}>{target}</span>
            <div>
              <strong>A small clue</strong>
              <p>{help.hint}</p>
            </div>
          </div>
        )}
        {demonstrated && help && (
          <div className={styles.forestTutor}>
            <span className={styles.tutorFace}>{target}</span>
            <div>
              <strong>Let’s look together</strong>
              <p>{help.demonstration}</p>
              <button
                className={styles.quietButton}
                onClick={onPlay}
                disabled={audioBusy}
              >
                <Volume2 size={15} /> Hear the word again
              </button>
            </div>
          </div>
        )}
        <p
          className={styles.feedbackMessage}
          data-tone={
            wrong ? 'warning' : questionFinished ? 'success' : undefined
          }
        >
          {questionFinished
            ? 'Saved. You can continue when you are ready.'
            : cueStarted
              ? 'Pick one character.'
              : 'Start the sound before choosing.'}
        </p>
      </div>
      <div className={`${styles.stageFooter} ${styles.stageFooterEnd}`}>
        {questionFinished && (
          <button className={styles.primaryButton} onClick={onContinue}>
            <ArrowRight size={18} /> Continue
          </button>
        )}
      </div>
    </div>
  );
}

function LearnScreen({
  run,
  onPlay,
  onContinue,
}: {
  run: ForestRun;
  onPlay: (key: string) => void;
  onContinue: () => void;
}) {
  const plan =
    run.state.introPlan && typeof run.state.introPlan === 'object'
      ? (run.state.introPlan as { mode?: string; full?: unknown[] })
      : null;
  const mode =
    plan?.mode === 'full' || plan?.mode === 'mixed' ? plan.mode : 'reminder';
  const fullTargets = Array.isArray(plan?.full) ? plan.full : [];
  const targets = [
    {
      id: 'mu',
      glyph: '木',
      word: '木头',
      meaning: 'wood / a piece of wood',
      audio: 'wood',
    },
    {
      id: 'lin',
      glyph: '林',
      word: '树林',
      meaning: 'a grove / woods',
      audio: 'grove',
    },
  ];
  return (
    <div
      className={styles.stageContent}
      data-step-id="learn"
      data-run-id={run.runId}
    >
      <div className={styles.stageCenter}>
        <p className={styles.eyebrow}>
          {mode === 'reminder'
            ? 'A quick reminder'
            : mode === 'mixed'
              ? 'One familiar tree, one new look'
              : 'Let’s look a little closer'}
        </p>
        <h2 className={styles.stageTitle}>
          {mode === 'reminder'
            ? 'You noticed both shapes.'
            : 'Meet both trees in a new way.'}
        </h2>
        <p className={styles.stageLead}>
          Hear each word, see its meaning, then return to ordinary print. This
          is a guide, not a mastery claim.
        </p>
      </div>
      <div className={styles.homeGrid}>
        {targets.map((target) => {
          const expanded = fullTargets.includes(target.id);
          const memory =
            target.id === 'mu'
              ? '木 is the single tree shape in 木头.'
              : '林 puts two 木 trees together to show a grove.';
          return (
            <div
              className={`${styles.wordCue} ${styles.learnWordCue}`}
              key={target.id}
            >
              <div>
                <p className={styles.wordCueWord}>{target.word}</p>
                <p className={styles.wordCueMeaning}>{target.meaning}</p>
                <button
                  className={styles.soundButton}
                  onClick={() => onPlay(target.audio)}
                >
                  <Volume2 size={18} /> Hear the word
                </button>
                {expanded ? (
                  <>
                    <div className={styles.learningArt}>
                      <ReadingIllustration panel={target.id === 'mu' ? 1 : 2} />
                    </div>
                    <p className={styles.memoryNote}>{memory}</p>
                  </>
                ) : (
                  <p className={styles.reminderNote}>
                    Brief reminder: hear the word and notice the printed
                    character.
                  </p>
                )}
              </div>
              <span className={styles.wordCueCharacter}>{target.glyph}</span>
            </div>
          );
        })}
      </div>
      {mode !== 'reminder' && (
        <div className={styles.forestTutor}>
          <span className={styles.tutorFace}>林</span>
          <div>
            <strong>The guide is here</strong>
            <p>
              The picture helps for a moment. Next, we will look for the
              ordinary printed characters.
            </p>
          </div>
        </div>
      )}
      <div className={`${styles.stageFooter} ${styles.stageFooterEnd}`}>
        <button className={styles.primaryButton} onClick={onContinue}>
          <ArrowRight size={18} /> Continue to build
        </button>
      </div>
    </div>
  );
}

function BuildScreen({
  run,
  selectedComponent,
  usedComponents,
  slotValue,
  onSelect,
  onPlace,
  onContinue,
}: {
  run: ForestRun;
  selectedComponent: string;
  usedComponents: string[];
  slotValue: (slot: 'left' | 'right') => string;
  onSelect: (value: string) => void;
  onPlace: (component: string, slot: 'left' | 'right') => void;
  onContinue: () => void;
}) {
  const complete = Boolean(slotValue('left') && slotValue('right'));
  function drop(
    event: React.DragEvent<HTMLButtonElement>,
    slot: 'left' | 'right',
  ) {
    event.preventDefault();
    const component = event.dataTransfer.getData('text/plain');
    if (component) onPlace(component, slot);
  }
  return (
    <div
      className={styles.stageContent}
      data-step-id="build"
      data-run-id={run.runId}
    >
      <div className={styles.stageCenter}>
        <p className={styles.eyebrow}>
          Structure activity · not a reading score
        </p>
        <h2 className={styles.stageTitle}>Two 木 make 林.</h2>
        <p className={styles.stageLead}>
          Drag a piece, tap one then tap a slot, or select it with a keyboard.
        </p>
        <div className={styles.buildArea}>
          <div className={styles.buildSlots}>
            {(['left', 'right'] as const).map((slot) => {
              const value = slotValue(slot);
              return (
                <button
                  key={slot}
                  className={styles.buildSlot}
                  data-component-slot={slot}
                  data-filled={Boolean(value)}
                  onClick={() => {
                    if (selectedComponent) onPlace(selectedComponent, slot);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => drop(event, slot)}
                  aria-label={`${slot} tree slot`}
                >
                  {value ? (
                    <span className={styles.buildSlotGlyph}>木</span>
                  ) : (
                    <span>
                      {selectedComponent ? 'Tap to place' : 'Choose a 木'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className={styles.buildResult} aria-live="polite">
            {complete ? '林' : '·'}
          </div>
          <div className={styles.componentTray}>
            {['mu-a', 'mu-b'].map((component) => (
              <button
                key={component}
                className={styles.componentPiece}
                data-component-id={component}
                draggable={!usedComponents.includes(component)}
                data-used={usedComponents.includes(component)}
                aria-pressed={selectedComponent === component}
                onClick={() =>
                  onSelect(selectedComponent === component ? '' : component)
                }
                onDragStart={(event) =>
                  event.dataTransfer.setData('text/plain', component)
                }
                disabled={usedComponents.includes(component)}
              >
                木
              </button>
            ))}
          </div>
        </div>
        <p
          className={styles.feedbackMessage}
          data-tone={complete ? 'success' : undefined}
        >
          {complete
            ? '林 is ready. The assembled form is a demonstration; reading evidence comes later.'
            : 'Place both pieces side by side.'}
        </p>
        <div className={`${styles.stageFooter} ${styles.stageFooterEnd}`}>
          <button
            className={styles.primaryButton}
            onClick={onContinue}
            disabled={!complete}
          >
            <ArrowRight size={18} /> Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function FindScreen({
  run,
  questionId,
  choices,
  selectedChoice,
  questionFinished,
  lastOutcome,
  onAnswer,
  onContinue,
}: {
  run: ForestRun;
  questionId: string;
  choices: string[];
  selectedChoice: string;
  questionFinished: boolean;
  lastOutcome: string | null;
  onAnswer: (choice: string) => void;
  onContinue: () => void;
}) {
  const target = questionId.endsWith('lin') ? '林' : '木';
  const help = FOREST_HELP[questionId];
  const { hinted, demonstrated } = hintPresentation(run, lastOutcome);
  return (
    <div
      className={styles.stageContent}
      data-step-id="find"
      data-question-id={questionId}
      data-run-id={run.runId}
    >
      <div className={styles.stageCenter}>
        <p className={styles.eyebrow}>
          Scene search · turn {questionId.endsWith('lin') ? '2' : '1'} of 2
        </p>
        <h2 className={styles.stageTitle}>Find {target} in the scene.</h2>
        <p className={styles.stageLead}>
          Look among the cards, then choose the ordinary printed character. This
          scene is a playful cue.
        </p>
        <div className={styles.wordCue}>
          <span className={styles.wordCueCharacter}>{target}</span>
          <span className={styles.wordCueMeaning}>
            Find this printed character
          </span>
        </div>
      </div>
      <div className={`${styles.sceneGrid} ${styles.choiceGridWide}`}>
        {choices.map((choice, index) => (
          <button
            key={`${choice}-${index}`}
            className={styles.sceneCard}
            data-choice-id={choice}
            data-selected={selectedChoice === choice}
            data-found={questionFinished && selectedChoice === choice}
            disabled={questionFinished}
            onClick={() => onAnswer(choice)}
          >
            <span className={styles.sceneCardGlyph}>
              {FOREST_LABELS[choice]}
            </span>
            <span className={styles.sceneCardLabel}>
              forest card {index + 1}
            </span>
          </button>
        ))}
      </div>
      {hinted && help && !demonstrated && (
        <div className={styles.forestTutor}>
          <span className={styles.tutorFace}>{target}</span>
          <div>
            <strong>A small clue</strong>
            <p>{help.hint}</p>
          </div>
        </div>
      )}
      {demonstrated && help && (
        <div className={styles.forestTutor}>
          <span className={styles.tutorFace}>{target}</span>
          <div>
            <strong>Let’s look together</strong>
            <p>{help.demonstration}</p>
          </div>
        </div>
      )}
      <p
        className={styles.feedbackMessage}
        data-tone={
          lastOutcome === 'incorrect'
            ? 'warning'
            : questionFinished
              ? 'success'
              : undefined
        }
      >
        {questionFinished
          ? 'Found. The ordinary character is saved separately.'
          : `Choose ${target} from the scene cards.`}
      </p>
      <div className={`${styles.stageFooter} ${styles.stageFooterEnd}`}>
        {questionFinished && (
          <button className={styles.primaryButton} onClick={onContinue}>
            <ArrowRight size={18} /> Continue
          </button>
        )}
      </div>
    </div>
  );
}

function ReadScreen({
  run,
  panel,
  onPlay,
  onContinue,
}: {
  run: ForestRun;
  panel: 1 | 2;
  onPlay: (key: string) => void;
  onContinue: () => void;
}) {
  const first = panel === 1;
  return (
    <div
      className={styles.stageContent}
      data-step-id="read"
      data-run-id={run.runId}
    >
      <div className={styles.stageCenter}>
        <span className={styles.checkBadge}>
          <Headphones size={15} /> Read with an adult or narrator
        </span>
        <h2 className={styles.stageTitle}>
          {first
            ? 'Let’s read one line together.'
            : 'Now a little more forest.'}
        </h2>
        <p className={styles.stageLead}>
          You can listen and follow the ordinary print. We are not scoring the
          whole sentence.
        </p>
      </div>
      <div className={styles.readingPanel}>
        <div className={styles.readingArt}>
          <ReadingIllustration panel={first ? 1 : 2} />
        </div>
        <div className={styles.readingCopy}>
          <p>{first ? 'Caption 1 · wood' : 'Caption 2 · grove'}</p>
          <div className={styles.readingSentence}>
            {first ? (
              <>
                这是<mark>木</mark>头。
              </>
            ) : (
              <>
                小鸟住在树<mark>林</mark>里。
              </>
            )}
          </div>
          <p className={styles.readingNote}>
            {first
              ? 'This means: This is wood.'
              : 'This means: A little bird lives in the woods.'}
          </p>
          <button
            className={styles.soundButton}
            onClick={() => onPlay(first ? 'read-wood' : 'read-grove')}
          >
            <Volume2 size={18} /> Hear the narration
          </button>
        </div>
      </div>
      <div className={`${styles.stageFooter} ${styles.stageFooterEnd}`}>
        <button className={styles.primaryButton} onClick={onContinue}>
          <ArrowRight size={18} /> {first ? 'Next panel' : 'Continue to checks'}
        </button>
      </div>
    </div>
  );
}

function CheckScreen({
  run,
  questionId,
  choices,
  selectedChoice,
  heardOption,
  audioStarted,
  audioBusy,
  questionFinished,
  finalReading,
  soundQuestion,
  lastOutcome,
  onPlay,
  onPlayOption,
  onAnswer,
  onHint,
  onUnavailable,
  onContinue,
}: {
  run: ForestRun;
  questionId: string;
  choices: string[];
  selectedChoice: string;
  heardOption: string;
  audioStarted: Record<string, boolean>;
  audioBusy: boolean;
  questionFinished: boolean;
  finalReading: boolean;
  soundQuestion: boolean;
  lastOutcome: string | null;
  onPlay: () => void;
  onPlayOption: (choice: string) => void;
  onAnswer: (choice: string) => void;
  onHint: () => void;
  onUnavailable: () => void;
  onContinue: () => void;
}) {
  const cueStarted = Boolean(audioStarted[questionId]);
  const wrong = lastOutcome === 'incorrect';
  const title = finalReading
    ? `Which sound belongs to ${questionId.includes('lin') ? '林' : '木'}?`
    : 'Which character did you hear?';
  const help = FOREST_HELP[questionId];
  const { hinted, demonstrated } = hintPresentation(run, lastOutcome);
  const clueVisible = hinted;
  const target = questionId.includes('lin') ? '林' : '木';
  return (
    <div
      className={styles.stageContent}
      data-step-id="check"
      data-question-id={questionId}
      data-run-id={run.runId}
    >
      <div className={styles.stageCenter}>
        <p className={styles.eyebrow}>Plain print check · no picture cue</p>
        <h2 className={styles.stageTitle}>{title}</h2>
        <p className={styles.stageLead}>
          {finalReading
            ? 'Listen to each neutral option, then choose one below it.'
            : 'The sound is the task cue. Take a breath and choose the printed character.'}
        </p>
        {finalReading ? (
          <div className={styles.wordCue}>
            <div>
              <span className={styles.wordCueCharacter}>{target}</span>
              <span className={styles.wordCueMeaning}>ordinary print</span>
              {demonstrated && (
                <button
                  className={styles.soundButton}
                  onClick={onPlay}
                  disabled={audioBusy}
                >
                  <Volume2 size={18} /> Hear this character
                </button>
              )}
            </div>
          </div>
        ) : (
          <button
            className={styles.soundButton}
            data-playing={audioBusy}
            onClick={onPlay}
          >
            <Volume2 size={19} />{' '}
            {audioBusy
              ? 'Playing…'
              : cueStarted
                ? 'Replay sound'
                : 'Play question sound'}
          </button>
        )}
      </div>
      <div
        className={`${styles.choiceGrid} ${finalReading ? styles.choiceGridWide : ''}`}
      >
        {choices.map((choice, index) =>
          finalReading ? (
            <div
              key={choice}
              className={styles.choiceAudio}
              data-heard={heardOption === choice}
            >
              <button
                className={styles.soundButton}
                onClick={() => onPlayOption(choice)}
                disabled={audioBusy}
                aria-label={`Listen to option ${index + 1}`}
              >
                <Headphones size={18} /> Listen to option {index + 1}
              </button>
              <button
                className={styles.quietButton}
                data-choice-id={choice}
                data-selected={selectedChoice === choice}
                disabled={
                  !heardOption || questionFinished || heardOption !== choice
                }
                onClick={() => onAnswer(choice)}
              >
                Select option {index + 1}
              </button>
            </div>
          ) : (
            <button
              key={choice}
              className={styles.choiceButton}
              data-choice-id={choice}
              data-selected={selectedChoice === choice}
              disabled={!cueStarted || questionFinished}
              onClick={() => onAnswer(choice)}
            >
              <span className={styles.choiceGlyph}>
                {FOREST_LABELS[choice]}
              </span>
            </button>
          ),
        )}
      </div>
      {clueVisible && help && !demonstrated && (
        <div className={styles.forestTutor}>
          <span className={styles.tutorFace}>{target}</span>
          <div>
            <strong>
              {lastOutcome === 'recorded'
                ? 'Here is the reviewed clue'
                : 'Try the clue once more'}
            </strong>
            <p>{help.hint}</p>
          </div>
        </div>
      )}
      {demonstrated && help && (
        <div className={styles.forestTutor}>
          <span className={styles.tutorFace}>{target}</span>
          <div>
            <strong>Let’s look together</strong>
            <p>{help.demonstration}</p>
          </div>
        </div>
      )}
      <div className={styles.questionTools}>
        <button
          className={styles.quietButton}
          onClick={onHint}
          disabled={questionFinished}
        >
          <HelpCircle size={15} /> Give me a clue
        </button>
        {soundQuestion && (
          <button
            className={styles.quietButton}
            onClick={onUnavailable}
            disabled={questionFinished}
          >
            <WifiOff size={15} /> Sound unavailable
          </button>
        )}
      </div>
      <p
        className={styles.feedbackMessage}
        data-tone={wrong ? 'warning' : questionFinished ? 'success' : undefined}
      >
        {questionFinished
          ? 'Saved. The next question starts a fresh evidence record.'
          : finalReading
            ? heardOption
              ? 'Now choose the option you heard.'
              : 'Listen to one option before selecting it.'
            : cueStarted
              ? 'Choose a character.'
              : 'Play the question sound before choosing.'}
      </p>
      <div className={`${styles.stageFooter} ${styles.stageFooterEnd}`}>
        {questionFinished && (
          <button className={styles.primaryButton} onClick={onContinue}>
            <ArrowRight size={18} /> Continue
          </button>
        )}
      </div>
    </div>
  );
}

function ReviewScreen({
  run,
  questionId,
  choices,
  selectedChoice,
  audioStarted,
  audioBusy,
  questionFinished,
  lastOutcome,
  onPlay,
  onUnavailable,
  onAnswer,
  onContinue,
  onStartReview,
  isDue,
  returnHref,
}: {
  run: ForestRun;
  questionId: string;
  choices: string[];
  selectedChoice: string;
  audioStarted: Record<string, boolean>;
  audioBusy: boolean;
  questionFinished: boolean;
  lastOutcome: string | null;
  onPlay: () => void;
  onUnavailable: () => void;
  onAnswer: (choice: string) => void;
  onContinue: () => void;
  onStartReview: () => void;
  isDue: boolean;
  returnHref: string;
}) {
  if (run.state.phase === 'initial' && !run.state.reviewCompletedAt) {
    return (
      <div
        className={styles.stageContent}
        data-step-id="delayed-review"
        data-run-id={run.runId}
      >
        <div className={styles.stageCenter}>
          <Clock3 size={42} color="var(--cs-blue)" aria-hidden="true" />
          <p className={styles.eyebrow}>Later review</p>
          <h2 className={styles.stageTitle}>
            {isDue
              ? 'A short return visit is ready.'
              : 'Come back after a day.'}
          </h2>
          <p className={styles.stageLead}>
            {isDue
              ? 'The two sound-to-print checks will move around. Earlier evidence stays separate.'
              : `Review opens ${dateLabel(run.reviewAvailableAt)}.`}
          </p>
          {isDue ? (
            <button className={styles.primaryButton} onClick={onStartReview}>
              <ArrowRight size={18} /> Start later review
            </button>
          ) : (
            <Link className={styles.outlineButton} href={returnHref}>
              <ArrowLeft size={18} /> Return to lesson
            </Link>
          )}
        </div>
      </div>
    );
  }
  const cueStarted = Boolean(audioStarted[questionId]);
  const help = FOREST_HELP[questionId];
  const target = questionId.includes('lin') ? '林' : '木';
  const { hinted, demonstrated } = hintPresentation(run, lastOutcome);
  return (
    <div
      className={styles.stageContent}
      data-step-id="delayed-review"
      data-question-id={questionId}
      data-run-id={run.runId}
    >
      <div className={styles.stageCenter}>
        <span className={styles.checkBadge}>
          <RotateCcw size={15} /> Delayed evidence · changed positions
        </span>
        <h2 className={styles.stageTitle}>Which character did you hear?</h2>
        <p className={styles.stageLead}>
          This is a brief later recall check, not a permanent mastery label.
        </p>
        <button
          className={styles.soundButton}
          data-playing={audioBusy}
          onClick={onPlay}
        >
          <Volume2 size={19} />{' '}
          {audioBusy
            ? 'Playing…'
            : cueStarted
              ? 'Replay sound'
              : 'Play question sound'}
        </button>
      </div>
      <div className={styles.choiceGrid}>
        {choices.map((choice) => (
          <button
            key={choice}
            className={styles.choiceButton}
            data-choice-id={choice}
            data-selected={selectedChoice === choice}
            disabled={!cueStarted || questionFinished}
            onClick={() => onAnswer(choice)}
          >
            <span className={styles.choiceGlyph}>{FOREST_LABELS[choice]}</span>
          </button>
        ))}
      </div>
      {hinted && help && !demonstrated && (
        <div className={styles.forestTutor}>
          <span className={styles.tutorFace}>{target}</span>
          <div>
            <strong>A small clue</strong>
            <p>{help.hint}</p>
          </div>
        </div>
      )}
      {demonstrated && help && (
        <div className={styles.forestTutor}>
          <span className={styles.tutorFace}>{target}</span>
          <div>
            <strong>Let’s look together</strong>
            <p>{help.demonstration}</p>
          </div>
        </div>
      )}
      <div className={styles.questionTools}>
        <button
          className={styles.quietButton}
          onClick={onPlay}
          disabled={audioBusy}
        >
          <RotateCcw size={15} /> Replay
        </button>
        <button
          className={styles.quietButton}
          onClick={onUnavailable}
          disabled={questionFinished}
        >
          <WifiOff size={15} /> Sound unavailable
        </button>
      </div>
      <p
        className={styles.feedbackMessage}
        data-tone={
          lastOutcome === 'incorrect'
            ? 'warning'
            : questionFinished
              ? 'success'
              : undefined
        }
      >
        {questionFinished
          ? 'Saved as later evidence.'
          : cueStarted
            ? 'Choose one printed character.'
            : 'Play the sound before choosing.'}
      </p>
      <div className={`${styles.stageFooter} ${styles.stageFooterEnd}`}>
        {questionFinished && (
          <button className={styles.primaryButton} onClick={onContinue}>
            <ArrowRight size={18} /> Continue
          </button>
        )}
      </div>
    </div>
  );
}

function RecapScreen({
  run,
  summaryReady,
  summaryError,
  onRetrySummary,
  responseChoice,
  feedbackSent,
  onResponse,
  onStartReview,
  onContinue,
  isDue,
  showResponse,
}: {
  run: ForestRun;
  summaryReady: boolean;
  summaryError: string;
  onRetrySummary: () => void;
  responseChoice: string;
  feedbackSent: boolean;
  onResponse: (value: string) => void;
  onStartReview: () => void;
  onContinue: () => void;
  isDue: boolean;
  showResponse: boolean;
}) {
  if (!summaryReady) {
    return (
      <div
        className={styles.stageContent}
        data-step-id="recap"
        data-run-id={run.runId}
      >
        <div className={styles.recapHero}>
          <div className={styles.recapGlyph}>木林</div>
          <h2>
            {summaryError
              ? 'Your summary needs one more read.'
              : 'Loading your saved summary…'}
          </h2>
          <p>
            {summaryError
              ? 'The lesson save was acknowledged, but the server summary is not available yet. Your evidence remains saved.'
              : 'Reading the saved evidence from this preview run.'}
          </p>
        </div>
        {summaryError ? (
          <div className={styles.audioNotice} data-tone="error">
            <CircleAlert size={17} />
            <span>{summaryError}</span>
            <button className={styles.quietButton} onClick={onRetrySummary}>
              <RefreshCw size={15} /> Retry summary
            </button>
          </div>
        ) : (
          <p className={styles.smallPrint}>
            Please wait while the saved evidence loads.
          </p>
        )}
      </div>
    );
  }
  const familiarity = run.recap.familiarity!;
  const final = run.recap.final!;
  const delayed = run.recap.delayed;
  const complete = Boolean(run.state.completedAt);
  return (
    <div
      className={styles.stageContent}
      data-step-id="recap"
      data-run-id={run.runId}
    >
      <div className={styles.recapHero}>
        <div className={styles.recapGlyph}>木林</div>
        <h2>Small steps count.</h2>
        <p>
          {complete
            ? 'You listened, looked, built, and read. Here is a calm record of the work.'
            : 'Your saved work is here. Continue when you are ready.'}
        </p>
      </div>
      <div className={styles.recapGrid}>
        <Metric
          tone="blue"
          value={`${familiarity.independentCorrect}/${familiarity.total}`}
          label="familiarity first responses"
        />
        <Metric
          tone="teal"
          value={`${final.independentCorrect}`}
          label="independent final checks"
        />
        <Metric
          tone="apricot"
          value={`${familiarity.supported + final.supported}`}
          label="checks with support"
        />
      </div>
      <div className={styles.saveCallout}>
        <Save size={19} />
        <p>
          <strong>
            {complete ? 'Saved to this run.' : 'Saved progress is ready.'}
          </strong>
          First responses, optional help, and unavailable sound are kept as
          separate evidence.
        </p>
      </div>
      {showResponse && (
        <>
          <p className={styles.responsePrompt}>How did this feel? (optional)</p>
          <div className={styles.responseChoices}>
            {['fun', 'okay', 'hard'].map((value) => (
              <button
                key={value}
                className={`${styles.outlineButton} ${styles.responseChoice}`}
                data-selected={responseChoice === value}
                onClick={() => onResponse(value)}
              >
                {value === 'fun' ? 'Fun' : value === 'okay' ? 'Okay' : 'Hard'}
              </button>
            ))}
          </div>
          {feedbackSent && (
            <p className={styles.smallPrint}>
              Saved as a neutral child response. Thank you.
            </p>
          )}
        </>
      )}
      {delayed && !run.state.reviewCompletedAt && (
        <div className={styles.statusBar}>
          <Clock3 size={16} />
          <span>
            {isDue
              ? 'Your later review is ready.'
              : `Later review opens ${dateLabel(run.reviewAvailableAt)}.`}
          </span>
          {isDue && (
            <button className={styles.quietButton} onClick={onStartReview}>
              Start review <ArrowRight size={15} />
            </button>
          )}
        </div>
      )}
      <div className={`${styles.stageFooter} ${styles.stageFooterEnd}`}>
        {!complete && (
          <button className={styles.primaryButton} onClick={onContinue}>
            <ArrowRight size={18} /> Continue
          </button>
        )}
        {complete && !delayed && (
          <button className={styles.primaryButton} onClick={onContinue}>
            Return to welcome <Home size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

function Metric({
  tone,
  value,
  label,
}: {
  tone: 'blue' | 'teal' | 'apricot';
  value: string;
  label: string;
}) {
  return (
    <div className={styles.recapMetric} data-tone={tone}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
