'use client';

import {
  ArrowRight,
  Check,
  Download,
  LockKeyhole,
  Play,
  RefreshCw,
  ShieldCheck,
  Volume2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createPilotForestTransport,
  createPilotRecoveryStore,
  getPilotAssignments,
  getPilotLearningExport,
  getPilotOnboarding,
  getPilotProgress,
  PilotLearningApiError,
  savePilotOnboarding,
  assignPilotLesson,
  type PilotAssignments,
  type PilotEvidenceLimits,
  type PilotOnboarding,
  type PilotOnboardingExperience,
  type PilotProgress,
} from '@/lib/pilot-learning-client';
import { FOREST_LESSON_VERSION } from '@/lib/forest-client';
import type { PilotChild, PilotMe } from '@/lib/pilot-client';
import ForestLesson from '@/components/forest/ForestLesson';
import styles from './pilot.module.css';

function learningMessage(error: unknown): string {
  if (error instanceof PilotLearningApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'The learning record could not be loaded. Please retry.';
}

function childFor(me: PilotMe): PilotChild | null {
  if (me.user.role === 'child') {
    return (
      me.children.find((child) => child.id === me.user.id) || {
        id: me.user.id,
        name: me.user.name,
      }
    );
  }
  return me.children[0] || null;
}

function dateLabel(value: string | undefined | null): string {
  if (!value) return 'Not started';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
      new Date(value),
    );
  } catch {
    return value;
  }
}

function stateLabel(progress: PilotProgress, runId: string | null): string {
  if (!runId) return 'Ready to start';
  const run = progress.runs.find((item) => item.runId === runId);
  if (!run) return 'Saved run';
  if (run.state.reviewCompletedAt) return 'Review saved';
  if (run.state.completedAt) return 'Initial lesson complete';
  return 'In progress';
}

function EvidenceLimits({ limits }: { limits: PilotEvidenceLimits }) {
  const entries = [
    ['Completion', limits.completion],
    ['Help', limits.assistance],
    ['Audio', limits.audio],
    ['Later review', limits.review],
  ].filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === 'string' && Boolean(entry[1]),
  );
  if (!entries.length) return null;
  return (
    <div className={styles.infoBand} data-evidence-limits="true">
      <ShieldCheck size={18} aria-hidden="true" />
      <div>
        <strong>How to read this record</strong>
        <ul className={styles.limitList}>
          {entries.map(([label, text]) => (
            <li key={label}>
              <span>{label}:</span> {text}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function RunList({
  progress,
  readOnly = false,
}: {
  progress: PilotProgress;
  readOnly?: boolean;
}) {
  if (!progress.runs.length) {
    return (
      <div className={styles.empty}>
        <div>
          <p>No saved lesson evidence yet.</p>
          <p className={styles.smallPrint}>
            {readOnly
              ? 'A child’s first saved step will appear here after the assignment begins.'
              : 'The child can start the assigned lesson when it is ready.'}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.runList} data-run-list="true">
      {progress.runs.map((run) => (
        <div className={styles.runRow} key={run.runId} data-run-id={run.runId}>
          <div>
            <strong>
              {run.lessonId === 'forest-01'
                ? 'Build a Little Forest'
                : run.lessonId}
            </strong>
            <span>
              {stateLabel(progress, run.runId)} · updated{' '}
              {dateLabel(
                typeof run.updatedAt === 'string'
                  ? run.updatedAt
                  : typeof run.createdAt === 'string'
                    ? run.createdAt
                    : '',
              )}
            </span>
          </div>
          <span
            className={styles.status}
            data-state={run.state.completedAt ? 'active' : 'pending'}
          >
            {run.state.completedAt ? 'Saved' : 'In progress'}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ParentLearningPanel({ me }: { me: PilotMe }) {
  const [selectedChildId, setSelectedChildId] = useState(
    me.children[0]?.id || '',
  );
  const [onboarding, setOnboarding] = useState<PilotOnboarding | null>(null);
  const [assignments, setAssignments] = useState<PilotAssignments | null>(null);
  const [progress, setProgress] = useState<PilotProgress | null>(null);
  const [nickname, setNickname] = useState('');
  const [experience, setExperience] =
    useState<PilotOnboardingExperience>('new');
  const [audioReady, setAudioReady] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestRef = useRef(0);

  const load = useCallback(async (childId: string) => {
    if (!childId) {
      setOnboarding(null);
      setAssignments(null);
      setProgress(null);
      return;
    }
    const requestId = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const [nextOnboarding, nextAssignments, nextProgress] = await Promise.all(
        [
          getPilotOnboarding(childId),
          getPilotAssignments(childId),
          getPilotProgress(childId),
        ],
      );
      if (requestId !== requestRef.current) return;
      setOnboarding(nextOnboarding);
      setAssignments(nextAssignments);
      setProgress(nextProgress);
      setNickname(nextOnboarding?.nickname || '');
      setExperience(nextOnboarding?.experience || 'new');
      setAudioReady(nextOnboarding?.audioReady ?? true);
    } catch (loadError) {
      if (requestId === requestRef.current)
        setError(learningMessage(loadError));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  // oxlint-disable react/react-compiler
  useEffect(() => {
    if (!me.children.some((child) => child.id === selectedChildId))
      setSelectedChildId(me.children[0]?.id || '');
  }, [me.children, selectedChildId]);
  // oxlint-enable react/react-compiler

  // oxlint-disable react/react-compiler
  useEffect(() => {
    void load(selectedChildId);
  }, [load, selectedChildId]);
  // oxlint-enable react/react-compiler

  const selectedChild =
    me.children.find((child) => child.id === selectedChildId) || null;
  const forestLesson = assignments?.availableLessons.find(
    (lesson) => lesson.lessonVersion === FOREST_LESSON_VERSION,
  );
  const assignment = assignments?.assignments.find(
    (item) => item.lessonVersion === FOREST_LESSON_VERSION,
  );

  async function savePlan(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!selectedChild) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const saved = await savePilotOnboarding(selectedChild.id, {
        nickname: nickname.trim(),
        experience,
        audioReady,
      });
      setOnboarding(saved);
      setNickname(saved.nickname);
      setNotice('Child plan saved.');
    } catch (saveError) {
      setError(learningMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function assignLesson() {
    if (!selectedChild || !forestLesson?.canAssign) return;
    setAssigning(true);
    setError('');
    setNotice('');
    try {
      const saved = await assignPilotLesson(selectedChild.id);
      setAssignments((old) =>
        old
          ? {
              ...old,
              assignments: [
                saved,
                ...old.assignments.filter(
                  (item) => item.lessonVersion !== saved.lessonVersion,
                ),
              ],
            }
          : old,
      );
      setNotice('The forest lesson is assigned to this child.');
    } catch (assignError) {
      setError(learningMessage(assignError));
    } finally {
      setAssigning(false);
    }
  }

  async function exportRecord() {
    if (!selectedChild) return;
    setExporting(true);
    setError('');
    try {
      const value = await getPilotLearningExport(selectedChild.id);
      const blob = new Blob([JSON.stringify(value, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `pilot-learning-${selectedChild.id}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice('A copy of this child’s learning record is ready.');
    } catch (exportError) {
      setError(learningMessage(exportError));
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className={styles.learningArea} data-role="parent-learning">
      <div className={styles.sectionHead}>
        <div>
          <h2>Child learning plan</h2>
          <p className={styles.smallPrint}>
            Onboarding, assignment and saved evidence stay with the selected
            child.
          </p>
        </div>
        <LockKeyhole size={22} color="var(--cs-blue)" aria-hidden="true" />
      </div>
      {!me.children.length ? (
        <div className={styles.empty}>
          <p>Link a child account before opening a learning plan.</p>
        </div>
      ) : (
        <>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Child</span>
            <select
              className={styles.select}
              value={selectedChildId}
              onChange={(event) => setSelectedChildId(event.target.value)}
              data-child-selector="true"
            >
              {me.children.map((child) => (
                <option key={child.id} value={child.id}>
                  {child.name}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <div className={styles.alert} role="alert">
              {error}
            </div>
          )}
          {notice && (
            <output className={styles.infoBand}>
              <Check size={18} aria-hidden="true" /> <span>{notice}</span>
            </output>
          )}
          {loading ? (
            <div className={styles.loading}>
              <RefreshCw aria-hidden="true" />
              <p>Loading this child’s learning record…</p>
            </div>
          ) : (
            selectedChild && (
              <div className={styles.learningColumns}>
                <form
                  className={`${styles.surface} ${styles.surfacePad}`}
                  onSubmit={(event) => void savePlan(event)}
                  data-onboarding-form="true"
                >
                  <div className={styles.sectionHead}>
                    <div>
                      <h3>Child plan</h3>
                      <p className={styles.smallPrint}>
                        A nickname, broad experience and audio readiness are
                        enough.
                      </p>
                    </div>
                  </div>
                  <div className={styles.fieldStack}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Nickname</span>
                      <input
                        className={styles.input}
                        value={nickname}
                        maxLength={40}
                        onChange={(event) => setNickname(event.target.value)}
                        required
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>
                        Chinese-learning experience
                      </span>
                      <select
                        className={styles.select}
                        value={experience}
                        onChange={(event) =>
                          setExperience(
                            event.target.value as PilotOnboardingExperience,
                          )
                        }
                      >
                        <option value="new">New to Chinese</option>
                        <option value="some">Some previous experience</option>
                        <option value="confident">Quite confident</option>
                        <option value="unsure">Not sure yet</option>
                      </select>
                    </label>
                    <label className={styles.checkField}>
                      <input
                        id={`audio-ready-${selectedChild.id}`}
                        type="checkbox"
                        aria-label="Audio is ready"
                        checked={audioReady}
                        onChange={(event) =>
                          setAudioReady(event.target.checked)
                        }
                      />
                      <span>
                        <strong>Audio is ready</strong>
                        <small>
                          {audioReady
                            ? 'The child can try Mandarin sound checks.'
                            : 'Sound can be unavailable; the lesson records that separately.'}
                        </small>
                      </span>
                    </label>
                  </div>
                  <div className={styles.formActions}>
                    <button
                      className={styles.primaryButton}
                      type="submit"
                      disabled={saving || !nickname.trim()}
                    >
                      {saving
                        ? 'Saving…'
                        : onboarding
                          ? 'Save changes'
                          : 'Save child plan'}{' '}
                      <Check size={17} />
                    </button>
                  </div>
                </form>
                <div
                  className={`${styles.surface} ${styles.surfacePad}`}
                  data-assignment-panel="true"
                >
                  <div className={styles.sectionHead}>
                    <div>
                      <h3>Forest lesson</h3>
                      <p className={styles.smallPrint}>
                        Only released material can be assigned.
                      </p>
                    </div>
                    <Volume2
                      size={22}
                      color="var(--cs-teal)"
                      aria-hidden="true"
                    />
                  </div>
                  <div className={styles.task}>
                    <div className={styles.taskHeader}>
                      <strong>
                        {forestLesson?.title || 'Build a Little Forest'}
                      </strong>
                      <span
                        className={styles.status}
                        data-state={
                          assignment
                            ? 'ready'
                            : forestLesson?.canAssign
                              ? 'active'
                              : 'pending'
                        }
                      >
                        {assignment
                          ? 'Assigned'
                          : forestLesson?.releaseState === 'approved'
                            ? 'Available'
                            : forestLesson?.releaseState === 'test-fixture'
                              ? 'Test fixture'
                              : 'Pending release'}
                      </span>
                    </div>
                    <p>
                      {assignment
                        ? `Assigned ${dateLabel(assignment.createdAt)}. The child can start from their invited account.`
                        : forestLesson?.canAssign
                          ? 'Save the child plan, then assign this calm first lesson.'
                          : 'This lesson is waiting for its release and owner evidence gate.'}
                    </p>
                    <div className={styles.taskActions}>
                      <button
                        className={styles.primaryButton}
                        type="button"
                        onClick={() => void assignLesson()}
                        disabled={
                          assigning ||
                          Boolean(assignment) ||
                          !forestLesson?.canAssign
                        }
                      >
                        {assigning
                          ? 'Assigning…'
                          : assignment
                            ? 'Assigned'
                            : 'Assign forest lesson'}{' '}
                        <ArrowRight size={17} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          )}
          {progress && (
            <div
              className={`${styles.surface} ${styles.surfacePad}`}
              data-progress-panel="true"
            >
              <div className={styles.sectionHead}>
                <div>
                  <h3>Saved progress</h3>
                  <p className={styles.smallPrint}>
                    Evidence describes this activity; it does not create a
                    mastery label.
                  </p>
                </div>
                <button
                  className={styles.outlineButton}
                  type="button"
                  onClick={() => void exportRecord()}
                  disabled={exporting}
                >
                  <Download size={17} />{' '}
                  {exporting ? 'Preparing…' : 'Export record'}
                </button>
              </div>
              <RunList progress={progress} />
              <EvidenceLimits limits={progress.evidenceLimits} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function TeacherLearningPanel({ me }: { me: PilotMe }) {
  const [selectedChildId, setSelectedChildId] = useState(
    me.children[0]?.id || '',
  );
  const [progress, setProgress] = useState<PilotProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  const load = useCallback(async (childId: string) => {
    if (!childId) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const next = await getPilotProgress(childId);
      if (requestId === requestRef.current) setProgress(next);
    } catch (loadError) {
      if (requestId === requestRef.current)
        setError(learningMessage(loadError));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  // oxlint-disable react/react-compiler
  useEffect(() => {
    if (!me.children.some((child) => child.id === selectedChildId))
      setSelectedChildId(me.children[0]?.id || '');
  }, [me.children, selectedChildId]);
  // oxlint-enable react/react-compiler
  // oxlint-disable react/react-compiler
  useEffect(() => {
    void load(selectedChildId);
  }, [load, selectedChildId]);
  // oxlint-enable react/react-compiler

  return (
    <section className={styles.learningArea} data-role="teacher-learning">
      <div className={styles.sectionHead}>
        <div>
          <h2>Read-only learning evidence</h2>
          <p className={styles.smallPrint}>
            A parent’s grant lets you read the selected child’s saved activity.
            Teaching controls stay with the child and parent.
          </p>
        </div>
        <ShieldCheck size={22} color="var(--cs-teal)" aria-hidden="true" />
      </div>
      {!me.children.length ? (
        <div className={styles.empty}>
          <p>No learners have been shared with this teacher yet.</p>
        </div>
      ) : (
        <>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Learner</span>
            <select
              className={styles.select}
              value={selectedChildId}
              onChange={(event) => setSelectedChildId(event.target.value)}
              data-child-selector="true"
            >
              {me.children.map((child) => (
                <option key={child.id} value={child.id}>
                  {child.name}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <div className={styles.alert} role="alert">
              {error}
            </div>
          )}
          {loading ? (
            <div className={styles.loading}>
              <RefreshCw aria-hidden="true" />
              <p>Loading saved evidence…</p>
            </div>
          ) : (
            progress && (
              <div className={styles.stack}>
                <div className={`${styles.surface} ${styles.surfacePad}`}>
                  <div className={styles.sectionHead}>
                    <div>
                      <h3>{progress.child.name}</h3>
                      <p className={styles.smallPrint}>
                        Assigned lessons and server-saved run state
                      </p>
                    </div>
                    <span className={styles.status} data-state="active">
                      Read only
                    </span>
                  </div>
                  <RunList progress={progress} readOnly />
                </div>
                <EvidenceLimits limits={progress.evidenceLimits} />
              </div>
            )
          )}
        </>
      )}
    </section>
  );
}

export function ChildLearningPanel({ me }: { me: PilotMe }) {
  const child = childFor(me);
  const [assignments, setAssignments] = useState<PilotAssignments | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lessonOpen, setLessonOpen] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!child) {
      setLoading(false);
      return;
    }
    const requestId = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const next = await getPilotAssignments(child.id);
      if (requestId === requestRef.current) setAssignments(next);
    } catch (loadError) {
      if (requestId === requestRef.current)
        setError(learningMessage(loadError));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [child]);

  // oxlint-disable react/react-compiler
  useEffect(() => {
    void load();
  }, [load]);
  // oxlint-enable react/react-compiler

  const assignment =
    assignments?.assignments.find(
      (item) => item.lessonVersion === FOREST_LESSON_VERSION,
    ) || child?.assignment;
  const context = useMemo(
    () =>
      child
        ? {
            installationId: me.installationId,
            accountId: me.user.id,
            childId: child.id,
            lessonVersion: FOREST_LESSON_VERSION,
          }
        : null,
    [child, me.installationId, me.user.id],
  );
  const transport = useMemo(
    () => (context ? createPilotForestTransport(context) : null),
    [context],
  );
  const recovery = useMemo(
    () => (context ? createPilotRecoveryStore(context) : null),
    [context],
  );

  if (lessonOpen && transport && recovery) {
    return (
      <div className={styles.authenticatedLesson}>
        <ForestLesson
          mode="pilot-child"
          transport={transport}
          recovery={recovery}
          initialRunId={assignment?.runId || null}
          returnHref="/pilot"
        />
      </div>
    );
  }

  return (
    <section className={styles.learningArea} data-role="child-learning">
      <div className={styles.sectionHead}>
        <div>
          <h2>Your little forest</h2>
          <p className={styles.smallPrint}>
            Your assigned lesson saves each step to your child account.
          </p>
        </div>
        <span className={styles.roleTag}>
          <LockKeyhole size={15} /> Private child record
        </span>
      </div>
      {error && (
        <div className={styles.alert} role="alert">
          {error}
          <button
            className={styles.quietButton}
            type="button"
            onClick={() => void load()}
          >
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      )}
      {loading ? (
        <div className={styles.loading}>
          <RefreshCw aria-hidden="true" />
          <p>Checking your assignment…</p>
        </div>
      ) : !assignment ? (
        <div className={styles.empty}>
          <div>
            <h3>Waiting for your assignment</h3>
            <p>
              A parent will connect the first forest lesson before you begin.
            </p>
          </div>
        </div>
      ) : (
        <div className={styles.task} data-assignment-state="assigned">
          <div className={styles.taskHeader}>
            <strong>
              {assignment.lessonId === 'forest-01'
                ? 'Build a Little Forest'
                : assignment.lessonId}
            </strong>
            <span className={styles.status} data-state="ready">
              Assigned
            </span>
          </div>
          <p>
            {assignment.runId
              ? 'Your saved lesson is waiting. Continue from the last step whenever you are ready.'
              : 'Listen, notice and read two characters with a friendly guide.'}
          </p>
          <div className={styles.taskActions}>
            <button
              className={styles.primaryButton}
              type="button"
              onClick={() => setLessonOpen(true)}
            >
              <Play size={17} fill="currentColor" />{' '}
              {assignment.runId ? 'Continue lesson' : 'Start lesson'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
