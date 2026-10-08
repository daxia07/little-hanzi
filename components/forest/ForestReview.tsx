'use client';

import { Check, CircleAlert, Clock3, ExternalLink, FileText, MessageCircle, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  FOREST_LESSON_VERSION,
  ForestApiError,
  ForestDecision,
  ForestFeedback,
  ForestRun,
  getForestDecision,
  getForestRun,
  listForestRuns,
  newForestId,
  sendForestDecision,
  sendForestFeedback,
} from '@/lib/forest-client';
import styles from './forest.module.css';

type FeedbackCategory = ForestFeedback['category'];

function formatDate(value?: string | null) {
  if (!value) return 'Not recorded';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return value;
  }
}

function errorText(error: unknown) {
  if (error instanceof ForestApiError) return error.message;
  return 'The reviewer view could not load this preview. Check that preview mode is enabled.';
}

function eventOutcome(event: ForestRun['events'][number]) {
  if (typeof event.outcome === 'string') return event.outcome;
  if (typeof event.result === 'string') return event.result;
  if (event.result && typeof event.result === 'object' && typeof event.result.outcome === 'string') return event.result.outcome;
  return 'recorded';
}

export default function ForestReview({ testMode = false }: { testMode?: boolean }) {
  const [runs, setRuns] = useState<ForestRun[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [run, setRun] = useState<ForestRun | null>(null);
  const [decision, setDecision] = useState<ForestDecision | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [feedbackCategory, setFeedbackCategory] = useState<FeedbackCategory>('clarity');
  const [feedbackStep, setFeedbackStep] = useState('');
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [reviewerLabel, setReviewerLabel] = useState('Local reviewer');
  const [decisionNotes, setDecisionNotes] = useState('');
  const [decisionSending, setDecisionSending] = useState(false);
  const [decisionMessage, setDecisionMessage] = useState('');

  async function loadSelected(id: string, availableRuns = runs) {
    const chosen = availableRuns.find((item) => item.runId === id);
    if (!chosen) return;
    setSelectedId(id);
    setLoading(true);
    setError('');
    try {
      const [loaded, currentDecision] = await Promise.all([getForestRun(id), getForestDecision(FOREST_LESSON_VERSION)]);
      setRun(loaded);
      setDecision(currentDecision);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function loadRuns() {
    setLoading(true);
    setError('');
    try {
      const availableRuns = await listForestRuns();
      setRuns(availableRuns);
      const params = new URLSearchParams(window.location.search);
      const requested = params.get('runId') || params.get('run');
      if (requested && !availableRuns.some((item) => item.runId === requested)) {
        setError('That preview run was not found in this local instance. Choose a listed run or return to the lesson.');
        setLoading(false);
        return;
      }
      const first = requested || availableRuns[0]?.runId;
      if (first) await loadSelected(first, availableRuns);
      else {
        const currentDecision = await getForestDecision(FOREST_LESSON_VERSION);
        setDecision(currentDecision);
        setLoading(false);
      }
    } catch (loadError) {
      setError(errorText(loadError));
      setLoading(false);
    }
  }

  // oxlint-disable-next-line react/react-compiler
  useEffect(() => { void loadRuns(); }, []);

  const latestEvents = useMemo(() => (run?.events || []).slice(-12).reverse(), [run]);

  async function saveFeedback(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!run || !feedbackText.trim()) return;
    setFeedbackSending(true);
    setFeedbackMessage('');
    try {
      const saved = await sendForestFeedback(run.runId, {
        feedbackId: newForestId(),
        stepId: feedbackStep || null,
        category: feedbackCategory,
        text: feedbackText.trim(),
        source: 'reviewer',
      });
      setRun((old) => old ? { ...old, feedback: [...old.feedback, saved] } : old);
      setFeedbackText('');
      setFeedbackMessage('Feedback saved to this run.');
    } catch (saveError) {
      setFeedbackMessage(errorText(saveError));
    } finally {
      setFeedbackSending(false);
    }
  }

  async function saveDecision(status: 'changes-requested' | 'approved') {
    setDecisionSending(true);
    setDecisionMessage('');
    try {
      const saved = await sendForestDecision(FOREST_LESSON_VERSION, {
        status,
        reviewerLabel: reviewerLabel.trim() || 'Local reviewer',
        notes: decisionNotes.trim(),
        candidateId: decision?.candidateId || 'local-candidate',
      });
      setDecision(saved);
      setDecisionMessage(status === 'approved' ? (testMode ? 'Synthetic approval saved for this candidate build.' : 'Owner decision saved for this candidate build.') : 'Changes requested and saved for this candidate build.');
    } catch (saveError) {
      setDecisionMessage(errorText(saveError));
    } finally {
      setDecisionSending(false);
    }
  }

  return <div className={styles.root} lang="en"><div className={styles.shell}><nav className={styles.topbar} aria-label="Reviewer navigation"><Link className={styles.brand} href="/preview/forest-01"><span className={styles.brandMark}>字</span><span><span className={styles.brandName}>Little Hanzi</span><span className={styles.brandSub}>review desk</span></span></Link><div className={styles.topActions}><Link className={styles.topLink} href="/preview/forest-01"><ExternalLink size={16} /><span>Open child lesson</span></Link></div></nav>{error && <div className={styles.audioNotice} data-tone="error"><CircleAlert size={18} /><span>{error}</span><button className={styles.quietButton} onClick={() => void loadRuns()}><RefreshCw size={15} /> Retry</button></div>}<div className={styles.reviewLayout}><aside className={`${styles.surface} ${styles.reviewSidebar}`}><h2>Preview runs</h2><p className={styles.smallPrint}>Local synthetic and owner-preview runs are listed here. The old family lesson is not included.</p>{loading && !runs.length ? <p className={styles.smallPrint}>Loading runs…</p> : <div className={styles.runList}>{runs.map((item) => <button key={item.runId} className={styles.runItem} data-selected={selectedId === item.runId} onClick={() => void loadSelected(item.runId)}><strong>{item.state.completedAt ? 'Completed forest' : 'In progress forest'}</strong><small>{item.runId.slice(0, 12)} · {item.state.phase} · {item.lessonVersion}</small></button>)}</div>}{!loading && !runs.length && <p className={styles.smallPrint}>Start the child lesson to create a run for review.</p>}<div className={styles.statusBar}><ShieldCheck size={15} /><span>Trusted local preview</span></div></aside><main className={styles.reviewMain}>{!run ? <section className={`${styles.surface} ${styles.emptyState}`}><FileText size={28} color="var(--cs-blue)" /><h1>Parent and reviewer view</h1><p>Select a run after playing the lesson. This screen reports evidence and scripted tutor behavior, not a mastery verdict.</p><Link className={styles.primaryButton} href="/preview/forest-01">Open the lesson <ExternalLink size={17} /></Link></section> : <><section className={`${styles.surface} ${styles.reviewSection}`}><div className={styles.reviewHeading}><div><p className={styles.eyebrow}>Forest lesson · {run.lessonVersion}</p><h1>Evidence for this run</h1><p>Run {run.runId} · seed {run.seed} · completed {formatDate(run.state.completedAt)}</p></div><span className={styles.scriptedTag}><MessageCircle size={15} /> Scripted tutor</span></div><div className={styles.evidenceGrid}><EvidenceGroup label="Familiarity" group={run.recap.familiarity} /><EvidenceGroup label="Final checks" group={run.recap.final} /><EvidenceGroup label="Later review" group={run.recap.delayed} /></div><div className={styles.statusBar}><Clock3 size={15} /><span>{run.reviewAvailableAt ? `Later review: ${formatDate(run.reviewAvailableAt)}` : 'Later review is set after initial completion.'}</span><span>{run.state.reviewCompletedAt ? 'Completed' : 'Not completed'}</span></div></section><section className={`${styles.surface} ${styles.reviewSection}`}><h2>Recent learning events</h2><p>First responses, assistance, and unavailable sound are kept as separate events. Scene and component activities are reported separately.</p>{latestEvents.length ? <div className={styles.eventTableWrap}><table className={styles.eventTable}><thead><tr><th>Step</th><th>Action</th><th>Outcome</th><th>Assistance</th><th>Time</th></tr></thead><tbody>{latestEvents.map((event, index) => <tr key={`${event.eventId}-${index}`}><td>{event.questionId || event.stepId || 'lesson'}</td><td>{event.type || event.action || 'recorded'}</td><td>{eventOutcome(event)}</td><td>{event.assisted ? 'supported' : event.firstResponse ? 'first response' : '—'}</td><td>{formatDate(event.serverTime || event.createdAt)}</td></tr>)}</tbody></table></div> : <p className={styles.smallPrint}>No events have been saved for this run yet.</p>}</section><section className={`${styles.surface} ${styles.reviewSection}`}><h2>Screen-specific feedback</h2><p>Capture a concrete observation about clarity, pacing, difficulty, mascot, reporting, or another detail.</p><form className={styles.feedbackForm} onSubmit={(event) => void saveFeedback(event)}><label className={styles.fieldLabel}>Category<select value={feedbackCategory} onChange={(event) => setFeedbackCategory(event.target.value as FeedbackCategory)}><option value="clarity">Clarity</option><option value="pacing">Pacing</option><option value="difficulty">Difficulty</option><option value="mascot">Mascot</option><option value="reporting">Reporting</option><option value="other">Other</option></select></label><label className={styles.fieldLabel}>Screen or step<select value={feedbackStep} onChange={(event) => setFeedbackStep(event.target.value)}><option value="">Whole lesson</option>{['welcome', 'familiarity', 'learn', 'build', 'find', 'read', 'check', 'recap'].map((step) => <option key={step} value={step}>{step}</option>)}</select></label><label className={styles.fieldLabel}>Observation<textarea value={feedbackText} onChange={(event) => setFeedbackText(event.target.value)} placeholder="What should the owner see or change?" /></label><div className={styles.decisionRow}><button className={styles.primaryButton} type="submit" disabled={feedbackSending || !feedbackText.trim()}><Send size={16} /> {feedbackSending ? 'Saving…' : 'Save feedback'}</button>{feedbackMessage && <span className={styles.smallPrint}>{feedbackMessage}</span>}</div></form>{run.feedback.length > 0 && <ul className={styles.historyList}>{run.feedback.slice().reverse().map((item) => <li key={item.feedbackId}><strong>{item.category}</strong> · {item.stepId || 'whole lesson'}<br />{item.text}</li>)}</ul>}</section><section className={`${styles.surface} ${styles.reviewSection}`}><h2>Candidate decision</h2><p>Decision history is version and candidate specific. {testMode ? 'Synthetic approvals here are isolated review evidence.' : 'Record the owner decision for this candidate here; final owner sign-off remains explicit.'}</p><div className={styles.decisionRow}><span className={styles.decisionPill} data-status={decision?.status}>{decision?.status || 'draft'}</span><span className={styles.smallPrint}>Candidate {decision?.candidateId || 'loading…'}</span></div><div className={styles.feedbackForm}><label className={styles.fieldLabel}>Reviewer label<input value={reviewerLabel} onChange={(event) => setReviewerLabel(event.target.value)} /></label><label className={styles.fieldLabel}>Notes<textarea value={decisionNotes} onChange={(event) => setDecisionNotes(event.target.value)} placeholder="Record what you reviewed or what needs changing." /></label><div className={styles.decisionRow}><button className={styles.outlineButton} onClick={() => void saveDecision('changes-requested')} disabled={decisionSending}><CircleAlert size={16} /> Request changes</button><button className={styles.secondaryButton} onClick={() => void saveDecision('approved')} disabled={decisionSending}><Check size={16} /> {testMode ? 'Record synthetic approval' : 'Approve this candidate'}</button>{decisionMessage && <span className={styles.smallPrint}>{decisionMessage}</span>}</div></div>{decision?.history?.length ? <ul className={styles.historyList}>{decision.history.slice().reverse().map((item, index) => <li key={`${item.createdAt || item.status}-${index}`}><strong>{item.status}</strong> · {item.reviewerLabel || 'reviewer'} · {formatDate(item.createdAt)}<br />{item.notes || 'No notes.'}</li>)}</ul> : null}</section></>}</main></div></div></div>;
}

function EvidenceGroup({ label, group }: { label: string; group?: ForestRun['recap']['familiarity'] }) {
  return <div className={styles.evidenceBlock}><h3>{label}</h3>{group ? <div className={styles.evidenceRows}><span>Independent <strong>{group.independentCorrect}</strong></span><span>Supported <strong>{group.supported}</strong></span><span>Unavailable <strong>{group.unavailable}</strong></span><span>Pending <strong>{group.pending}</strong></span></div> : <p className={styles.smallPrint}>Not started</p>}</div>;
}
