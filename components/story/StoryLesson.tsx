'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  createStorySession,
  STORY_VERSION,
  type StoryTransport,
  type StoryRecovery,
  type StorySnapshot,
  type StoryActionType,
} from '@/lib/story-client';
import { createStoryAudio, type StoryAudioSnapshot } from '@/lib/story-audio';
import { STORY_COPY as copy, storyQuestion } from '@/lib/story-presentation';
import StoryView from './StoryView';
import styles from './story.module.css';
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
export default function StoryLesson({
  transport,
  recovery,
}: {
  transport: StoryTransport;
  recovery: StoryRecovery;
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
    audio = useRef<ReturnType<typeof createStoryAudio> | null>(null),
    main = useRef<HTMLElement>(null);
  const [lastRun, setLastRun] = useState<string | null>(null),
    [savedRuns, setSavedRuns] = useState<
      Array<{ runId: string; stepId: string }>
    >([]);
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
      onChange: (s) => {
        if (alive) setSnapshot(s);
      },
    });
    session.current = controller;
    const speech = createStoryAudio({
      onChange: (s) => {
        if (alive) setAudioState(s);
      },
    });
    audio.current = speech;
    queueMicrotask(() => {
      if (alive) setLastRun(recovery.lastRun());
    });
    void transport
      .listRuns?.()
      .then((runs) => {
        if (alive)
          setSavedRuns(
            runs
              .filter((r) => r.lessonVersion === STORY_VERSION)
              .map((r) => ({ runId: r.runId, stepId: r.stepId })),
          );
      })
      .catch(() => {});
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    queueMicrotask(() => {
      if (alive) setSystemMotion(media.matches);
    });
    const change = () => setSystemMotion(media.matches);
    media.addEventListener('change', change);
    return () => {
      alive = false;
      media.removeEventListener('change', change);
      speech.destroy();
      controller.destroy();
      audio.current = null;
      session.current = null;
    };
  }, [transport, recovery]);
  const run = snapshot.run,
    step = run?.state.stepId ?? 'entry',
    qid = run?.state.questionId ?? null,
    q = qid ? storyQuestion(qid) : null;
  const quiet = QUIET.has(step),
    busy = snapshot.status !== 'saved' || snapshot.pending.length > 0;
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
    audio.current?.play(text, {
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
    run?.state.questionStatus === 'open' &&
    !!q &&
    (q.kind === 'scene' ||
      (run.state.soundReview === 'synthetic' &&
        audioState.readyKeys.includes(
          `${q.id}:${q.kind === 'print-to-audio' ? choice : 'cue'}`,
        )));
  const controls = (
    <div className={styles.soundBar}>
      <button
        data-control="replay"
        disabled={busy}
        onClick={() => audio.current?.replay()}
      >
        Replay
      </button>
      <button
        data-control="retry-sound"
        disabled={busy}
        onClick={() =>
          q?.kind === 'sound-to-print'
            ? play(q.cue, { required: true })
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
  function startNewStory() {
    setSoundResponse(null);
    setHeardSoundCheck(false);
    void session.current?.create();
  }
  function openStory(runId: string) {
    void session.current?.open(runId);
  }
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
        <span>{copy.preview}</span>
      </header>
      <div className={styles.page}>
        <div className={styles.toolbar}>
          {!quiet && (
            <>
              <Link
                href="/preview/shade-01/review"
                prefetch={false}
                data-control="review-page"
              >
                Lesson review and sources
              </Link>
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
            ? 'Saved to this preview'
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
        {run?.state.soundReview === 'synthetic' && (
          <p className={styles.notice}>{copy.synthetic}</p>
        )}
        <main
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
            lastRun={lastRun}
            savedRuns={savedRuns}
            soundResponse={soundResponse}
            heardSoundCheck={heardSoundCheck}
            buildHelp={buildHelp}
            action={action}
            play={play}
            proceed={proceed}
            startNewStory={startNewStory}
            openStory={openStory}
            markUnavailable={markUnavailable}
            setSoundResponse={setSoundResponse}
            setBuildHelpContext={setBuildHelpContext}
          />
        </main>
        <footer className={styles.footer}>
          Supervised preview · no lesson release or owner acceptance is claimed.
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
