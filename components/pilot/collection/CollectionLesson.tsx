'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createCollectionSession,
  createCollectionRecovery,
  createCollectionTransport,
  type CollectionScope,
  type CollectionSnapshot,
} from '@/lib/pilot-collection-client';
import { getPilotMe, hasPendingSignOut } from '@/lib/pilot-client';
import { registerPilotStoryController } from '@/lib/pilot-story-client';
import { createCollectionAudio } from '@/lib/pilot-collection-audio';
import StoryCompanion from '../story/StoryCompanion';
import type { StoryAudioSnapshot } from '@/lib/story-audio';
import type { CollectionGroup } from '@/lib/curriculum/collection-types';
import styles from './collection.module.css';
const EMPTY: CollectionSnapshot = {
  run: null,
  pending: [],
  status: 'idle',
  notice: '',
  reportReady: false,
  conflictReady: false,
  storageAvailable: true,
};
const AUDIO: StoryAudioSnapshot = {
  status: 'idle',
  muted: false,
  voice: null,
  questionId: null,
  readyKeys: [],
};
export function CollectionCounts({
  name,
  group,
}: {
  name: string;
  group: CollectionGroup;
}) {
  return (
    <section className={styles.surface} data-evidence-group={name}>
      <h3>
        {name === 'familiarity'
          ? 'First look'
          : name === 'practice'
            ? 'Word practice'
            : 'Plain-print checks'}
      </h3>
      <div className={styles.counts}>
        {(['independent', 'supported', 'unavailable', 'pending'] as const).map(
          (k) => (
            <span key={k} data-category={k}>
              {group[k]} {k === 'pending' ? 'not completed' : k}
            </span>
          ),
        )}
      </div>
      <p>
        {group.firstResponses} first responses · {group.helpCount} times help
        was requested
      </p>
    </section>
  );
}
export default function CollectionLesson({
  scope,
  runId,
  onHome,
}: {
  scope: CollectionScope;
  runId: string | null;
  onHome: () => void;
}) {
  const [snapshot, setSnapshot] = useState(EMPTY),
    [audioState, setAudioState] = useState(AUDIO),
    [reduced, setReduced] = useState(false);
  const session = useRef<ReturnType<typeof createCollectionSession> | null>(
      null,
    ),
    audio = useRef<ReturnType<typeof createCollectionAudio> | null>(null);
  const initial = useMemo(() => ({ scope, runId }), [scope, runId]);
  useEffect(() => {
    let alive = true;
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {}
    const verify = async () => {
      if (hasPendingSignOut()) return false;
      const me = await getPilotMe();
      return (
        !hasPendingSignOut() &&
        me.installationId === initial.scope.installationId &&
        me.user.id === initial.scope.accountId &&
        me.user.role === 'child' &&
        !me.user.mustChangePassword
      );
    };
    const recovery = createCollectionRecovery(initial.scope, storage),
      transport = createCollectionTransport(initial.scope, {
        verify,
        startId: recovery.startId,
      });
    const controller = createCollectionSession({
      scope: initial.scope,
      transport,
      recovery,
      verify,
      onChange: (s) => {
        if (alive) setSnapshot(s);
      },
    });
    session.current = controller;
    const speech = createCollectionAudio({
      profile: () => controller.snapshot().run?.lesson.playback ?? null,
      onChange: (s) => {
        if (alive) setAudioState(s);
      },
    });
    audio.current = speech;
    const unregister = registerPilotStoryController(() => {
      controller.lock();
      speech.destroy();
    });
    void controller.load(initial.runId);
    return () => {
      alive = false;
      unregister();
      controller.destroy();
      speech.destroy();
      session.current = null;
      audio.current = null;
    };
  }, [initial]);
  const run = snapshot.run,
    q = run?.question,
    context =
      q?.occurrenceId ??
      (run
        ? `${run.state.phase}:${run.state.stepId}:${run.state.panelIndex}`
        : null);
  useEffect(() => {
    audio.current?.setContext(context);
  }, [context]);
  const saved =
    snapshot.status === 'saved' &&
    snapshot.reportReady &&
    !snapshot.pending.length &&
    run?.available;
  const canLeave =
    saved ||
    (['unavailable', 'error', 'locked'].includes(snapshot.status) &&
      !snapshot.pending.length);
  const ready = !!q && audioState.readyKeys.includes(`${q.occurrenceId}:cue`);
  const quiet = !!run && ['familiarity', 'check'].includes(run.state.stepId);
  function listen(cueId: string, required = false) {
    const occurrence =
      session.current?.snapshot().run?.question?.occurrenceId ?? null;
    void audio.current?.play(cueId, {
      gesture: true,
      questionId: context,
      required,
      onFailure: () => {
        if (required && occurrence) session.current?.failAudio(occurrence);
      },
    });
  }
  const next = () => {
    audio.current?.cancel();
    void session.current?.submit('continue');
  };
  return (
    <main
      className={styles.collection}
      data-role="collection-run"
      data-run-id={run?.runId}
      data-phase={run?.state.phase}
      data-step={run?.state.stepId}
      data-save-state={snapshot.status}
      data-audio-status={audioState.status}
      aria-busy={snapshot.status === 'loading' || snapshot.status === 'saving'}
    >
      <div className={styles.row}>
        <button
          data-control="collection-home"
          disabled={!canLeave}
          onClick={() => {
            audio.current?.destroy();
            onHome();
          }}
        >
          Learning home
        </button>
        <label>
          <input
            type="checkbox"
            data-control="collection-reduced-motion"
            checked={reduced}
            onChange={(e) => setReduced(e.target.checked)}
          />
          Less motion
        </label>
      </div>
      <output className={styles.status} aria-live="polite">
        {snapshot.status === 'saved'
          ? 'Saved'
          : snapshot.status === 'readback-pending'
            ? 'Saved; refreshing'
            : snapshot.status === 'saving'
              ? 'Saving…'
              : snapshot.status === 'pending'
                ? 'Save unconfirmed'
                : snapshot.status === 'conflict'
                  ? 'Saved step changed'
                  : snapshot.status === 'loading'
                    ? 'Loading your lesson…'
                    : snapshot.status === 'locked'
                      ? 'Sign in again'
                      : snapshot.status === 'unavailable'
                        ? 'Lesson unavailable'
                        : 'Lesson could not load'}
      </output>
      {snapshot.notice && <output>{snapshot.notice}</output>}
      {!snapshot.storageAvailable && (
        <p className={styles.error}>
          Browser recovery is unavailable. Keep this page open and retry.
        </p>
      )}
      {snapshot.status === 'pending' ||
      snapshot.status === 'readback-pending' ? (
        <button
          data-control="collection-retry"
          onClick={() => void session.current?.retry()}
        >
          {snapshot.status === 'pending' ? 'Retry save' : 'Retry refresh'}
        </button>
      ) : null}
      {snapshot.status === 'error' && (
        <button
          data-control="collection-retry"
          onClick={() => void session.current?.load(initial.runId)}
        >
          Retry lesson
        </button>
      )}
      {snapshot.status === 'conflict' && (
        <div className={styles.row}>
          <button
            data-control="collection-refresh-conflict"
            onClick={() => void session.current?.refreshConflict()}
          >
            Refresh saved step
          </button>
          <button
            data-control="collection-accept-saved"
            disabled={!snapshot.conflictReady}
            onClick={() => session.current?.acceptConflict()}
          >
            Continue from saved state
          </button>
        </div>
      )}
      {run && (
        <>
          <p className={styles.muted}>
            {run.state.phase === 'initial'
              ? 'Your lesson'
              : run.state.phase === 'review-24h'
                ? 'First later review'
                : 'Seven-day review'}
          </p>
          <h2>{run.lesson.title}</h2>
          <div className={styles.layout}>
            <div>
              {run.welcomePanel && (
                <section className={styles.plane}>
                  <h3>{run.welcomePanel.title}</h3>
                  <p>{run.welcomePanel.instructionEnglish}</p>
                  <button
                    className={styles.primary}
                    data-control="collection-next"
                    disabled={!saved}
                    onClick={next}
                  >
                    Begin
                  </button>
                </section>
              )}
              {q && (
                <section
                  className={styles.quiet}
                  data-occurrence-id={q.occurrenceId}
                  data-check-id={q.checkId}
                  data-character-id={q.characterId}
                >
                  <h3>{q.instructionEnglish}</h3>
                  <p>{q.promptEnglish}</p>
                  <button
                    data-control="collection-listen"
                    disabled={!saved}
                    onClick={() =>
                      listen(run.lesson.playback.cues[0].cueId, true)
                    }
                  >
                    Listen
                  </button>
                  <div className={styles.choices}>
                    {q.choices.map((c) => (
                      <button
                        key={c.choiceId}
                        data-control="collection-answer"
                        data-choice-id={c.choiceId}
                        disabled={
                          !saved ||
                          q.status !== 'open' ||
                          !ready ||
                          run.soundReview === 'pending'
                        }
                        onClick={() =>
                          void session.current?.submit('answer', {
                            choiceId: c.choiceId,
                          })
                        }
                      >
                        <span className={styles.hanzi}>{c.hanzi}</span>
                      </button>
                    ))}
                  </div>
                  {q.hintEnglish && <p>{q.hintEnglish}</p>}
                  {q.demonstrationEnglish && <p>{q.demonstrationEnglish}</p>}
                  <div className={styles.row}>
                    <button
                      data-control="collection-help"
                      disabled={!saved || q.status !== 'open'}
                      onClick={() => void session.current?.submit('help')}
                    >
                      Help
                    </button>
                    {q.status === 'open' && (
                      <button
                        data-control="collection-without-sound"
                        disabled={!saved}
                        onClick={() => {
                          audio.current?.cancel();
                          void session.current?.submit('audio-unavailable');
                        }}
                      >
                        Continue without sound
                      </button>
                    )}
                    {q.status !== 'open' && (
                      <button
                        className={styles.primary}
                        data-control="collection-next"
                        disabled={!saved || !run.canContinue}
                        onClick={next}
                      >
                        Continue
                      </button>
                    )}
                  </div>
                  {q.status === 'open' &&
                    (!ready || run.soundReview === 'pending') && (
                      <p className={styles.muted}>
                        Listen when sound is available, or continue without
                        sound.
                      </p>
                    )}
                  {q.status === 'unavailable' && (
                    <p>
                      Sound was unavailable. This question is saved that way.
                    </p>
                  )}
                </section>
              )}
              {run.teachingPanel && (
                <section className={styles.surface}>
                  <h3>
                    {run.teachingPanel.mode === 'reminder'
                      ? 'A quick reminder'
                      : 'Explore this character'}
                  </h3>
                  <p className={styles.hanzi}>{run.teachingPanel.hanzi}</p>
                  <p>{run.teachingPanel.instructionEnglish}</p>
                  <p>
                    {run.teachingPanel.readings
                      .map((r) => r.pinyin)
                      .join(' · ')}{' '}
                    · {run.teachingPanel.meanings.join('; ')}
                  </p>
                  <button
                    data-control="collection-listen"
                    disabled={!saved}
                    onClick={() =>
                      listen(
                        run.lesson.playback.cues.find(
                          (c) => c.readingId !== null,
                        )!.cueId,
                      )
                    }
                  >
                    Listen to the character
                  </button>
                  {run.teachingPanel.words.map((w, i) => (
                    <section key={w.wordId} className={styles.surface}>
                      <h3>{w.text}</h3>
                      <p>
                        {w.pinyin} · {w.english}
                      </p>
                      {run.teachingPanel?.mode === 'full' && (
                        <>
                          <p>{w.context.hanzi}</p>
                          <p>{w.context.english}</p>
                        </>
                      )}
                      <button
                        data-control="collection-listen"
                        disabled={!saved}
                        onClick={() =>
                          listen(
                            run.lesson.playback.cues.filter(
                              (c) => c.checkId !== null,
                            )[i].cueId,
                          )
                        }
                      >
                        Listen to the word
                      </button>
                    </section>
                  ))}
                  <p>
                    {run.teachingPanel.mode === 'full'
                      ? run.teachingPanel.hintEnglish
                      : 'You chose this target independently in your first look.'}
                  </p>
                  <button
                    className={styles.primary}
                    data-control="collection-next"
                    disabled={!saved}
                    onClick={next}
                  >
                    Continue
                  </button>
                </section>
              )}
              {run.readerPanel && (
                <section className={styles.surface}>
                  <h3>{run.readerPanel.title}</h3>
                  <p>{run.readerPanel.instructionEnglish}</p>
                  <p className={styles.reader}>{run.readerPanel.text}</p>
                  <p>{run.readerPanel.english}</p>
                  <button
                    data-control="collection-listen"
                    disabled={!saved}
                    onClick={() => listen(run.lesson.playback.cues[0].cueId)}
                  >
                    Listen to the sentence
                  </button>
                  <button
                    className={styles.primary}
                    data-control="collection-next"
                    disabled={!saved}
                    onClick={next}
                  >
                    Continue
                  </button>
                </section>
              )}
              {run.state.stepId === 'recap' && snapshot.reportReady && (
                <section data-saved-recap>
                  <h3>Your practice is saved</h3>
                  <p>{run.lesson.instructionsEnglish.completion}</p>
                  {run.state.phase === 'initial' && (
                    <>
                      <CollectionCounts
                        name="familiarity"
                        group={run.recap.familiarity}
                      />
                      <CollectionCounts
                        name="practice"
                        group={run.recap.practice}
                      />
                    </>
                  )}
                  <CollectionCounts name="check" group={run.recap.check} />
                  {run.recap.evidenceLimits.map((t) => (
                    <p className={styles.muted} key={t}>
                      {t}
                    </p>
                  ))}
                  <button
                    className={styles.primary}
                    data-control="collection-home"
                    disabled={!saved}
                    onClick={onHome}
                  >
                    Learning home
                  </button>
                </section>
              )}
            </div>
            {!quiet && (
              <aside className={styles.guide}>
                <StoryCompanion
                  reducedMotion={reduced}
                  performance={
                    run.state.stepId === 'recap'
                      ? 'encourage'
                      : run.state.stepId === 'welcome'
                        ? 'welcome'
                        : 'focused'
                  }
                />
              </aside>
            )}
          </div>
        </>
      )}
    </main>
  );
}
