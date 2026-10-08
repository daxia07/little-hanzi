'use client';
import type { ReactNode } from 'react';
import type {
  StoryRun,
  StoryGroup,
  StorySnapshot,
  StoryActionType,
} from '@/lib/story-client';
import {
  STORY_COPY as copy,
  STORY_LABELS,
  STORY_WORDS,
  STORY_READERS,
  storyQuestion,
  storyChoices,
  optionSpeech,
} from '@/lib/story-presentation';
import StoryCompanion from './StoryCompanion';
import StoryScene from './StoryScene';
import styles from './story.module.css';
interface StoryViewProps {
  run: StoryRun | null;
  snapshot: StorySnapshot;
  step: string;
  q: ReturnType<typeof storyQuestion> | null;
  busy: boolean;
  failedSound: boolean;
  contextKey: string;
  localMotion: boolean;
  systemMotion: boolean;
  canAnswer: (choice: string) => boolean;
  controls: ReactNode;
  navigation: ReactNode;
  lastRun: string | null;
  savedRuns: Array<{ runId: string; stepId: string }>;
  soundResponse: 'heard' | 'unavailable' | null;
  heardSoundCheck: boolean;
  buildHelp: boolean;
  action: (
    type: StoryActionType,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
  play: (
    text: string,
    options?: { optionId?: string; required?: boolean },
  ) => void;
  proceed: () => void;
  startNewStory: () => void;
  openStory: (runId: string) => void;
  markUnavailable: (questionId: string) => void;
  setSoundResponse: (value: 'heard' | 'unavailable' | null) => void;
  setBuildHelpContext: (value: string) => void;
}
const plain = (value: unknown) => (typeof value === 'string' ? value : '');
function Heading({
  overline,
  title,
  children,
}: {
  overline: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      <p className={styles.overline}>{overline}</p>
      <h1 tabIndex={-1}>{title}</h1>
      {children && <p>{children}</p>}
    </>
  );
}
function Group({ name, group }: { name: string; group?: StoryGroup }) {
  if (!group) return null;
  return (
    <section className={styles.evidence} data-evidence-group={name}>
      <h2>
        {name === 'final'
          ? 'Four final checks'
          : name === 'familiarity'
            ? 'First look'
            : 'Later review'}
      </h2>
      <div className={styles.counts}>
        {[
          ['independentCorrect', 'independent'],
          ['supported', 'supported'],
          ['unavailable', 'unavailable'],
          ['pending', 'not completed'],
        ].map(([key, label]) => (
          <div key={key}>
            <strong data-category={key}>
              {group[key as keyof StoryGroup]}
            </strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
function Recap({
  run,
  onStartReview,
  busy,
}: {
  run: StoryRun;
  onStartReview: () => void;
  busy: boolean;
}) {
  return (
    <>
      <Heading overline="Parent recap · saved preview" title={copy.title}>
        {copy.finish}
      </Heading>
      <p>{copy.recap}</p>
      <p data-activity-summary>
        Build: {run.recap.buildCompleted ? 'completed' : 'not completed'} ·
        Find: {run.recap.sceneCompleted ? 'completed' : 'not completed'} ·
        Reader: two supported panels visited.
      </p>
      <div className={styles.recapGrid}>
        <Group name="final" group={run.recap.final} />
        <Group name="familiarity" group={run.recap.familiarity} />
        <Group name="delayed" group={run.recap.delayed} />
      </div>
      <details className={styles.details}>
        <summary>First responses and support</summary>
        {run.events
          .filter(
            (e) =>
              e.type === 'answer' ||
              e.type === 'hint' ||
              e.type === 'audio-unavailable',
          )
          .map((e) => (
            <p
              key={e.eventId}
              data-event-id={e.eventId}
              data-record-id={e.questionId ?? undefined}
            >
              {e.questionId}:{' '}
              {e.type === 'answer'
                ? `Response ${STORY_LABELS[plain(e.payload.choiceId).replace('audio-', '')] ?? plain(e.payload.choiceId)}`
                : e.type === 'hint'
                  ? 'Requested help'
                  : 'Sound unavailable'}{' '}
              · {e.outcome} ·{' '}
              {e.firstResponse ? 'first response' : 'later action'} ·{' '}
              {e.assisted ? 'supported' : 'no extra help'}
            </p>
          ))}
      </details>
      <section className={styles.support}>
        <h2>A useful next step</h2>
        <p>{copy.review}</p>
        <p>
          Review due: {run.reviewDue ? 'yes' : 'not yet'}
          {run.reviewAvailableAt ? ` · ${run.reviewAvailableAt}` : ''}.{' '}
          {run.state.reviewCompletedAt ? 'Later review is complete.' : ''}
        </p>
        {run.reviewDue && !run.state.reviewCompletedAt && (
          <button
            className={styles.primary}
            data-control="start-review"
            disabled={busy}
            onClick={onStartReview}
          >
            Start later review
          </button>
        )}
      </section>
    </>
  );
}
export default function StoryView({
  run,
  snapshot,
  step,
  q,
  busy,
  failedSound,
  contextKey,
  localMotion,
  systemMotion,
  canAnswer,
  controls,
  navigation,
  lastRun,
  savedRuns,
  soundResponse,
  heardSoundCheck,
  buildHelp,
  action,
  play,
  proceed,
  startNewStory,
  openStory,
  markUnavailable,
  setSoundResponse,
  setBuildHelpContext,
}: StoryViewProps) {
  function questionView() {
    if (!run || !q)
      return (
        <p>
          The current question could not be displayed. Refresh the saved story.
        </p>
      );
    const done = run.state.questionStatus !== 'open',
      reading = q.kind === 'print-to-audio',
      scene = q.kind === 'scene';
    return (
      <div className={styles.question} data-question-id={q.id}>
        <Heading
          overline={
            step === 'familiarity'
              ? 'First look'
              : step === 'delayed-review'
                ? 'Later practice'
                : 'Story activity'
          }
          title={
            scene
              ? 'Find a tree for our story'
              : step === 'familiarity'
                ? 'What do you recognise?'
                : 'A quiet check'
          }
        >
          {reading ? copy.quietReading : scene ? copy.find : copy.quietSound}
        </Heading>
        {reading ? (
          <span className={styles.hanzi} lang="zh-Hans">
            {STORY_LABELS[q.target]}
          </span>
        ) : (
          <button
            className={styles.primary}
            data-control="cue"
            disabled={busy}
            onClick={() => play(q.cue, { required: !scene })}
          >
            {scene ? 'Hear the character' : 'Listen to word cue'}
          </button>
        )}
        {scene && (
          <>
            <p>
              Find <span lang="zh-Hans">{STORY_LABELS[q.target]}</span> for our
              reading spot.
            </p>
            <StoryScene />
          </>
        )}
        {!done &&
          (reading ? (
            <div className={styles.audioOptions}>
              {storyChoices(q.id, run.seed).map((choice, index) => (
                <div key={choice} className={styles.audioOption}>
                  <button
                    data-control="option-play"
                    data-option-id={choice}
                    disabled={busy}
                    onClick={() =>
                      play(optionSpeech(choice), {
                        optionId: choice,
                        required: true,
                      })
                    }
                  >
                    Listen to option {index + 1}
                  </button>
                  <button
                    data-choice-id={choice}
                    disabled={!canAnswer(choice)}
                    onClick={() =>
                      void action('answer', {
                        questionId: q.id,
                        choiceId: choice,
                      })
                    }
                  >
                    Choose option {index + 1}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div
              className={`${styles.choices} ${scene ? styles.sceneChoices : ''}`}
            >
              {storyChoices(q.id, run.seed).map((choice) => (
                <button
                  key={choice}
                  className={styles.choice}
                  lang="zh-Hans"
                  data-choice-id={choice}
                  disabled={!canAnswer(choice)}
                  onClick={() =>
                    void action('answer', {
                      questionId: q.id,
                      choiceId: choice,
                    })
                  }
                >
                  {scene && (
                    <svg viewBox="0 0 120 36" aria-hidden="true">
                      <path d="M0 32Q30 15 60 30T120 28V36H0Z" fill="#dceee9" />
                      <path
                        d="M20 30V12M101 30V9"
                        stroke="#805010"
                        strokeWidth="3"
                      />
                      <circle cx="20" cy="10" r="8" fill="#117c72" />
                      <circle cx="101" cy="8" r="7" fill="#245bd6" />
                    </svg>
                  )}
                  {STORY_LABELS[choice]}
                </button>
              ))}
            </div>
          ))}
        {!!run.state.hintLevel && (
          <section
            className={styles.support}
            data-help-level={run.state.hintLevel}
          >
            <h2>{run.state.hintLevel >= 2 ? copy.demonstration : copy.clue}</h2>
            <p>{run.state.hintLevel >= 2 ? q.demonstration : q.hint}</p>
            {reading && run.state.hintLevel >= 2 && (
              <button
                data-control="demonstration"
                disabled={busy}
                onClick={() => play(STORY_LABELS[q.target])}
              >
                Listen to demonstration
              </button>
            )}
          </section>
        )}
        {done && (
          <>
            <output className={styles.result}>
              {run.state.questionStatus === 'unavailable'
                ? copy.unavailable
                : run.state.questionStatus === 'demonstrated'
                  ? copy.demonstrated
                  : run.state.assisted
                    ? copy.supported
                    : copy.independent}
            </output>
            {scene && run.state.questionStatus !== 'unavailable' && (
              <>
                <span className={styles.hanzi} lang="zh-Hans">
                  {STORY_LABELS[q.target]}
                </span>
                <p>Back to ordinary print.</p>
                <StoryCompanion
                  key={contextKey}
                  performance="aha"
                  reducedMotion={localMotion || systemMotion}
                />
              </>
            )}
          </>
        )}
        {!scene && run.state.soundReview === 'pending' && !done && (
          <p className={styles.notice}>{copy.soundPending}</p>
        )}
        {failedSound && !done && (
          <p className={styles.notice} role="alert">
            Sound did not play. Retry, or continue without sound. Your first
            responses will be preserved.
          </p>
        )}
        <div className={styles.actions}>
          {done ? (
            navigation
          ) : (
            <>
              <button
                data-control="help"
                disabled={busy}
                onClick={() => void action('hint', { questionId: q.id })}
              >
                Help
              </button>
              {!scene && (
                <button
                  data-control="unavailable"
                  disabled={busy}
                  onClick={() => markUnavailable(q.id)}
                >
                  Continue without sound
                </button>
              )}
            </>
          )}
        </div>
        {controls}
      </div>
    );
  }
  function content() {
    if (!run)
      return (
        <>
          <Heading
            overline="Little Hanzi · supervised preview"
            title={copy.title}
          >
            A complete story with saved steps, kept separate from the earlier
            forest preview.
          </Heading>
          <p>Lesson and sound review are pending. A parent stays nearby.</p>
          <div className={styles.actions}>
            <button
              className={styles.primary}
              data-control="create-run"
              disabled={snapshot.status === 'loading'}
              onClick={startNewStory}
            >
              Start a new story
            </button>
            {lastRun && (
              <button
                data-control="resume-run"
                disabled={snapshot.status === 'loading'}
                onClick={() => openStory(lastRun)}
              >
                Resume saved story
              </button>
            )}
          </div>
          {savedRuns.length > 0 && (
            <details className={styles.details}>
              <summary>Saved stories for this version</summary>
              {savedRuns.map((r) => (
                <button
                  key={r.runId}
                  data-control="open-run"
                  data-run-id={r.runId}
                  onClick={() => openStory(r.runId)}
                >
                  Open saved story · {r.stepId}
                </button>
              ))}
            </details>
          )}
        </>
      );
    if (q) return questionView();
    switch (step) {
      case 'welcome':
        return (
          <div className={styles.composition}>
            <div>
              <Heading overline="A small story · 木 and 林" title={copy.title}>
                {copy.intro}
              </Heading>
              <StoryScene book />
              <section className={styles.soundCheck}>
                <h2>Can you hear the Mandarin sound?</h2>
                <p>{copy.soundCheck}</p>
                <button data-control="sound-check" onClick={() => play('你好')}>
                  Play sound check
                </button>
                <div className={styles.actions}>
                  <button
                    data-control="sound-heard"
                    aria-pressed={soundResponse === 'heard'}
                    disabled={!heardSoundCheck}
                    onClick={() => setSoundResponse('heard')}
                  >
                    I heard it
                  </button>
                  <button
                    data-control="sound-unavailable"
                    aria-pressed={soundResponse === 'unavailable'}
                    onClick={() => setSoundResponse('unavailable')}
                  >
                    Sound isn’t working
                  </button>
                </div>
              </section>
              <div className={styles.actions}>
                <button
                  className={styles.primary}
                  data-control="continue"
                  disabled={busy || !soundResponse}
                  onClick={proceed}
                >
                  Start the story
                </button>
              </div>
              {controls}
            </div>
            <StoryCompanion
              key={contextKey}
              performance="welcome"
              reducedMotion={localMotion || systemMotion}
            />
          </div>
        );
      case 'learn': {
        const targets: ('mu' | 'lin')[] =
          run.state.learnPanel === 'reminder'
            ? ['mu', 'lin']
            : [run.state.learnPanel === 'learn-lin' ? 'lin' : 'mu'];
        const reminder = run.state.learnPanel === 'reminder';
        return (
          <div
            className={styles.composition}
            data-learn-panel={run.state.learnPanel ?? undefined}
          >
            <div>
              <Heading
                overline="Story learning"
                title={
                  reminder
                    ? 'A quick reminder'
                    : targets[0] === 'mu'
                      ? 'Meet the tree character'
                      : 'Two trees make a little wood'
                }
              >
                {reminder ? copy.reminder : copy.firstLook}
              </Heading>
              <div className={styles.targetPair}>
                {targets.map((target) => {
                  const familiar =
                    reminder || run.state.introPlan?.reminder.includes(target);
                  return (
                    <section
                      className={styles.targetCard}
                      key={target}
                      data-target={target}
                      data-learning-mode={
                        familiar ? 'reminder' : 'introduction'
                      }
                    >
                      <span className={styles.hanzi} lang="zh-Hans">
                        {STORY_LABELS[target]}
                      </span>
                      <p>
                        {STORY_WORDS[target].word} ·{' '}
                        {STORY_WORDS[target].meaning}
                      </p>
                      <p>
                        {familiar
                          ? copy.targetReminder
                          : target === 'mu'
                            ? copy.wood
                            : copy.grove}
                      </p>
                      <button
                        data-control="word"
                        data-word={target}
                        disabled={busy}
                        onClick={() => play(STORY_WORDS[target].word)}
                      >
                        Hear {target === 'mu' ? 'wood' : 'grove'} word
                      </button>
                    </section>
                  );
                })}
              </div>
              {!reminder && <StoryScene />}
              <div className={styles.actions}>{navigation}</div>
              {controls}
            </div>
            <StoryCompanion
              key={contextKey}
              performance="focused"
              reducedMotion={localMotion || systemMotion}
            />
          </div>
        );
      }
      case 'build':
        return (
          <div className={styles.composition}>
            <div>
              <Heading
                overline="Story activity · build"
                title="A place with two trees"
              >
                {copy.build}
              </Heading>
              <div className={styles.slots}>
                {(['left', 'right'] as const).map((slot) => (
                  <section
                    key={slot}
                    className={styles.slot}
                    data-build-slot={slot}
                  >
                    <strong>{slot === 'left' ? 'Left' : 'Right'} place</strong>
                    <span className={styles.hanzi} lang="zh-Hans">
                      {run.state.placedComponents[slot] ? '木' : '□'}
                    </span>
                    <span>{run.state.placedComponents[slot] ?? 'Empty'}</span>
                  </section>
                ))}
              </div>
              <div className={styles.pieceControls}>
                {(['mu-a', 'mu-b'] as const).flatMap((piece, index) =>
                  (['left', 'right'] as const).map((slot) => (
                    <button
                      key={`${piece}-${slot}`}
                      data-piece-id={piece}
                      data-slot={slot}
                      disabled={busy}
                      onClick={() =>
                        void action('place-component', {
                          componentId: piece,
                          slot,
                        })
                      }
                    >
                      Put tree {index + 1} {slot}
                    </button>
                  )),
                )}
              </div>
              <button
                data-control="build-help"
                onClick={() => setBuildHelpContext(contextKey)}
              >
                Help with build
              </button>
              {buildHelp && <p className={styles.support}>{copy.buildHelp}</p>}
              {run.state.placedComponents.left &&
                run.state.placedComponents.right && (
                  <p className={styles.result}>
                    <span className={styles.hanzi} lang="zh-Hans">
                      林
                    </span>
                    Two distinct pieces are in place. Now look at the ordinary
                    character.
                  </p>
                )}
              <div className={styles.actions}>
                <button
                  className={styles.primary}
                  data-control="continue"
                  disabled={
                    busy ||
                    !run.state.placedComponents.left ||
                    !run.state.placedComponents.right ||
                    run.state.placedComponents.left ===
                      run.state.placedComponents.right
                  }
                  onClick={proceed}
                >
                  Find the trees
                </button>
              </div>
              {controls}
            </div>
            <StoryCompanion
              key={contextKey}
              performance={
                buildHelp
                  ? 'encourage'
                  : run.state.placedComponents.left &&
                      run.state.placedComponents.right
                    ? 'aha'
                    : 'focused'
              }
              reducedMotion={localMotion || systemMotion}
            />
          </div>
        );
      case 'read': {
        const panel = run.state.readPanel ?? 'read-wood',
          reader = STORY_READERS[panel];
        return (
          <div className={styles.composition}>
            <div>
              <Heading
                overline="Supported reading"
                title="Read with some support"
              >
                {copy.reader}
              </Heading>
              <StoryScene book />
              <div className={styles.reader} lang="zh-Hans">
                {reader.text.split(reader.target).map((part, index) => (
                  <span key={index}>
                    {index > 0 && <mark>{reader.target}</mark>}
                    {part}
                  </span>
                ))}
              </div>
              <p>This means: {reader.meaning}</p>
              <p className={styles.muted}>{copy.sentenceDraft}</p>
              <button
                data-control="sentence"
                disabled={busy}
                onClick={() => play(reader.text)}
              >
                Hear the sentence
              </button>
              <div className={styles.actions}>{navigation}</div>
              {controls}
            </div>
            <StoryCompanion
              key={contextKey}
              performance="encourage"
              reducedMotion={localMotion || systemMotion}
            />
          </div>
        );
      }
      case 'recap':
        if (!snapshot.reportReady)
          return (
            <>
              <Heading overline="Parent recap" title="Loading the saved report">
                Your learning actions are saved. The latest report must load
                before evidence is shown.
              </Heading>
              <p>
                Use Retry saved report if loading fails. Your answer will not be
                submitted again.
              </p>
            </>
          );
        return (
          <>
            <Recap
              run={run}
              busy={busy}
              onStartReview={() => void action('start-review')}
            />
            <StoryCompanion
              key={contextKey}
              performance="delighted"
              reducedMotion={localMotion || systemMotion}
            />
          </>
        );
      default:
        return (
          <p>
            This saved step is not available in this story version. Refresh the
            saved story.
          </p>
        );
    }
  }
  return content();
}
