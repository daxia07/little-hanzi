'use client';
import { useEffect, useRef, useState } from 'react';
import {
  createStorySession,
  registerPilotStoryController,
  STORY_VERSION,
  type StoryTransport,
  type StoryRecovery,
  type StorySnapshot,
  type StoryActionType,
} from '@/lib/pilot-story-client';
import { type StoryAudioSnapshot } from '@/lib/story-audio';
import { createPilotStoryAudio } from '@/lib/pilot-story-audio';
import type { PilotStoryScope } from '@/lib/pilot-story-client';
import StoryView from './StoryView';
import styles from '@/components/story/story.module.css';
const EMPTY: StorySnapshot = {
  run: null,
  pending: [],
  status: 'idle',
  notice: '',
  storageAvailable: true,
  lastOutcome: null,
  reportReady: true,
  conflictReady: false,
};
const QUIET = new Set(['familiarity', 'check', 'delayed-review']);
export default function OrdinaryStoryLesson({
  transport,
  recovery,
  scope,
  verifyIdentity,
  initialRunId,
  reviewRequested = false,
  onHome,
}: {
  transport: StoryTransport;
  recovery: StoryRecovery;
  scope: PilotStoryScope;
  verifyIdentity: () => Promise<boolean>;
  initialRunId: string | null;
  reviewRequested?: boolean;
  onHome: () => void;
}) {
  const [snapshot, setSnapshot] = useState<StorySnapshot>(EMPTY),
    [audioState, setAudioState] = useState<StoryAudioSnapshot>({
      status: 'idle',
      muted: false,
      voice: null,
      questionId: null,
      readyKeys: [],
    });
  const session = useRef<ReturnType<typeof createStorySession> | null>(null),
    audio = useRef<ReturnType<typeof createPilotStoryAudio> | null>(null),
    main = useRef<HTMLElement>(null);
  const [soundResponse, setSoundResponse] = useState<
      'heard' | 'unavailable' | null
    >(null),
    [heardSoundCheck, setHeardSoundCheck] = useState(false),
    [localMotion, setLocalMotion] = useState(false),
    [systemMotion, setSystemMotion] = useState(false),
    [buildHelpContext, setBuildHelpContext] = useState('');
  useEffect(() => {
    let alive = true;
    const controller = createStorySession({
      transport,
      recovery,
      scope,
      verifyIdentity,
      onChange: (s) => {
        if (alive) setSnapshot(s);
      },
    });
    session.current = controller;
    const speech = createPilotStoryAudio({
      profile: () => controller.snapshot().run?.lesson.playback ?? null,
      onChange: (s) => {
        if (alive) setAudioState(s);
      },
    });
    audio.current = speech;
    const unregister = registerPilotStoryController(() => {
      speech.destroy();
      controller.lock();
      for (const node of main.current?.querySelectorAll('*') ?? [])
        for (const animation of node.getAnimations()) animation.cancel();
    });
    if (initialRunId)
      void controller.open(initialRunId).then(() => {
        const saved = controller.snapshot();
        if (
          reviewRequested &&
          saved.status === 'saved' &&
          saved.run?.available &&
          saved.run.reviewDue &&
          saved.run.state.phase === 'initial'
        )
          void controller.submit('start-review');
      });
    else void controller.create();
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    queueMicrotask(() => {
      if (alive) setSystemMotion(media.matches);
    });
    const change = () => setSystemMotion(media.matches);
    media.addEventListener('change', change);
    return () => {
      alive = false;
      unregister();
      media.removeEventListener('change', change);
      speech.destroy();
      controller.destroy();
      audio.current = null;
      session.current = null;
    };
  }, [
    transport,
    recovery,
    scope,
    verifyIdentity,
    initialRunId,
    reviewRequested,
  ]);
  const run = snapshot.run,
    step = run?.state.stepId ?? 'entry',
    qid = run?.state.questionId ?? null,
    q = run?.question ?? null;
  const quiet = QUIET.has(step),
    busy =
      snapshot.status !== 'saved' ||
      snapshot.pending.length > 0 ||
      !run?.available;
  const failedSound = audioState.status === 'unavailable';
  const contextKey = `${run?.runId ?? ''}:${step}:${qid ?? ''}:${run?.state.learnPanel ?? ''}:${run?.state.readPanel ?? ''}`;
  const buildHelp = buildHelpContext === contextKey;
  useEffect(() => {
    audio.current?.cancel();
    audio.current?.setContext(qid);
    main.current?.querySelector('h1')?.focus({ preventScroll: true });
  }, [contextKey, qid]);
  async function action(
    type: StoryActionType,
    payload: Record<string, unknown> = {},
  ) {
    if (!session.current) return;
    await session.current.submit(type, payload);
  }
  function play(
    text: string,
    {
      optionId,
      required = false,
    }: { optionId?: string; required?: boolean } = {},
  ) {
    const question = required ? qid : null;
    void audio.current?.play(text, {
      gesture: true,
      questionId: question,
      optionId,
      required,
      onFailure: () => {
        if (
          question &&
          session.current?.snapshot().run?.state.questionId !== question
        )
          return;
        if (question) session.current?.failRequiredAudio(question);
      },
      onStart: () => {
        if (step === 'welcome') setHeardSoundCheck(true);
      },
    });
  }
  function proceed() {
    if (step === 'welcome' && !soundResponse) return;
    audio.current?.cancel();
    void action('continue');
  }
  function refresh() {
    audio.current?.cancel();
    void session.current?.refresh();
  }
  const canAnswer = (choice: string) =>
    !busy &&
    run?.available &&
    run.state.questionStatus === 'open' &&
    !!q &&
    (q.kind === 'scene' ||
      (['reviewed', 'synthetic'].includes(run.state.soundReview) &&
        audioState.readyKeys.includes(
          `${q.id}:${q.kind === 'print-to-audio' ? choice : 'cue'}`,
        )));
  const controls = (
    <div className={styles.soundBar}>
      <button
        data-control="replay"
        disabled={busy}
        onClick={() => void audio.current?.replay()}
      >
        Replay
      </button>
      <button
        data-control="retry-sound"
        disabled={busy}
        onClick={() =>
          q?.kind === 'sound-to-print'
            ? play(q.cueText, { required: true })
            : audio.current?.replay()
        }
      >
        Retry sound
      </button>
      <button
        data-control="mute"
        onClick={() => audio.current?.setMuted(!audioState.muted)}
      >
        {audioState.muted ? 'Unmute' : 'Mute'}
      </button>
      <output data-audio-status={audioState.status}>
        {
          {
            idle: 'Press a sound button to listen.',
            loading: 'Starting Mandarin sound…',
            playing: 'Playing Mandarin sound.',
            ended: 'Sound finished.',
            unavailable: 'Sound unavailable.',
            muted: 'Sound muted.',
          }[audioState.status]
        }
      </output>
    </div>
  );
  const navigation = (
    <button
      className={styles.primary}
      data-control="continue"
      disabled={
        busy ||
        !run ||
        (!!run.state.questionId && run.state.questionStatus === 'open')
      }
      onClick={proceed}
    >
      Continue
    </button>
  );
  function markUnavailable(questionId: string) {
    audio.current?.cancel();
    void action('audio-unavailable', { questionId });
  }
  return (
    <div
      className={styles.story}
      lang="en"
      data-story-version={STORY_VERSION}
      data-quiet={quiet}
      data-reduced-motion={localMotion || systemMotion}
    >
      <a href="#story-activity" className={styles.skip}>
        Skip to activity
      </a>
      <header className={styles.header}>
        <span className={styles.brand}>Little Hanzi</span>
        <button data-control="story-home" onClick={onHome}>
          Back to home
        </button>
      </header>
      <div className={styles.page}>
        <div className={styles.toolbar}>
          {!quiet && (
            <>
              <label className={styles.motionLabel}>
                <input
                  type="checkbox"
                  data-control="reduced-motion"
                  checked={localMotion}
                  onChange={(e) => setLocalMotion(e.target.checked)}
                />
                Reduce motion
              </label>
            </>
          )}
          {run && (
            <button
              data-control="refresh-run"
              disabled={snapshot.status === 'saving'}
              onClick={refresh}
            >
              Refresh saved story
            </button>
          )}
        </div>
        <output className={styles.saveState} data-save-state={snapshot.status}>
          {snapshot.status === 'saved'
            ? 'Saved'
            : snapshot.status === 'saving'
              ? 'Saving…'
              : snapshot.status === 'pending'
                ? 'Not saved yet'
                : snapshot.status === 'conflict'
                  ? 'Saved state changed'
                  : snapshot.status === 'readback-pending'
                    ? 'Action saved · report unavailable'
                    : snapshot.status === 'loading'
                      ? step === 'recap'
                        ? 'Loading saved report…'
                        : 'Opening saved story…'
                      : ''}
          {snapshot.pending.length > 0 &&
            ` · ${snapshot.pending.length} pending action${snapshot.pending.length > 1 ? 's' : ''}`}
        </output>
        {snapshot.notice && (
          <output className={styles.notice}>{snapshot.notice}</output>
        )}
        {!snapshot.storageAvailable && (
          <p className={styles.notice}>
            Browser recovery is unavailable. Reload may lose an unsent action.
            Keep this page open and retry.
          </p>
        )}
        {snapshot.status === 'error' && (
          <button
            className={styles.primary}
            data-control="retry-open"
            onClick={() =>
              void (initialRunId
                ? session.current?.open(initialRunId)
                : session.current?.create())
            }
          >
            Retry story
          </button>
        )}
        {snapshot.status === 'pending' && (
          <button
            className={styles.primary}
            data-control="retry-save"
            onClick={() => void session.current?.retry()}
          >
            Retry save
          </button>
        )}
        {snapshot.status === 'readback-pending' && (
          <button
            className={styles.primary}
            data-control="retry-report"
            onClick={() => void session.current?.retry()}
          >
            Retry saved report
          </button>
        )}
        {snapshot.status === 'conflict' && (
          <button
            className={styles.primary}
            data-control="accept-conflict"
            disabled={!snapshot.conflictReady}
            onClick={() => {
              audio.current?.cancel();
              session.current?.acceptConflict();
            }}
          >
            Continue from saved state
          </button>
        )}
        <section
          ref={main}
          id="story-activity"
          className={`${styles.panel} ${quiet ? styles.quiet : ''}`}
          data-step={step}
          data-run-id={run?.runId}
          tabIndex={-1}
        >
          <StoryView
            run={run}
            snapshot={snapshot}
            step={step}
            q={q}
            busy={busy}
            failedSound={failedSound}
            contextKey={contextKey}
            localMotion={localMotion}
            systemMotion={systemMotion}
            canAnswer={canAnswer}
            controls={controls}
            navigation={navigation}
            soundResponse={soundResponse}
            heardSoundCheck={heardSoundCheck}
            buildHelp={buildHelp}
            action={action}
            play={play}
            proceed={proceed}
            markUnavailable={markUnavailable}
            setSoundResponse={setSoundResponse}
            setBuildHelpContext={setBuildHelpContext}
          />
        </section>
        <footer className={styles.footer}>
          Each step saves to your account. A parent stays nearby.
        </footer>
        <div className={styles.srOnly} aria-live="polite">
          {step.replaceAll('-', ' ')}.{' '}
          {snapshot.status === 'saved'
            ? 'Saved.'
            : snapshot.status === 'pending'
              ? 'Not saved yet.'
              : ''}
        </div>
      </div>
    </div>
  );
}
