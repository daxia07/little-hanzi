'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import {
  createFamilyStoryClient,
  createScopeGuard,
  localStoryDate,
  registerPilotStoryController,
} from '@/lib/pilot-story-client';
import { createStoryAudio } from '@/lib/story-audio';
import {
  canMarkStorySoundHeard,
  canSaveStorySetup,
  createInitialStorySetup,
  STORY_SETUP_SOUND_SAMPLE,
  storySetupAudioReady,
  type StorySetupSoundResponse,
} from '@/lib/pilot/story-setup';
import type {
  PlacementProposal,
  StoryPlan,
  LibraryItem,
} from '@/lib/curriculum/story-types';
import styles from './story/family.module.css';
export default function ParentStoryPlan({
  me,
  onSignOut,
}: {
  me: PilotMe;
  onSignOut: () => void;
}) {
  const [childId, setChildId] = useState(me.children[0]?.id ?? '');
  return (
    <section className={styles.family} data-role="parent-story-plan">
      <h2>A starting story</h2>
      {me.children.length ? (
        <>
          <label>
            Choose child
            <select
              data-control="story-child"
              value={childId}
              onChange={(e) => setChildId(e.target.value)}
            >
              {me.children.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <ChildPlan
            key={`${me.installationId}:${me.user.id}:${childId}`}
            me={me}
            childId={childId}
            onSignOut={onSignOut}
          />
        </>
      ) : (
        <p>Link a child account before preparing a story.</p>
      )}
    </section>
  );
}
function ChildPlan({
  me,
  childId,
  onSignOut,
}: {
  me: PilotMe;
  childId: string;
  onSignOut: () => void;
}) {
  const api = useMemo(() => createFamilyStoryClient(me), [me]);
  const childName =
    me.children.find((child) => child.id === childId)?.name ?? 'Your child';
  const initialSetup = useMemo(
    () => createInitialStorySetup(childName, null),
    [childName],
  );
  const guard = useMemo(
    () => createScopeGuard(`${me.installationId}:${me.user.id}:${childId}`),
    [me.installationId, me.user.id, childId],
  );
  const [nickname, setNickname] = useState(initialSetup.nickname),
    [experience, setExperience] = useState<
      'new' | 'some' | 'confident' | 'unsure'
    >(initialSetup.experience),
    [soundResponse, setSoundResponse] = useState<StorySetupSoundResponse>(
      initialSetup.soundResponse,
    ),
    [soundStatus, setSoundStatus] = useState<
      'idle' | 'loading' | 'playing' | 'ended' | 'unavailable' | 'muted'
    >('idle'),
    [soundStarted, setSoundStarted] = useState(false),
    [soundError, setSoundError] = useState(''),
    [proposal, setProposal] = useState<PlacementProposal | null>(null),
    [plan, setPlan] = useState<StoryPlan | null>(null),
    [items, setItems] = useState<LibraryItem[]>([]),
    [setup, setSetup] = useState(false),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [saveState, setSaveState] = useState<
      'loading' | 'saved' | 'saving' | 'pending' | 'error'
    >('loading'),
    [pendingOperation, setPendingOperation] = useState<
      'setup' | 'propose' | 'approve' | null
    >(null),
    [editingSetup, setEditingSetup] = useState(!initialSetup.saved);
  const storyAudio = useMemo(
    () =>
      createStoryAudio({
        onChange: (snapshot) => setSoundStatus(snapshot.status),
      }),
    [],
  );
  useEffect(() => {
    storyAudio.setContext('parent-setup-sound');
    const unregister = registerPilotStoryController(() => storyAudio.destroy());
    return () => {
      unregister();
      storyAudio.destroy();
    };
  }, [storyAudio]);
  const load = useCallback(
    async function load() {
      const token = guard.begin();
      setBusy(true);
      setSaveState('loading');
      setError('');
      try {
        const [onboarding, library, placement, saved] = await Promise.all([
          api.onboarding(childId),
          api.library(childId),
          api.placement(childId),
          api.plan(childId),
        ]);
        if (!guard.current(token)) return;
        const restored = createInitialStorySetup(
          childName,
          onboarding.onboarding,
        );
        setNickname(restored.nickname);
        setExperience(restored.experience);
        setSoundResponse(restored.soundResponse);
        setSoundStarted(false);
        setSoundError('');
        setEditingSetup(!restored.saved);
        setItems(library.items);
        setSetup(restored.saved && placement.setupComplete);
        setProposal(placement.proposal);
        setPlan(saved.plan);
        setSaveState('saved');
        setPendingOperation(null);
      } catch (e) {
        if (guard.current(token)) {
          setSaveState('error');
          setProposal(null);
          setPlan(null);
          setItems([]);
          setSetup(false);
          setError(e instanceof Error ? e.message : 'The plan could not load.');
        }
      } finally {
        if (guard.current(token)) setBusy(false);
      }
    },
    [api, childId, childName, guard],
  );
  useEffect(() => {
    guard.activate();
    const token = guard.capture();
    queueMicrotask(() => {
      if (guard.current(token)) void load();
    });
    return () => guard.destroy();
  }, [guard, load]);
  async function mutate(kind: 'setup' | 'propose' | 'approve') {
    if (kind === 'setup' && !canSaveStorySetup({ soundResponse })) {
      setError('Choose “Heard it” or “Sound unavailable” before saving.');
      setSaveState('pending');
      setPendingOperation('setup');
      return;
    }
    const token = guard.begin();
    setBusy(true);
    setSaveState('saving');
    setPendingOperation(kind);
    setError('');
    setNotice('');
    try {
      if (kind === 'setup') {
        await api.saveSetup(childId, {
          nickname: nickname.trim(),
          experience,
          audioReady: storySetupAudioReady(soundResponse) === true,
        });
        if (!guard.current(token)) return;
        setSetup(true);
        setEditingSetup(false);
        setProposal(null);
        setNotice(
          soundResponse === 'heard'
            ? 'Setup saved. Request a fresh starting suggestion.'
            : 'Setup saved. Sound is unavailable for now; request a starting suggestion when ready.',
        );
      } else if (kind === 'propose') {
        const result = await api.propose(childId);
        if (!guard.current(token)) return;
        setProposal(result.proposal);
        setNotice(
          'This is a starting suggestion. You choose whether to approve it.',
        );
      } else if (proposal) {
        const result = await api.approve(childId, proposal);
        if (!guard.current(token)) return;
        setPlan(result.plan);
        setNotice(
          'Starting plan approved. Your child signs in to control the story.',
        );
      }
      if (guard.current(token)) {
        setSaveState('saved');
        setPendingOperation(null);
      }
    } catch (e) {
      if (guard.current(token)) {
        if ([401, 403, 404].includes((e as { status?: number }).status ?? 0)) {
          setProposal(null);
          setPlan(null);
          setItems([]);
          setSetup(false);
        }
        setSaveState('pending');
        setError(
          e instanceof Error
            ? e.message
            : 'The change could not be saved. Your choices are still here; retry when ready.',
        );
      }
    } finally {
      if (guard.current(token)) setBusy(false);
    }
  }
  const experienceLabel = {
    new: 'New to these characters',
    some: 'Some experience',
    confident: 'Confident',
    unsure: 'Not sure yet',
  }[experience];
  return (
    <div aria-busy={busy} data-child-id={childId}>
      <output data-plan-save-state={saveState} className={styles.notice}>
        {saveState === 'saving'
          ? 'Saving…'
          : saveState === 'pending'
            ? 'Save not confirmed. Retry or refresh the saved plan.'
            : saveState === 'error'
              ? 'Saved setup could not load. Retry refresh.'
              : saveState === 'loading'
                ? 'Loading saved setup…'
                : setup
                  ? 'Saved setup loaded.'
                  : 'Choose the details and sound response, then save setup.'}
      </output>
      {pendingOperation && saveState === 'pending' && (
        <button
          data-control="retry-plan"
          disabled={busy}
          onClick={() => void mutate(pendingOperation)}
        >
          Retry plan save
        </button>
      )}
      <p>
        This is a starting suggestion, based on saved setup and learning. It
        does not establish mastery.
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && <output className={styles.notice}>{notice}</output>}
      {setup && !editingSetup && (
        <div className={styles.record} data-role="story-setup-summary">
          <h3>Saved setup for {nickname}</h3>
          <p>
            Experience: {experienceLabel}. Sound response:{' '}
            {soundResponse === 'heard' ? 'Heard it' : 'Sound unavailable'}.
          </p>
          <button
            type="button"
            data-control="edit-setup"
            onClick={() => setEditingSetup(true)}
          >
            Edit setup
          </button>
        </div>
      )}
      {(!setup || editingSetup) && (
        <form
          className={styles.fields}
          onSubmit={(e) => {
            e.preventDefault();
            void mutate('setup');
          }}
        >
          <label>
            Child nickname
            <input
              data-control="story-nickname"
              value={nickname}
              maxLength={40}
              required
              onChange={(e) => setNickname(e.target.value)}
            />
          </label>
          <label>
            Experience
            <select
              data-control="story-experience"
              value={experience}
              onChange={(e) =>
                setExperience(e.target.value as typeof experience)
              }
            >
              <option value="new">New to these characters</option>
              <option value="some">Some experience</option>
              <option value="confident">Confident</option>
              <option value="unsure">Not sure yet</option>
            </select>
          </label>
          <fieldset className={styles.soundCheck}>
            <legend>Try a short Mandarin sound</legend>
            <p>
              Play the sample together, then choose the response that matches
              what happened on this device.
            </p>
            <button
              type="button"
              data-control="sound-check"
              onClick={() => {
                setSoundStarted(false);
                setSoundError('');
                storyAudio.play(STORY_SETUP_SOUND_SAMPLE, {
                  gesture: true,
                  onStart: () => setSoundStarted(true),
                  onFailure: () => {
                    setSoundStarted(false);
                    setSoundError(
                      'The local Mandarin sound could not play. Choose “Sound unavailable” or try again.',
                    );
                  },
                });
              }}
            >
              {soundStatus === 'loading'
                ? 'Loading sound…'
                : soundStatus === 'playing'
                  ? 'Playing…'
                  : 'Try the sound'}
            </button>
            <p className={styles.smallPrint} aria-live="polite">
              {soundStatus === 'playing'
                ? 'Sound is playing.'
                : soundStatus === 'ended'
                  ? 'Sound finished. Choose a response below.'
                  : soundStatus === 'unavailable'
                    ? 'Sound is unavailable right now.'
                    : 'No response saved yet.'}
            </p>
            {soundError && (
              <p className={styles.error} role="alert">
                {soundError}
              </p>
            )}
            <fieldset className={styles.responseGroup}>
              <legend>Sound response</legend>
              <div className={styles.actions}>
                <button
                  type="button"
                  data-control="sound-heard"
                  aria-pressed={soundResponse === 'heard'}
                  disabled={
                    !canMarkStorySoundHeard({ sampleStarted: soundStarted })
                  }
                  onClick={() => {
                    setSoundError('');
                    setSoundResponse('heard');
                  }}
                >
                  Heard it
                </button>
                <button
                  type="button"
                  data-control="unavailable"
                  aria-pressed={soundResponse === 'unavailable'}
                  onClick={() => {
                    storyAudio.cancel();
                    setSoundStarted(false);
                    setSoundError('');
                    setSoundResponse('unavailable');
                  }}
                >
                  Sound unavailable
                </button>
              </div>
            </fieldset>
          </fieldset>
          <button
            className={styles.primary}
            data-control="save-setup"
            disabled={busy || !canSaveStorySetup({ soundResponse })}
          >
            Save setup
          </button>
        </form>
      )}
      <div className={styles.actions}>
        <button
          data-control="request-proposal"
          disabled={busy || !setup || !items.some((i) => i.available)}
          onClick={() => void mutate('propose')}
        >
          Show starting suggestion
        </button>
        <button
          data-control="refresh-story-plan"
          disabled={busy}
          onClick={() => void load()}
        >
          Refresh plan
        </button>
      </div>
      {!busy && !items.some((i) => i.available) && (
        <p data-unavailable>
          No reviewed story is currently available for this child. Setup can
          still be saved.
        </p>
      )}
      {proposal && (
        <div className={styles.record} data-proposal-id={proposal.proposalId}>
          <h3>This is a starting suggestion</h3>
          <p>{proposal.reason}</p>
          <p>Available until {localStoryDate(proposal.expiresAt)}.</p>
          <button
            className={styles.primary}
            data-control="approve-plan"
            disabled={busy}
            onClick={() => void mutate('approve')}
          >
            Approve starting plan
          </button>
        </div>
      )}
      {plan && (
        <div className={styles.record} data-plan-id={plan.planId}>
          <h3>
            {plan.available
              ? 'Starting plan approved'
              : 'Previous plan unavailable'}
          </h3>
          <p>
            {plan.reason ??
              'Your child controls the learning from their own account.'}
          </p>
          {plan.available && (
            <button data-control="handover-signout" onClick={onSignOut}>
              Sign out and let{' '}
              {me.children.find((c) => c.id === childId)?.name ?? 'your child'}{' '}
              sign in
            </button>
          )}
        </div>
      )}
    </div>
  );
}
