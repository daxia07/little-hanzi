'use client';
import type { ReactNode } from 'react';
import type {
  StoryRun,
  StoryGroup,
  StorySnapshot,
  StoryActionType,
} from '@/lib/pilot-story-client';
import { STORY_COPY as copy, STORY_LABELS } from '@/lib/story-presentation';
import type { SafeQuestion } from '@/lib/curriculum/story-types';
import { localStoryDate } from '@/lib/pilot-story-client';
import StoryCompanion from './StoryCompanion';
import StoryScene from '@/components/story/StoryScene';
import styles from '@/components/story/story.module.css';
interface StoryViewProps {
  run: StoryRun | null;
  snapshot: StorySnapshot;
  step: string;
  q: SafeQuestion | null;
  busy: boolean;
  failedSound: boolean;
  contextKey: string;
  localMotion: boolean;
  systemMotion: boolean;
  canAnswer: (choice: string) => boolean;
  controls: ReactNode;
  navigation: ReactNode;
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
  markUnavailable: (questionId: string) => void;
  setSoundResponse: (value: 'heard' | 'unavailable' | null) => void;
  setBuildHelpContext: (value: string) => void;
}
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
        {name === 'immediate'
          ? 'Four final checks'
          : name === 'familiarity'
            ? 'First look'
            : 'Later review'}
      </h2>
      <div className={styles.counts}>
        {[
          ['independent', 'independent'],
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
      <Heading overline="Saved learning" title={run.lesson.title}>
        {copy.finish}
      </Heading>
      <p>{copy.recap}</p>
      <div className={styles.recapGrid}>
        <Group name="immediate" group={run.recap.immediate} />
        <Group name="familiarity" group={run.recap.familiarity} />
        <Group name="delayed" group={run.recap.delayed} />
      </div>
      <p>
        Story activities completed: {run.recap.game.completed} of{' '}
        {run.recap.game.total}.
      </p>
      <details className={styles.details}>
        <summary>First responses and support</summary>
        {run.events.map((e) => (
          <p
            key={e.eventId}
            data-event-id={e.eventId}
            data-record-id={e.questionId ?? undefined}
          >
            {e.questionId ?? 'Story step'} ·{' '}
            {e.type === 'hint'
              ? 'Requested help'
              : e.type === 'audio-unavailable'
                ? 'Sound unavailable'
                : e.outcome}{' '}
            · {e.firstResponse ? 'first response' : 'later action'} ·{' '}
            {e.assisted ? 'supported' : 'no extra help'}
          </p>
        ))}
      </details>
      {run.recap.evidenceLimits.map((limit) => (
        <p key={limit}>{limit}</p>
      ))}
      <section className={styles.support}>
        <h2>A useful next step</h2>
        <p>{copy.review}</p>
        <p>
          Later review:{' '}
          {run.state.reviewCompletedAt
            ? 'Saved'
            : run.reviewDue
              ? 'Ready'
              : localStoryDate(run.reviewAvailableAt)}
          .
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
  soundResponse,
  heardSoundCheck,
  buildHelp,
  action,
  play,
  proceed,
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
            {STORY_LABELS[q.characterId]}
          </span>
        ) : (
          <button
            className={styles.primary}
            data-control="cue"
            disabled={busy}
            onClick={() => play(q.cueText, { required: !scene })}
          >
            {scene ? 'Hear the character' : 'Listen to word cue'}
          </button>
        )}
        {scene && (
          <>
            <p>
              Find <span lang="zh-Hans">{STORY_LABELS[q.characterId]}</span> for
              our reading spot.
            </p>
            <StoryScene />
          </>
        )}
        {!done &&
          (reading ? (
            <div className={styles.audioOptions}>
              {q.choices
                .map((choice) => choice.id)
                .map((choice, index) => (
                  <div key={choice} className={styles.audioOption}>
                    <button
                      data-control="option-play"
                      data-option-id={choice}
                      disabled={busy}
                      onClick={() =>
                        play(
                          q.choices.find((c) => c.id === choice)?.audioText ??
                            '',
                          {
                            optionId: choice,
                            required: true,
                          },
                        )
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
              {q.choices
                .map((choice) => choice.id)
                .map((choice) => (
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
                        <path
                          d="M0 32Q30 15 60 30T120 28V36H0Z"
                          fill="#dceee9"
                        />
                        <path
                          d="M20 30V12M101 30V9"
                          stroke="#805010"
                          strokeWidth="3"
                        />
                        <circle cx="20" cy="10" r="8" fill="#117c72" />
                        <circle cx="101" cy="8" r="7" fill="#245bd6" />
                      </svg>
                    )}
                    {q.choices.find((c) => c.id === choice)?.label ?? ''}
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
                onClick={() => play(STORY_LABELS[q.characterId])}
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
                  {STORY_LABELS[q.characterId]}
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
          <p className={styles.notice}>
            Sound is unavailable for this check. Continue without sound.
          </p>
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
          <Heading overline="Your story" title="Opening your saved story">
            Each step saves to your account.
          </Heading>
          <p>If loading stops, return home and retry your approved story.</p>
        </>
      );
    if (!run.available)
      return (
        <>
          <Heading overline="Saved learning" title="This story is unavailable">
            {run.reason ?? 'Ask your parent to check the starting plan.'}
          </Heading>
          <p>Your saved learning remains in your record.</p>
        </>
      );
    if (!snapshot.reportReady)
      return (
        <Heading overline="Saved learning" title="Loading the saved step">
          Your action is saved. Retry the saved report if it cannot load.
        </Heading>
      );
    if (q) return questionView();
    switch (step) {
      case 'welcome':
        return (
          <div className={styles.composition}>
            <div>
              <Heading overline="A small story" title={run.lesson.title}>
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
                        {
                          run.lesson.characters.find((c) => c.id === target)
                            ?.word
                        }{' '}
                        ·{' '}
                        {
                          run.lesson.examples.find(
                            (e) =>
                              e.text ===
                              run.lesson.characters.find((c) => c.id === target)
                                ?.word,
                          )?.meaning
                        }
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
                        onClick={() =>
                          play(
                            run.lesson.characters.find((c) => c.id === target)
                              ?.word ?? '',
                          )
                        }
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
          caption = run.lesson.captions.find((c) => c.id === panel);
        if (!caption)
          return (
            <p>The saved reading panel could not load. Refresh the story.</p>
          );
        const reader = {
          text: caption.text,
          target: STORY_LABELS[caption.highlight],
          meaning: caption.narration,
        };
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
              <p className={styles.muted}>
                A parent or narrator helps read the whole sentence.
              </p>
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
