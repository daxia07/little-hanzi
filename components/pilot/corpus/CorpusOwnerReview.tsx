'use client';
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import {
  createCorpusOwnerReview,
  type CorpusOwnerScope,
  type CorpusOwnerSnapshot,
} from '@/lib/pilot-corpus-owner-client';
import type {
  CorpusSafePlayback,
  CorpusScope,
} from '@/lib/curriculum/corpus-types';
import { registerPilotStoryController } from '@/lib/pilot-story-client';
import { createCollectionAudio } from '@/lib/pilot-collection-audio';
import type { StoryAudioSnapshot } from '@/lib/story-audio';
import styles from './corpus-owner.module.css';
const EMPTY: CorpusOwnerSnapshot = {
  status: 'idle',
  review: null,
  detail: null,
  detailStatus: 'idle',
  selectedScopeDigest: null,
  confirmation: null,
  pending: null,
  receipt: null,
  previous: false,
  limit: 20,
  notice: '',
};
const phaseName = {
  initial: 'First lesson',
  'review-24h': 'Next-day review',
  'review-7d': 'Seven-day review',
};
function scopeName(scope: CorpusScope) {
  return scope.kind === 'starter'
    ? 'Starter curriculum'
    : `Supervised trial · ${scope.members.length} linked ${scope.members.length === 1 ? 'child' : 'children'}`;
}
interface Props {
  scope: CorpusOwnerScope;
  verify: (scope: CorpusOwnerScope) => Promise<boolean>;
  scopeLabel?: (scope: CorpusScope) => string;
}
function OwnerSession({ scope, verify, scopeLabel = scopeName }: Props) {
  const [view, setView] = useState(EMPTY),
    [audioStatus, setAudioStatus] =
      useState<StoryAudioSnapshot['status']>('idle');
  const controller = useRef<ReturnType<typeof createCorpusOwnerReview> | null>(
      null,
    ),
    audio = useRef<ReturnType<typeof createCollectionAudio> | null>(null),
    selectedAsset = useRef<string | null>(null),
    materialHeading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    let alive = true;
    let speech: ReturnType<typeof createCollectionAudio> | null = null;
    const c = createCorpusOwnerReview({
      scope,
      verify,
      onChange: (s) => {
        if (alive) {
          if (!['ready', 'saved'].includes(s.status) || !s.detail) {
            speech?.cancel();
            selectedAsset.current = null;
          }
          setView(s);
        }
      },
    });
    controller.current = c;
    speech = createCollectionAudio({
      profile: (): CorpusSafePlayback | null => {
        const d = c.snapshot().detail,
          a = d?.playback.assets.find(
            (x) => x.assetId === selectedAsset.current,
          );
        return d && a
          ? {
              schemaVersion: 'r5-playback-1',
              kind: d.playback.kind,
              voices: d.playback.voices,
              fallback: 'unavailable',
              cues: [
                {
                  cueId: a.assetId,
                  readingId: 'owner-material',
                  wordId: null,
                  checkId: null,
                  transcript: a.transcript,
                  assetId: a.assetId,
                  assetUrl: a.url,
                  assetDigest: a.digest,
                },
              ],
            }
          : null;
      },
      onChange: (s) => {
        if (alive) setAudioStatus(s.status);
      },
    });
    audio.current = speech;
    const unregister = registerPilotStoryController(() => {
      c.lock();
      speech?.destroy();
      selectedAsset.current = null;
    });
    void c.load();
    return () => {
      alive = false;
      unregister();
      c.destroy();
      speech?.destroy();
      controller.current = null;
      audio.current = null;
      selectedAsset.current = null;
    };
  }, [scope, verify]);
  useEffect(() => {
    if (view.detailStatus === 'ready') materialHeading.current?.focus();
  }, [view.detailStatus, view.detail?.lessonVersion]);
  const r = view.review,
    d = view.detail,
    ready = view.status === 'ready',
    selected = r?.permittedScopes.find(
      (s) => s.scopeDigest === view.selectedScopeDigest,
    ),
    readable = ready || view.status === 'saved';
  const groups = r
    ? Array.from(
        new Map(
          r.items.map((i) => [
            i.lessonVersion,
            {
              ...i,
              hanzi: r.items
                .filter(
                  (x) =>
                    x.lessonVersion === i.lessonVersion &&
                    x.contentDigest === i.contentDigest,
                )
                .map((x) => x.coverageIdentity)
                .join(' · '),
            },
          ]),
        ).values(),
      )
    : [];
  function listen(assetId: string) {
    if (!readable || !d) return;
    audio.current?.cancel();
    selectedAsset.current = assetId;
    audio.current?.setContext(`${scope.snapshotId}:${d.lessonVersion}`);
    void audio.current?.play(assetId, {
      gesture: true,
      questionId: `${scope.snapshotId}:${d.lessonVersion}`,
    });
  }
  return (
    <main
      className={styles.owner}
      data-role="corpus-owner-review"
      data-owner-state={view.status}
      data-snapshot-id={r?.snapshotId}
      data-corpus-version={scope.corpusVersion}
      data-candidate-id={r?.candidateId}
      data-owner-item-state={view.detailStatus}
      aria-busy={view.status === 'loading' || view.status === 'saving'}
    >
      <header className={styles.surface}>
        <p className={styles.eyebrow}>Curriculum review</p>
        <h2>Review this curriculum and build</h2>
        <p>
          Inspect the teaching, pronunciation and checks. Choose the exact scope
          for your decision. The operator publishes separately.
        </p>
        <output className={styles.status} aria-live="polite">
          {view.notice ||
            (view.status === 'loading'
              ? 'Loading curriculum review…'
              : view.status === 'locked'
                ? 'Sign in again'
                : ready
                  ? 'Curriculum review loaded'
                  : '')}
        </output>
        {view.status === 'pending' && (
          <button
            data-control="owner-retry"
            onClick={() => void controller.current?.retry()}
          >
            Retry original decision
          </button>
        )}
        {view.status === 'readback-pending' && (
          <button
            data-control="owner-retry"
            onClick={() => void controller.current?.retry()}
          >
            Retry refresh
          </button>
        )}
        {view.status === 'error' && (
          <button
            data-control="owner-retry"
            onClick={() => void controller.current?.retry()}
          >
            Retry curriculum review
          </button>
        )}
        {view.status === 'conflict' && (
          <button
            data-control="owner-reload"
            onClick={() => void controller.current?.reload()}
          >
            Reload current review
          </button>
        )}
        {view.receipt && (
          <p data-owner-receipt={view.receipt.recordId}>
            Decision recorded at{' '}
            {new Date(view.receipt.recordedAt).toLocaleString()}. This records
            your decision; it does not publish the curriculum.
          </p>
        )}
      </header>
      {r && (
        <>
          <section className={styles.surface}>
            <h3>{scope.corpusVersion}</h3>
            <div className={styles.counts}>
              <span>
                {r.counts.reviewedReady} reviewed and ready characters
              </span>
              <span>{r.counts.fixture} verification fixture characters</span>
              <span>
                {r.counts.prospectiveStarter} proposed starter characters
              </span>
              <span>
                {r.counts.committedStarter} published starter characters
              </span>
            </div>
            <details>
              <summary>Curriculum and build evidence</summary>
              <dl>
                <dt>Snapshot</dt>
                <dd>{r.snapshotId}</dd>
                <dt>Corpus digest</dt>
                <dd>{r.corpusDigest}</dd>
                <dt>Prospective digest</dt>
                <dd>{r.prospectiveDigest}</dd>
                <dt>Build</dt>
                <dd>{r.candidateId}</dd>
                <dt>Source</dt>
                <dd>{r.sourceDigest}</dd>
                <dt>Artifact</dt>
                <dd>{r.artifactDigest}</dd>
                <dt>Current installation</dt>
                <dd>{scope.installationId}</dd>
                <dt>Checked</dt>
                <dd>{new Date(r.dataAt).toLocaleString()}</dd>
              </dl>
            </details>
          </section>
          <section className={styles.surface}>
            <h3>Teaching material</h3>
            <label>
              Characters per page
              <select
                data-control="owner-page-size"
                value={view.limit}
                disabled={!ready}
                onChange={(e) =>
                  void controller.current?.pageSize(
                    Number(e.target.value) as 20 | 50,
                  )
                }
              >
                <option value="20">20</option>
                <option value="50">50</option>
              </select>
            </label>
            <p>Open a lesson to inspect its teaching and expected answers.</p>
            {groups.length === 0 && (
              <p>No material is available on this page.</p>
            )}
            <div className={styles.cards}>
              {groups.map((row, index) => (
                <article
                  key={row.lessonVersion}
                  data-owner-member={row.lessonVersion}
                >
                  <h4>
                    {d?.lessonVersion === row.lessonVersion
                      ? d.title
                      : `Lesson ${index + 1}`}
                  </h4>
                  <p className={styles.hanzi}>{row.hanzi}</p>
                  <button
                    data-control="owner-open-item"
                    disabled={!readable}
                    onClick={() =>
                      void controller.current?.openItem(
                        row.lessonVersion,
                        row.contentDigest,
                      )
                    }
                  >
                    Review this lesson
                  </button>
                  <details>
                    <summary>Lesson evidence</summary>
                    <p>{row.lessonVersion}</p>
                    <p>{row.contentDigest}</p>
                    {row.evidenceRefs.map((ref) => (
                      <p key={ref}>{ref}</p>
                    ))}
                  </details>
                </article>
              ))}
            </div>
            <nav className={styles.row} aria-label="Curriculum material pages">
              <button
                data-control="owner-previous-page"
                disabled={!ready || !view.previous}
                onClick={() => void controller.current?.previous()}
              >
                Previous page
              </button>
              <button
                data-control="owner-next-page"
                disabled={!ready || !r.nextCursor}
                onClick={() => void controller.current?.next()}
              >
                Next page
              </button>
            </nav>
          </section>
          {view.detailStatus === 'loading' && (
            <output aria-live="polite">Loading lesson material…</output>
          )}
          {view.detailStatus === 'error' && (
            <p>Lesson material could not load. Use its review link to retry.</p>
          )}
          {d && (
            <section
              className={styles.surface}
              data-owner-item={d.lessonVersion}
            >
              <h3 ref={materialHeading} tabIndex={-1}>
                {d.title}
              </h3>
              {d.targets.map((t) => (
                <article key={t.characterId} className={styles.target}>
                  <h4 className={styles.hanzi}>{t.hanzi}</h4>
                  <p>{t.meanings.join('; ')}</p>
                  <p>
                    {t.readings
                      .map((x) => `${x.pinyin} · ${x.audioText}`)
                      .join('; ')}
                  </p>
                  <p>{t.teaching.instructionEnglish}</p>
                  <p>Hint: {t.teaching.hintEnglish}</p>
                  <p>Demonstration: {t.teaching.demonstrationEnglish}</p>
                  {t.words.map((w, index) => (
                    <div key={`${w.text}:${index}`} className={styles.inset}>
                      <h5>{w.text}</h5>
                      <p>
                        {w.pinyin} · {w.english}
                      </p>
                      <p>{w.context.hanzi}</p>
                      <p>{w.context.english}</p>
                    </div>
                  ))}
                </article>
              ))}
              <h4>Supported reading</h4>
              {d.readers.map((reader, index) => (
                <article key={index} className={styles.inset}>
                  <h5>{reader.title}</h5>
                  <p>{reader.instructionEnglish}</p>
                  <p>{reader.text}</p>
                  <p>{reader.english}</p>
                </article>
              ))}
              <h4>Check prompts and expected answers</h4>
              <p>
                Ten prompt templates cover twelve scored occurrences across the
                first lesson and later reviews.
              </p>
              {d.prompts.map((prompt, index) => (
                <article
                  key={index}
                  className={styles.inset}
                  data-owner-prompt={index}
                >
                  <h5>{prompt.phases.map((p) => phaseName[p]).join(' · ')}</h5>
                  <p>{prompt.instructionEnglish}</p>
                  <p>{prompt.promptEnglish}</p>
                  <p>Spoken cue: {prompt.audioText}</p>
                  <p>
                    Expected answer:{' '}
                    <strong className={styles.hanzi}>
                      {prompt.expectedAnswerHanzi}
                    </strong>
                  </p>
                </article>
              ))}
              <h4>Pronunciation and audio evidence</h4>
              <p>
                {d.playback.kind === 'recorded'
                  ? 'Reviewed recording references'
                  : 'Declared local device voices'}
                :{' '}
                {d.playback.voices.map((v) => v.name).join(', ') ||
                  'No local voice declared'}
              </p>
              <output aria-live="polite">
                {audioStatus === 'unavailable'
                  ? 'Sound unavailable on this device.'
                  : audioStatus === 'playing'
                    ? 'Playing pronunciation…'
                    : ''}
              </output>
              <button
                data-control="owner-stop-audio"
                onClick={() => audio.current?.cancel()}
              >
                Stop sound
              </button>
              {d.playback.assets.map((a) => (
                <article key={a.assetId} className={styles.inset}>
                  <p>{a.transcript}</p>
                  <button
                    data-control="owner-listen"
                    data-asset-id={a.assetId}
                    disabled={!readable}
                    onClick={() => listen(a.assetId)}
                  >
                    Listen to pronunciation
                  </button>
                  <details>
                    <summary>Audio provenance</summary>
                    <p>{a.reviewRef}</p>
                    <p>{a.assetId}</p>
                    {a.digest && <p>{a.digest}</p>}
                  </details>
                </article>
              ))}
              <h4>Illustration references</h4>
              <div className={styles.cards}>
                {d.imageRefs.map((image) => (
                  <figure key={image.assetId}>
                    <Image
                      src={image.url}
                      alt={`Curriculum illustration for ${d.title}`}
                      width={800}
                      height={600}
                      unoptimized
                      loading="lazy"
                    />
                    <figcaption>{image.licenseRef}</figcaption>
                    <details>
                      <summary>Image evidence</summary>
                      <p>{image.assetId}</p>
                      <p>{image.digest}</p>
                    </details>
                  </figure>
                ))}
              </div>
              <details>
                <summary>Attributed curriculum evidence</summary>
                {Object.entries(d.evidenceRefs).map(([kind, refs]) => (
                  <div key={kind}>
                    <h5>
                      {kind === 'contentReview'
                        ? 'Content review'
                        : kind === 'audioReview'
                          ? 'Audio review'
                          : kind === 'assetInventory'
                            ? 'Asset inventory'
                            : kind === 'source'
                              ? 'Source'
                              : 'Executed proof'}
                    </h5>
                    {refs.map((ref) => (
                      <p key={ref}>{ref}</p>
                    ))}
                  </div>
                ))}
              </details>
            </section>
          )}
          {ready && (
            <section className={styles.surface}>
              <h3>Your decision</h3>
              <label>
                Curriculum scope
                <select
                  data-control="owner-scope"
                  value={view.selectedScopeDigest ?? ''}
                  onChange={(e) =>
                    controller.current?.chooseScope(e.target.value)
                  }
                >
                  <option value="">Choose a reviewed scope</option>
                  {r.permittedScopes.map((s) => (
                    <option
                      key={s.scopeDigest}
                      value={s.scopeDigest}
                      disabled={!s.available || s.reasonCode !== null}
                    >
                      {scopeLabel(s.scope)}
                      {s.available ? '' : ' · unavailable'}
                    </option>
                  ))}
                </select>
              </label>
              {selected && (
                <details>
                  <summary>Exact scope evidence</summary>
                  <p>{selected.scopeDigest}</p>
                  {selected.scope.kind === 'supervised-trial' &&
                    selected.scope.members.map((m) => (
                      <p key={`${m.parentId}:${m.childId}`}>
                        Parent {m.parentId} · child {m.childId}
                      </p>
                    ))}
                </details>
              )}
              <div className={styles.row}>
                <button
                  data-control="owner-accept"
                  disabled={!selected?.available}
                  onClick={() => controller.current?.prepare('accepted')}
                >
                  Accept this curriculum and build
                </button>
                <button
                  data-control="owner-reject"
                  disabled={!selected?.available}
                  onClick={() => controller.current?.prepare('rejected')}
                >
                  Reject this curriculum and build
                </button>
              </div>
              {view.confirmation && selected && (
                <section
                  className={styles.confirmation}
                  data-owner-confirmation={view.confirmation}
                >
                  <h4>
                    {view.confirmation === 'accepted'
                      ? 'Confirm your acceptance'
                      : 'Confirm your rejection'}
                  </h4>
                  <p>
                    {scope.corpusVersion} · build {r.candidateId}
                  </p>
                  <p>{scopeLabel(selected.scope)}</p>
                  <p>
                    Your decision applies to this exact curriculum, build and
                    scope. The operator publishes separately.
                  </p>
                  <details>
                    <summary>Exact decision binding</summary>
                    <p>{r.snapshotId}</p>
                    <p>{r.corpusDigest}</p>
                    <p>{r.sourceDigest}</p>
                    <p>{r.artifactDigest}</p>
                    <p>{selected.scopeDigest}</p>
                  </details>
                  <div className={styles.row}>
                    <button
                      data-control="owner-confirm"
                      onClick={() => void controller.current?.confirm()}
                    >
                      {view.confirmation === 'accepted'
                        ? 'Confirm acceptance'
                        : 'Confirm rejection'}
                    </button>
                    <button
                      data-control="owner-cancel"
                      onClick={() => controller.current?.cancel()}
                    >
                      Keep reviewing
                    </button>
                  </div>
                </section>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
export default function CorpusOwnerReview(props: Props) {
  return (
    <OwnerSession
      key={JSON.stringify(
        Object.entries(props.scope).sort(([a], [b]) => a.localeCompare(b)),
      )}
      {...props}
    />
  );
}
