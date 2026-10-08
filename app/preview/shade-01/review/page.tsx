import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { previewRuntime } from '@/lib/preview/runtime';
import manifest from '@/content/story/forest-01-v3.json';
import styles from '@/components/story/story.module.css';
export default function ShadeReviewPage() {
  if (!previewRuntime().previewMode) notFound();
  return (
    <article
      className={styles.story}
      lang="en"
      data-review-version="forest-01-v3"
    >
      <header className={styles.header}>
        <span className={styles.brand}>Little Hanzi</span>
        <span>Reviewer page · lesson not released</span>
      </header>
      <div className={styles.page}>
        <nav className={styles.toolbar}>
          <Link prefetch={false} href="/preview/shade-01">
            Back to the story preview
          </Link>
          <Link
            prefetch={false}
            target="_blank"
            href="/story/forest-01-v3/review-manifest.json"
            data-control="download-manifest"
          >
            Open exact JSON manifest
          </Link>
        </nav>
        <section className={styles.panel}>
          <p className={styles.overline}>Content, media and visual review</p>
          <h1>{manifest.title}</h1>
          <p>
            Version {manifest.lessonVersion} · adapter {manifest.adapter.id}.
            This is a saved preview story, not a published curriculum package.
          </p>
          <p className={styles.notice}>
            Human lesson, Mandarin/audio, physical-device and motion acceptance
            remain pending. Synthetic technical checks never populate these
            reviewer fields.
          </p>
          <p>
            Canonical digest:{' '}
            <code data-manifest-digest>{manifest.digest}</code>
          </p>
          <p>
            The digest uses recursive object-key sorting, preserved array order
            and UTF-8 JSON.stringify. It excludes only the top-level digest
            field.
          </p>
          <section className={styles.reviewItem}>
            <h2>Human review status</h2>
            <p>
              Status: pending · reviewer: not recorded · date: not recorded ·
              evidence: not recorded.
            </p>
            <ul>
              {manifest.reviewChecklist.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
          <section className={styles.reviewItem}>
            <h2>Audio transcripts and provenance</h2>
            <p>{manifest.audio.source}</p>
            <p>{manifest.audio.license}</p>
            <p>{manifest.audio.ordinaryEligibility}</p>
            <p>{manifest.audio.syntheticEligibility}</p>
            <ul>
              {manifest.audio.lines.map((line) => (
                <li key={line.id}>
                  <span lang="zh-Hans">{line.text}</span> · {line.review.status}
                </li>
              ))}
            </ul>
          </section>
          <section className={styles.reviewItem}>
            <h2>Accepted static model and candidate vector</h2>
            <p>
              The owner accepted the v6 static drawings on 26 September 2026.
              The editable vector and every animation are new candidates
              requiring review.
            </p>
            <Image
              unoptimized
              width={240}
              height={280}
              className={styles.reviewImage}
              src="/story/forest-01-v3/capybara-welcome-v6.png"
              alt="Unchanged accepted static v6 capybara reference"
            />
            <Image
              unoptimized
              width={240}
              height={280}
              className={styles.reviewImage}
              src="/story/forest-01-v3/mascot-layered.svg"
              alt="New editable v6-derived SVG review candidate"
            />
            <p>
              The rig simplifies the static reference’s painted shading and paw
              details. Inspect proportions, facial distinction, whiskers and
              limb contact at actual lesson size and motion extremes.
            </p>
            <ul>
              {manifest.performances.map((performance) => (
                <li key={performance.id}>
                  {performance.event}: {performance.description} ·{' '}
                  {performance.durationMs} ms · pending human review
                </li>
              ))}
            </ul>
          </section>
          <section className={styles.reviewItem}>
            <h2>Complete immutable review inventory</h2>
            <p>
              Exact draft lines, ordinary glyphs, inherited draft word
              associations, media sources, asset digests and nullable review
              fields appear below. No server scoring key is included.
            </p>
            <pre id="story-review-manifest" className={styles.manifest}>
              {JSON.stringify(manifest, null, 2)}
            </pre>
          </section>
        </section>
      </div>
    </article>
  );
}
