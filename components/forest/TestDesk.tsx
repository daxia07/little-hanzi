'use client';

import { Check, CircleAlert, ExternalLink, FlaskConical, LockKeyhole, RefreshCw, TimerReset, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import styles from './forest.module.css';

type Identity = { testMode?: boolean; testRunId?: string; candidateId?: string; isolatedStorage?: boolean | string; [key: string]: unknown };
type FixtureRun = { runId: string; label?: string; scenario?: string; expected?: unknown; [key: string]: unknown };

const SCENARIOS = [
  ['new-reader', 'Both first answers wrong'],
  ['familiar-reader', 'Both first answers right'],
  ['mixed-reader', 'One familiar, one new'],
  ['needs-help', 'Repeated error and audio'],
  ['in-progress', 'Saved middle step'],
  ['review-due', 'Later review due'],
];

function apiError(value: unknown) {
  if (value && typeof value === 'object' && 'error' in value) {
    const error = (value as { error?: { message?: string } }).error;
    if (error?.message) return error.message;
  }
  return 'The test control request was denied or unavailable.';
}

async function testRequest<T>(path: string, init: RequestInit = {}) {
  const requestHeaders = new Headers(init.headers);
  requestHeaders.set('Accept', 'application/json');
  if (init.body) requestHeaders.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', headers: requestHeaders });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiError(value));
  return value as T;
}

export default function TestDesk() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [guardState, setGuardState] = useState<'loading' | 'ready' | 'blocked'>('loading');
  const [guardMessage, setGuardMessage] = useState('Checking the server test guard…');
  const [scenario, setScenario] = useState('new-reader');
  const [seed, setSeed] = useState('17');
  const [clock, setClock] = useState('2026-09-26T00:00:00.000Z');
  const [fixtureRuns, setFixtureRuns] = useState<FixtureRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function loadIdentity() {
    setGuardState('loading');
    setGuardMessage('Checking the server test guard…');
    try {
      const result = await testRequest<Identity>('/api/test/identity');
      if (!result.testMode) throw new Error('The server is not in test mode.');
      setIdentity(result);
      setGuardState('ready');
      setGuardMessage('Server test mode is active with isolated storage.');
    } catch (error) {
      setIdentity(null);
      setGuardState('blocked');
      setGuardMessage(error instanceof Error ? error.message : 'Test mode is unavailable.');
    }
  }

  // oxlint-disable-next-line react/react-compiler
  useEffect(() => { void loadIdentity(); }, []);

  async function createFixture() {
    setBusy(true);
    setMessage('');
    try {
      const response = await testRequest<{ runs?: FixtureRun[]; runIds?: string[]; learnerRunIds?: string[] }>('/api/test/fixtures', { method: 'POST', body: JSON.stringify({ scenario, seed: Number(seed) || 17 }) });
      const runs = response.runs || (response.runIds || response.learnerRunIds || []).map((runId) => ({ runId, scenario }));
      setFixtureRuns((old) => [...runs, ...old.filter((item) => !runs.some((next) => next.runId === item.runId))]);
      setMessage(`Created ${runs.length || 1} synthetic run${runs.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Fixture creation failed.');
    } finally {
      setBusy(false);
    }
  }

  async function advanceClock(runId: string) {
    setBusy(true);
    setMessage('');
    try {
      const response = await testRequest<{ effectiveTime?: string }>(`/api/test/runs/${encodeURIComponent(runId)}/clock`, { method: 'POST', body: JSON.stringify({ effectiveTime: new Date(clock).toISOString() }) });
      setMessage(`Clock set to ${response.effectiveTime || clock}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Clock update failed.');
    } finally {
      setBusy(false);
    }
  }

  async function resetRun(runId: string) {
    setBusy(true);
    setMessage('');
    try {
      await testRequest(`/api/test/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
      setFixtureRuns((old) => old.filter((item) => item.runId !== runId));
      setMessage('Selected synthetic run reset.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Reset failed.');
    } finally {
      setBusy(false);
    }
  }

  return <div className={styles.root} lang="en"><div className={styles.shell}><nav className={styles.topbar} aria-label="Test desk navigation"><Link className={styles.brand} href="/preview/forest-01"><span className={styles.brandMark}>字</span><span><span className={styles.brandName}>Little Hanzi</span><span className={styles.brandSub}>test desk</span></span></Link><Link className={styles.topLink} href="/preview/forest-01/review"><ExternalLink size={16} /> Reviewer view</Link></nav><main className={styles.testDesk}><p className={styles.eyebrow}>Harness controls</p><h1 className={styles.pageTitle}>Preview test desk</h1><p className={styles.heroLead}>Create synthetic runs, advance one run’s effective clock, and open the normal lesson UI. The test runner supplies the private token through request headers; it is not embedded in application code.</p><div className={styles.guardPanel} data-state={guardState}><LockKeyhole size={21} /><div><strong>{guardState === 'ready' ? 'Test controls unlocked' : guardState === 'blocked' ? 'Test controls unavailable' : 'Checking test mode'}</strong><span>{guardMessage}</span>{identity && <span className={styles.smallPrint}>Candidate {identity.candidateId || 'unknown'} · run {identity.testRunId || 'unknown'} · isolated {String(identity.isolatedStorage ?? 'unknown')}</span>}</div>{guardState !== 'loading' && <button className={styles.quietButton} onClick={() => void loadIdentity()}><RefreshCw size={15} /> Refresh</button>}</div>{guardState === 'ready' ? <section className={`${styles.surface} ${styles.testControls}`}><div className={styles.reviewSection}><h2>New synthetic run</h2><p>Use a declared scenario and seed. The fixture API chooses test data; ordinary preview requests cannot inject it.</p><div className={styles.scenarioGrid}>{SCENARIOS.map(([id, label]) => <button key={id} className={styles.scenarioButton} data-selected={scenario === id} onClick={() => setScenario(id)}><strong>{id}</strong><small>{label}</small></button>)}</div><div className={styles.decisionRow}><label className={styles.fieldLabel}>Seed<input inputMode="numeric" value={seed} onChange={(event) => setSeed(event.target.value)} /></label><button className={styles.primaryButton} onClick={() => void createFixture()} disabled={busy}><FlaskConical size={17} /> {busy ? 'Creating…' : 'Create fixture'}</button></div></div><div className={styles.reviewSection}><h2>Effective time</h2><p>Clock changes are scoped to one synthetic run and move forward only.</p><div className={styles.decisionRow}><label className={styles.fieldLabel}>UTC time<input type="datetime-local" value={clock.slice(0, 16)} onChange={(event) => setClock(`${event.target.value}:00.000Z`)} /></label><TimerReset size={21} color="var(--cs-muted)" /></div></div></section> : <section className={`${styles.surface} ${styles.emptyState}`}><CircleAlert size={28} color="var(--cs-danger)" /><h2>Open this page through the isolated test runner</h2><p>Outside server test mode, fixture, clock, and reset controls stay unavailable. A URL flag cannot unlock them.</p></section>}{message && <div className={styles.statusBar}><Check size={15} /> <span>{message}</span></div>}{fixtureRuns.length > 0 && <section className={`${styles.surface} ${styles.reviewSection}`}><h2>Selected synthetic runs</h2><p>Open a run through the same lesson/reviewer UI, then return here to advance or reset only that run.</p><div className={styles.testRunList}>{fixtureRuns.map((item) => <div className={styles.testRunItem} key={item.runId}><span><strong>{item.scenario || 'fixture'}</strong><br />{item.runId}</span><div className={styles.testLinks}><Link href={`/preview/forest-01?runId=${encodeURIComponent(item.runId)}`}><ExternalLink size={14} /> Lesson</Link><Link href={`/preview/forest-01/review?runId=${encodeURIComponent(item.runId)}`}><ExternalLink size={14} /> Review</Link><button className={styles.quietButton} onClick={() => void advanceClock(item.runId)} disabled={busy}><TimerReset size={15} /> Clock</button><button className={styles.dangerButton} onClick={() => void resetRun(item.runId)} disabled={busy}><Trash2 size={15} /> Reset</button></div></div>)}</div></section>}</main></div></div>;
}
