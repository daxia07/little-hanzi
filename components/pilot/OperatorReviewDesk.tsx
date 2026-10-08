'use client';

import {
  AlertCircle,
  BookOpenText,
  Check,
  ChevronRight,
  ClipboardCheck,
  FileJson,
  FileText,
  RefreshCw,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
} from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import {
  REVIEW_CHECKLIST,
  ReviewDeskController,
  type CurriculumDetail,
  type CurriculumPackageSummary,
  type CurriculumReview,
  type ReviewDeskSnapshot,
  type ReviewDraft,
} from '@/lib/pilot-curriculum-client';
import styles from './pilot.module.css';

const MAX_IMPORT_BYTES = 1_000_000;
const MAX_IMPORT_TEXT = 1_000_000;

function formatTime(value: unknown) {
  const timestamp =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(timestamp)) return 'Time not recorded';
  return `${new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(timestamp))} UTC`;
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pretty(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'Details could not be displayed.';
  }
}

function reviewStateLabel(value: unknown) {
  if (value === 'test-fixture') return 'Test fixture';
  if (value === 'approved') return 'Latest review: approved';
  if (value === 'rejected') return 'Latest review: rejected';
  return 'No review recorded';
}

function decisionLabel(value: string) {
  return value === 'approved'
    ? 'Approved review decision'
    : 'Rejected review decision';
}

function draftComplete(draft: ReviewDraft) {
  return Boolean(
    draft.decision &&
    draft.reviewerRef.trim() &&
    draft.reviewedAt.trim() &&
    draft.evidenceRef.trim() &&
    draft.reason.trim(),
  );
}

export default function OperatorReviewDesk({
  me,
  onRefresh,
}: {
  me: PilotMe;
  onRefresh: () => void;
}) {
  const [controller, setController] = useState<ReviewDeskController | null>(
    null,
  );

  // oxlint-disable react/react-compiler -- Controller setup is an external resource.
  useEffect(() => {
    const nextController = new ReviewDeskController({
      accountId: me.user.id,
      installationId: me.installationId,
    });
    // The controller is an external resource; its lifetime follows this
    // effect rather than the render that creates the component.
    setController(nextController);
    void nextController.refresh();
    return () => {
      nextController.dispose();
    };
  }, [me.installationId, me.user.id]);
  // oxlint-enable react/react-compiler

  if (!controller)
    return (
      <section className={styles.reviewDesk} aria-busy="true">
        <output className={styles.reviewDeskStatus}>
          <RefreshCw size={18} aria-hidden="true" />
          <span>Checking operator access…</span>
        </output>
      </section>
    );

  return (
    <ReviewDeskView controller={controller} me={me} onRefresh={onRefresh} />
  );
}

function invalidateFileReads(ref: { current: number }) {
  ref.current += 1;
}

function ReviewDeskView({
  controller,
  me,
  onRefresh,
}: {
  controller: ReviewDeskController;
  me: PilotMe;
  onRefresh: () => void;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [fileMessage, setFileMessage] = useState('');
  const fileReadRef = useRef(0);
  const previousMeRef = useRef<PilotMe | null>(null);

  useEffect(() => {
    const previousMe = previousMeRef.current;
    previousMeRef.current = me;
    if (
      previousMe &&
      previousMe.user.id === me.user.id &&
      previousMe.installationId === me.installationId
    ) {
      void controller.refresh();
    }
    return () => invalidateFileReads(fileReadRef);
  }, [controller, me]);

  function onImportText(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    if (value.length > MAX_IMPORT_TEXT) {
      setFileMessage('The package text is too large to import here.');
      return;
    }
    setFileMessage('');
    controller.setImportText(value);
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const readId = ++fileReadRef.current;
    if (file.size > MAX_IMPORT_BYTES) {
      setFileMessage('Choose a package file smaller than 1 MB.');
      return;
    }
    try {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      if (readId !== fileReadRef.current) return;
      if (value.length > MAX_IMPORT_TEXT) {
        setFileMessage('The package text is too large to import here.');
        return;
      }
      setFileMessage('');
      controller.setImportText(value);
    } catch {
      if (readId === fileReadRef.current)
        setFileMessage('That file is not valid UTF-8 JSON text.');
    }
  }

  if (snapshot.access === 'checking')
    return (
      <section className={styles.reviewDesk} aria-busy="true">
        <output className={styles.reviewDeskStatus}>
          <RefreshCw size={18} aria-hidden="true" />
          <span>Checking operator access…</span>
        </output>
      </section>
    );

  if (snapshot.access !== 'ready')
    return (
      <section className={styles.reviewDesk} aria-live="polite">
        <div className={`${styles.surface} ${styles.reviewDeskStatus}`}>
          <AlertCircle size={20} aria-hidden="true" />
          <div>
            <h2>Review desk unavailable</h2>
            <p>
              {snapshot.error ||
                'The current operator session cannot inspect curriculum records.'}
            </p>
            <div className={styles.formActions}>
              <button
                className={styles.outlineButton}
                type="button"
                onClick={() => {
                  onRefresh();
                  void controller.refresh();
                }}
              >
                <RefreshCw size={16} aria-hidden="true" /> Retry access
              </button>
            </div>
          </div>
        </div>
      </section>
    );

  const coverage = snapshot.coverage;
  const selectedPackage = coverage?.packages.find(
    (item) => item.lessonVersion === snapshot.selectedVersion,
  );

  return (
    <section className={styles.reviewDesk} aria-labelledby="review-desk-title">
      <header className={styles.reviewDeskHeader}>
        <div>
          <p className={styles.eyebrow}>Registry · Operator</p>
          <h2 id="review-desk-title">Review desk.</h2>
          <p>
            Inspect the exact package and record a review decision. A saved
            decision remains history until a later correction appends a new one.
          </p>
        </div>
        <button
          className={styles.quietButton}
          type="button"
          onClick={() => void controller.refresh()}
          disabled={snapshot.busy}
        >
          <RefreshCw size={16} aria-hidden="true" /> Refresh
        </button>
      </header>

      {snapshot.error && (
        <div className={styles.alert} role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span>{snapshot.error}</span>
          {snapshot.retryAvailable && (
            <button
              className={styles.quietButton}
              type="button"
              onClick={() => void controller.retryReview()}
              disabled={snapshot.busy}
            >
              <RefreshCw size={15} aria-hidden="true" /> Retry saved review
            </button>
          )}
        </div>
      )}
      {fileMessage && (
        <div className={styles.alert} role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span>{fileMessage}</span>
        </div>
      )}
      {snapshot.notice && (
        <output className={styles.infoBand}>
          <Check size={18} aria-hidden="true" />
          <span>{snapshot.notice}</span>
        </output>
      )}

      <div className={styles.reviewDeskLayout}>
        <div className={styles.reviewDeskColumn}>
          <ImportPanel
            snapshot={snapshot}
            onFile={onFile}
            onImportText={onImportText}
            onImport={() => void controller.importPackage()}
          />
          <CoveragePanel
            snapshot={snapshot}
            selectedVersion={snapshot.selectedVersion}
            onSelect={(version) => controller.select(version)}
          />
        </div>
        <div className={styles.reviewDeskColumn}>
          {snapshot.detail ? (
            <DetailPanel
              detail={snapshot.detail}
              selectedPackage={selectedPackage}
            />
          ) : (
            <div
              className={`${styles.surface} ${styles.surfacePad} ${styles.reviewDeskEmpty}`}
            >
              <BookOpenText size={24} aria-hidden="true" />
              <h3>Choose a package to inspect</h3>
              <p>
                The server will load its exact version, digest and saved review
                history here.
              </p>
            </div>
          )}
          {snapshot.detail && (
            <ReviewForm
              snapshot={snapshot}
              onDraft={(draft) => controller.setDraft(draft)}
              onSubmit={() => void controller.submitReview()}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function ImportPanel({
  snapshot,
  onFile,
  onImportText,
  onImport,
}: {
  snapshot: ReviewDeskSnapshot;
  onFile: (event: ChangeEvent<HTMLInputElement>) => void;
  onImportText: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onImport: () => void;
}) {
  return (
    <section className={`${styles.surface} ${styles.surfacePad}`}>
      <div className={styles.sectionHead}>
        <div>
          <h3>Import a package</h3>
          <p className={styles.smallPrint}>
            The server validates the canonical manifest and computes its digest.
          </p>
        </div>
        <FileJson size={22} color="var(--cs-blue)" aria-hidden="true" />
      </div>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Package JSON</span>
        <textarea
          className={styles.textarea}
          value={snapshot.importText}
          onChange={onImportText}
          disabled={snapshot.busy}
          placeholder="Paste a curriculum package JSON object"
          aria-describedby="review-import-help"
        />
      </label>
      <p id="review-import-help" className={styles.formHint}>
        Up to 1 MB. Reading this file does not submit it. Private package text
        stays in this page until you import or clear it.
      </p>
      <div className={styles.reviewDeskImportActions}>
        <label
          className={styles.outlineButton}
          data-disabled={snapshot.busy}
          aria-disabled={snapshot.busy}
        >
          <Upload size={16} aria-hidden="true" /> Choose JSON file
          <input
            className={styles.visuallyHidden}
            type="file"
            accept="application/json,.json,text/json"
            onChange={onFile}
            disabled={snapshot.busy}
          />
        </label>
        <button
          className={styles.primaryButton}
          type="button"
          onClick={onImport}
          disabled={snapshot.busy || !snapshot.importText.trim()}
        >
          {snapshot.busy ? 'Importing…' : 'Import package'}{' '}
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function CoveragePanel({
  snapshot,
  selectedVersion,
  onSelect,
}: {
  snapshot: ReviewDeskSnapshot;
  selectedVersion: string;
  onSelect: (version: string) => void;
}) {
  const coverage = snapshot.coverage;
  return (
    <section className={`${styles.surface} ${styles.surfacePad}`}>
      <div className={styles.sectionHead}>
        <div>
          <h3>Imported packages</h3>
          <p className={styles.smallPrint}>
            Select one exact lesson version to inspect its saved history.
          </p>
          {coverage && (
            <p className={styles.smallPrint}>
              Registry revision {coverage.revision}
            </p>
          )}
        </div>
        <ClipboardCheck size={22} color="var(--cs-teal)" aria-hidden="true" />
      </div>
      {coverage && (
        <dl
          className={styles.reviewCoverageCounts}
          aria-label="Registry coverage counts"
        >
          <div>
            <dt>Machine-valid</dt>
            <dd>{coverage.counts.machineValidDistinct}</dd>
          </div>
          <div>
            <dt>Human-reviewed</dt>
            <dd>{coverage.counts.humanReviewedDistinct}</dd>
          </div>
          <div>
            <dt>Review-ready</dt>
            <dd>{coverage.counts.reviewedReadyDistinct}</dd>
          </div>
          <div>
            <dt>Supervised trial</dt>
            <dd>{coverage.counts.supervisedTrialDistinct}</dd>
          </div>
          <div>
            <dt>Prospective starter</dt>
            <dd>{coverage.counts.prospectiveStarterDistinct}</dd>
          </div>
          <div>
            <dt>Starter released</dt>
            <dd>{coverage.counts.starterReleasedDistinct}</dd>
          </div>
          <div>
            <dt>Starter requirement</dt>
            <dd>{coverage.counts.starterRequiredDistinct}</dd>
          </div>
        </dl>
      )}
      {coverage?.packages.length ? (
        <div
          className={styles.reviewPackageList}
          aria-label="Imported packages"
        >
          {coverage.packages.map((item) => (
            <button
              className={styles.reviewPackageRow}
              data-selected={item.lessonVersion === selectedVersion}
              key={item.lessonVersion}
              type="button"
              aria-pressed={item.lessonVersion === selectedVersion}
              onClick={() => onSelect(item.lessonVersion)}
              disabled={snapshot.busy}
            >
              <span className={styles.reviewPackageMain}>
                <strong>{item.title}</strong>
                <span>
                  {item.lessonVersion} · {item.characterCount} characters
                </span>
              </span>
              <span className={styles.reviewPackageState}>
                <span
                  className={styles.status}
                  data-state={item.testFixture ? 'pending' : 'active'}
                >
                  {item.testFixture
                    ? 'Test fixture · excluded from trusted coverage'
                    : reviewStateLabel(item.reviewState)}
                </span>
                <ChevronRight size={17} aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className={styles.reviewDeskEmpty}>
          <FileText size={22} aria-hidden="true" />
          <p>No packages have been imported yet.</p>
        </div>
      )}
      {coverage && (
        <div className={styles.reviewCoverageNote}>
          <ShieldCheck size={16} aria-hidden="true" />
          <span>
            Trusted release proof is unavailable. A review decision remains
            attributed history and does not release a lesson.
          </span>
        </div>
      )}
    </section>
  );
}

function DetailPanel({
  detail,
  selectedPackage,
}: {
  detail: CurriculumDetail;
  selectedPackage?: CurriculumPackageSummary;
}) {
  const packageValue = record(detail.package);
  const characters = list(packageValue.characters);
  const checks = list(packageValue.recognitionChecks);
  const steps = list(packageValue.steps);
  const assets = list(packageValue.assets);
  return (
    <section
      className={`${styles.surface} ${styles.surfacePad} ${styles.reviewDetail}`}
    >
      <div className={styles.reviewDetailHeader}>
        <div>
          <p className={styles.eyebrow}>Exact package inspection</p>
          <h3>{text(packageValue.title, detail.package.lessonVersion)}</h3>
          <p>
            {text(packageValue.lessonId)} · {detail.package.lessonVersion}
          </p>
        </div>
        <span
          className={styles.status}
          data-state={detail.testFixture ? 'pending' : 'active'}
        >
          {detail.testFixture ? 'Test fixture' : 'Stored package'}
        </span>
      </div>
      <dl className={styles.reviewIdentity}>
        <div>
          <dt>Content digest</dt>
          <dd>{detail.contentDigest}</dd>
        </div>
        <div>
          <dt>Imported</dt>
          <dd>{formatTime(detail.importedAt)}</dd>
        </div>
        <div>
          <dt>Review state</dt>
          <dd>
            {reviewStateLabel(
              detail.testFixture
                ? 'test-fixture'
                : ([...detail.reviews].sort(
                    (left, right) => right.sequence - left.sequence,
                  )[0]?.decision ??
                    selectedPackage?.reviewState ??
                    ''),
            )}
          </dd>
        </div>
      </dl>
      {detail.testFixture && (
        <div className={styles.reviewFixtureNotice}>
          <AlertCircle size={17} aria-hidden="true" />
          <span>
            This package and its reviews are excluded from trusted coverage.
          </span>
        </div>
      )}
      <div className={styles.reviewContentSections}>
        <details open>
          <summary>Characters and teaching</summary>
          <div className={styles.reviewCharacterGrid}>
            {characters.length ? (
              characters.map((value, index) => (
                <CharacterCard
                  key={`${text(record(value).characterId)}-${index}`}
                  value={value}
                />
              ))
            ) : (
              <p className={styles.smallPrint}>
                No character content is available.
              </p>
            )}
          </div>
        </details>
        <details>
          <summary>Recognition checks ({checks.length})</summary>
          <PackageJsonList
            values={checks}
            empty="No recognition checks are listed."
          />
        </details>
        <details>
          <summary>Lesson steps ({steps.length})</summary>
          <PackageJsonList values={steps} empty="No lesson steps are listed." />
        </details>
        <details>
          <summary>Assets and provenance ({assets.length})</summary>
          <PackageJsonList values={assets} empty="No assets are listed." />
        </details>
      </div>
      <ReviewHistory reviews={detail.reviews} />
    </section>
  );
}

function CharacterCard({ value }: { value: unknown }) {
  const character = record(value);
  const readings = list(character.readings);
  const meanings = list(character.meanings);
  const words = list(character.wordAssociations);
  const teaching = record(character.teaching);
  return (
    <article className={styles.reviewCharacterCard}>
      <div className={styles.reviewCharacterHeading}>
        <span className={styles.reviewHanzi}>
          {text(character.hanzi, '字')}
        </span>
        <div>
          <strong>{text(character.characterId, 'Character')}</strong>
          <span>
            {meanings
              .map((item) => text(record(item).english))
              .filter(Boolean)
              .join(' · ') || 'Meaning not recorded'}
          </span>
        </div>
      </div>
      <dl className={styles.reviewFactList}>
        <div>
          <dt>Readings</dt>
          <dd>
            {readings.length
              ? readings
                  .map((item) => {
                    const reading = record(item);
                    return [text(reading.pinyin), text(reading.audioText)]
                      .filter(Boolean)
                      .join(' · ');
                  })
                  .filter(Boolean)
                  .join(', ')
              : 'Not recorded'}
          </dd>
        </div>
        <div>
          <dt>Word contexts</dt>
          <dd>
            {words.length
              ? words
                  .map((item) => {
                    const word = record(item);
                    return [
                      text(word.text),
                      text(word.pinyin),
                      text(word.english),
                    ]
                      .filter(Boolean)
                      .join(' · ');
                  })
                  .filter(Boolean)
                  .join('; ')
              : 'Not recorded'}
          </dd>
        </div>
        <div>
          <dt>Teaching</dt>
          <dd>
            {text(
              teaching.instructionEnglish,
              'No teaching instruction recorded.',
            )}
          </dd>
        </div>
      </dl>
      <details className={styles.reviewNestedDisclosure}>
        <summary>Hints, demonstration and provenance</summary>
        <pre>
          {pretty({
            hint: teaching.hintEnglish,
            demonstration: teaching.demonstrationEnglish,
            delayedReview: teaching.delayedReview,
            readings,
            meanings,
            wordAssociations: words,
            assets: character.assets,
          })}
        </pre>
      </details>
    </article>
  );
}

function PackageJsonList({
  values,
  empty,
}: {
  values: unknown[];
  empty: string;
}) {
  if (!values.length) return <p className={styles.smallPrint}>{empty}</p>;
  return (
    <div className={styles.reviewJsonList}>
      {values.map((value, index) => (
        <details key={index}>
          <summary>
            {text(
              record(value).stepId ||
                record(value).checkId ||
                record(value).assetId,
              `Record ${index + 1}`,
            )}
          </summary>
          <pre>{pretty(value)}</pre>
        </details>
      ))}
    </div>
  );
}

function ReviewHistory({ reviews }: { reviews: CurriculumReview[] }) {
  return (
    <section
      className={styles.reviewHistory}
      aria-labelledby="review-history-title"
    >
      <div className={styles.sectionHead}>
        <div>
          <h4 id="review-history-title">Review history</h4>
          <p className={styles.smallPrint}>
            Append-only decisions, in server sequence order.
          </p>
        </div>
        <ClipboardCheck size={20} color="var(--cs-teal)" aria-hidden="true" />
      </div>
      {reviews.length ? (
        <div className={styles.reviewHistoryList}>
          {[...reviews]
            .sort((left, right) => left.sequence - right.sequence)
            .map((review) => (
              <ReviewHistoryCard key={review.reviewId} review={review} />
            ))}
        </div>
      ) : (
        <p className={styles.smallPrint}>
          No review decision has been recorded.
        </p>
      )}
    </section>
  );
}

function ReviewHistoryCard({ review }: { review: CurriculumReview }) {
  return (
    <article className={styles.reviewHistoryCard}>
      <div className={styles.reviewHistoryTopline}>
        <div>
          <span className={styles.reviewSequence}>
            Review {review.sequence}
          </span>
          <h5>{decisionLabel(review.decision)}</h5>
        </div>
        <span
          className={styles.status}
          data-state={review.decision === 'approved' ? 'active' : 'inactive'}
        >
          {review.decision}
        </span>
      </div>
      <dl className={styles.reviewFactList}>
        <div>
          <dt>Reviewer reference</dt>
          <dd>{review.reviewerRef}</dd>
        </div>
        <div>
          <dt>Reviewed</dt>
          <dd>{formatTime(review.reviewedAt)}</dd>
        </div>
        <div>
          <dt>Recorded by</dt>
          <dd>{review.recordedBy}</dd>
        </div>
        <div>
          <dt>Recorded</dt>
          <dd>{formatTime(review.recordedAt)}</dd>
        </div>
        <div>
          <dt>Previous review</dt>
          <dd>{review.previousReviewId || 'First review'}</dd>
        </div>
        <div>
          <dt>Checklist</dt>
          <dd>{review.checklistVersion}</dd>
        </div>
      </dl>
      <div className={styles.reviewChecklistReadout}>
        {REVIEW_CHECKLIST.map(({ key, label }) => (
          <span key={key} data-complete={review.checklist[key] === true}>
            {review.checklist[key] === true ? '✓' : '○'} {label}
          </span>
        ))}
      </div>
      <div className={styles.reviewPrivateNotes}>
        <p>
          <strong>Evidence:</strong> {review.evidenceRef}
        </p>
        <p>
          <strong>Reason:</strong> {review.reason}
        </p>
      </div>
      {review.testFixture && (
        <p className={styles.smallPrint}>This saved event is a test fixture.</p>
      )}
    </article>
  );
}

function ReviewForm({
  snapshot,
  onDraft,
  onSubmit,
}: {
  snapshot: ReviewDeskSnapshot;
  onDraft: (draft: Partial<ReviewDraft>) => void;
  onSubmit: () => void;
}) {
  const draft = snapshot.draft;
  const disabled = snapshot.busy || !snapshot.detail || !draftComplete(draft);
  return (
    <section
      className={`${styles.surface} ${styles.surfacePad} ${styles.reviewForm}`}
    >
      <div className={styles.sectionHead}>
        <div>
          <p className={styles.eyebrow}>Operator action</p>
          <h3>Record review decision</h3>
          <p className={styles.smallPrint}>
            Enter what the reviewer actually checked. This records history; it
            does not release a lesson.
          </p>
        </div>
        <ShieldCheck size={22} color="var(--cs-blue)" aria-hidden="true" />
      </div>
      <div className={styles.reviewFormGrid}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Decision</span>
          <select
            className={styles.select}
            value={draft.decision}
            disabled={snapshot.busy}
            onChange={(event) =>
              onDraft({
                decision: event.target.value as ReviewDraft['decision'],
              })
            }
          >
            <option value="">Choose a decision</option>
            <option value="approved">Approved review decision</option>
            <option value="rejected">Rejected review decision</option>
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Reviewer reference</span>
          <input
            className={styles.input}
            value={draft.reviewerRef}
            disabled={snapshot.busy}
            onChange={(event) => onDraft({ reviewerRef: event.target.value })}
            maxLength={120}
            autoComplete="off"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Decision time (UTC)</span>
          <input
            className={styles.input}
            type="datetime-local"
            step="1"
            value={draft.reviewedAt}
            disabled={snapshot.busy}
            onChange={(event) => onDraft({ reviewedAt: event.target.value })}
            aria-describedby="review-time-help"
          />
          <span id="review-time-help" className={styles.formHint}>
            Enter the actual review time. It is not filled automatically.
          </span>
        </label>
        <label className={`${styles.field} ${styles.fullField}`}>
          <span className={styles.fieldLabel}>Evidence reference</span>
          <input
            className={styles.input}
            value={draft.evidenceRef}
            disabled={snapshot.busy}
            onChange={(event) => onDraft({ evidenceRef: event.target.value })}
            maxLength={240}
            autoComplete="off"
          />
        </label>
        <label className={`${styles.field} ${styles.fullField}`}>
          <span className={styles.fieldLabel}>Reason or correction note</span>
          <textarea
            className={styles.textarea}
            value={draft.reason}
            disabled={snapshot.busy}
            onChange={(event) => onDraft({ reason: event.target.value })}
            maxLength={240}
          />
        </label>
      </div>
      <fieldset className={styles.reviewChecklistFieldset}>
        <legend>Review checklist</legend>
        <div className={styles.reviewChecklistForm}>
          {REVIEW_CHECKLIST.map(({ key, label }) => (
            <label className={styles.reviewChecklistItem} key={key}>
              <input
                type="checkbox"
                checked={draft.checklist[key] === true}
                disabled={snapshot.busy}
                onChange={(event) =>
                  onDraft({
                    checklist: {
                      ...draft.checklist,
                      [key]: event.target.checked,
                    },
                  })
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className={styles.reviewFormFooter}>
        <p className={styles.formHint}>
          The package digest and latest predecessor come from the server. A
          correction appends a new review instead of editing history.
        </p>
        <button
          className={styles.primaryButton}
          type="button"
          onClick={onSubmit}
          disabled={disabled}
        >
          {snapshot.busy ? 'Saving…' : 'Record review decision'}{' '}
          <Check size={17} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
