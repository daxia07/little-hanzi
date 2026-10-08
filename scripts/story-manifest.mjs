import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import {
  storyReviewLines,
  STORY_COPY,
  STORY_LABELS,
  STORY_READERS,
  STORY_WORDS,
} from '../lib/story-presentation.ts';
const pending = () => ({
  status: 'pending',
  reviewer: null,
  date: null,
  evidence: null,
});
const reviewLines = storyReviewLines();
const sourceFiles = [
  'components/story/StoryLesson.tsx',
  'components/story/StoryView.tsx',
  'components/story/StoryCompanion.tsx',
  'components/story/StoryScene.tsx',
  'components/story/PreviewStory.tsx',
  'components/story/story.module.css',
  'lib/story-presentation.ts',
  'lib/story-audio.ts',
];
const sourceDigests = [];
const english = new Set(reviewLines.english);
for (const file of sourceFiles) {
  const source = await readFile(file, 'utf8');
  sourceDigests.push({
    file,
    sha256: createHash('sha256').update(source).digest('hex'),
  });
  if (!file.endsWith('.tsx')) continue;
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  function visit(node) {
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, ' ').trim();
      if (/[A-Za-z]/.test(text) && text.length > 2) english.add(text);
    } else if (
      ts.isStringLiteral(node) &&
      /^[A-Z]/.test(node.text) &&
      /[a-z]/.test(node.text) &&
      node.text.length > 3
    )
      english.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
for (const text of [
  'Listen to option 1',
  'Listen to option 2',
  'Listen to option 3',
  'Choose option 1',
  'Choose option 2',
  'Choose option 3',
  'Hear wood word',
  'Hear grove word',
  'Put tree 1 left',
  'Put tree 1 right',
  'Put tree 2 left',
  'Put tree 2 right',
  'Find 木 for our reading spot.',
  'Find 林 for our reading spot.',
  'This means: This is wood.',
  'This means: A little bird lives in the woods.',
])
  english.add(text);
const assets = [];
for (const [id, file, kind, source, license] of [
  [
    'capybara-static-v6',
    'public/story/forest-01-v3/capybara-welcome-v6.png',
    'image',
    'Unchanged accepted capybara v6 static master; docs/design/assets/capybara-concept-v6.md',
    'Project-generated illustration; source/licensing review distinct from static visual decision',
  ],
  [
    'capybara-rig-v3',
    'public/story/forest-01-v3/mascot-layered.svg',
    'editable-vector',
    'Original R1 v6-derived rig adapted with focused/Aha/Delighted face layers',
    'Project-authored vector; no stock asset',
  ],
  [
    'capybara-controller-v3',
    'public/story/forest-01-v3/mascot.mjs',
    'performance-controller',
    'Original R1 controller copied/adapted into versioned V3 public directory',
    'Project-authored code',
  ],
  [
    'story-scene-v3',
    'components/story/StoryScene.tsx',
    'illustration-source',
    'Original solid-fill SVG wood/book illustration',
    'Project-authored vector/code',
  ],
  [
    'story-presentation-v3',
    'lib/story-presentation.ts',
    'teaching-source',
    'Project-authored browser-safe display metadata from frozen S1/R2; no scoring oracle',
    'Project-authored draft text/code',
  ],
  [
    'story-style-v3',
    'components/story/story.module.css',
    'presentation-source',
    'Cloudstep Clear ascent tokens and scoped story layout',
    'Project-authored CSS',
  ],
]) {
  assets.push({
    id,
    version: 'forest-01-v3-assets-1',
    kind,
    file,
    url: file.startsWith('public/') ? file.slice(6) : null,
    sha256: createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
    source,
    license,
    reviewChecklistVersion: 'readiness-r2-review-1',
    review:
      id === 'capybara-static-v6'
        ? {
            status: 'accepted-static-direction',
            reviewer: 'Owner',
            date: '2026-09-26',
            evidence:
              'docs/design/assets/capybara-concept-v6.md#owner-visual-decision',
          }
        : pending(),
  });
}
const v2 = JSON.parse(
  await readFile('content/curriculum/forest-01-v2.json', 'utf8'),
);
const manifest = {
  lessonId: 'forest-01',
  lessonVersion: 'forest-01-v3',
  title: STORY_COPY.title,
  canonicalizationVersion: 'r2-json-sorted-1',
  adapter: {
    id: 'forest-story-preview-v1',
    version: '1',
    scope: 'Saved preview story; not a published generic curriculum package',
  },
  specVersion: 'r2-spec-2',
  integrationVersion: 'r2-integration-1',
  reviewChecklistVersion: 'readiness-r2-review-1',
  targets: ['木', '林'],
  humanReview: pending(),
  releaseStatus: 'not released',
  teaching: {
    english: [...english]
      .sort()
      .map((text, i) => ({
        id: `english-${String(i + 1).padStart(3, '0')}`,
        version: STORY_VERSION(),
        text,
        source:
          'Project-authored guidance/control/status text; original draft for review',
        license: 'Project-authored text',
        review: pending(),
      })),
    words: Object.entries(STORY_WORDS).map(([id, w]) => ({
      id,
      text: w.word,
      meaning: w.meaning,
      review: pending(),
    })),
    questions: reviewLines.questions.map((q) => ({ ...q, review: pending() })),
    readers: Object.entries(STORY_READERS).map(([id, r]) => ({
      id,
      text: r.text,
      meaning: r.meaning,
      support: 'Untaught text narrated; no whole-sentence independent claim',
      review: pending(),
    })),
    additionalAssociations: v2.characters.map((c) => ({
      target: c.hanzi,
      sourceVersion: 'forest-01-v2',
      status: 'inherited draft; not extra lesson targets',
      words: c.wordAssociations.map((w) => ({
        text: w.text,
        meaning: w.english,
        context: w.context,
        provenance: w.provenance,
        review: pending(),
      })),
    })),
  },
  audio: {
    source:
      'LocalService=true Mandarin browser/device speech; prefer Tingting then local matching default/first',
    license:
      'Platform-provided local voice; no recording stored or recording license claimed',
    ordinaryEligibility:
      'Pending attributed review; sound-dependent ordinary answers remain unavailable',
    syntheticEligibility:
      'Server-owned nonempty test namespace only; synthetic technical grading, not human acceptance',
    timeoutMs: 10000,
    lines: reviewLines.audio.map((text, i) => ({
      id: `speech-${i + 1}`,
      version: STORY_VERSION(),
      text,
      review: pending(),
    })),
  },
  glyphs: [
    ...new Set(
      Object.values(STORY_LABELS).join('') +
        Object.values(STORY_READERS)
          .map((r) => r.text)
          .join('') +
        Object.values(STORY_WORDS)
          .map((w) => w.word)
          .join(''),
    ),
  ]
    .filter((ch) => /\p{Script=Han}/u.test(ch))
    .map((character) => ({
      id: `glyph-${character.codePointAt(0).toString(16)}`,
      character,
      unicode: `U+${character.codePointAt(0).toString(16).toUpperCase()}`,
      source: 'Unicode ideograph rendered in ordinary platform CJK fonts',
      license: 'Unicode data / platform font licensing; no downloaded font',
      review: pending(),
    })),
  assets,
  sourceDigests,
  performances: [
    [
      'welcome',
      'Welcome',
      'Open greeting, separate arm wave and head/brow/eye acting',
      1400,
    ],
    [
      'focused',
      'Teaching',
      'Gentle downward eyes and closed mouth; small arm orientation/head tilt',
      1200,
    ],
    [
      'encourage',
      'First difficulty / requested help',
      'Reassuring wink/closed smile and arm lift; suppressed throughout independent checks',
      1500,
    ],
    [
      'hint',
      'Requested teaching clue',
      'Curious gaze and mouth with separate arm gesture',
      1600,
    ],
    [
      'aha',
      'Completed activity',
      'Bright open grin and separate arms; no learning controls wait',
      1450,
    ],
    [
      'delighted',
      'Recap',
      'Joyful eye arcs and laughing mouth, separate arms, finite rest',
      1500,
    ],
  ].map(([id, event, description, durationMs]) => ({
    id,
    version: 'forest-01-v3-rig-1',
    event,
    description,
    durationMs,
    layers: ['head', 'arm-left', 'arm-right', 'brows', 'eyes', `mouth-${id}`],
    source:
      'Original editable versioned SVG/WAAPI candidate based on accepted v6 static art',
    license: 'Project-authored animation',
    review: pending(),
  })),
  quietPolicy:
    'No companion, pictures, teaching annotations, pinyin, transcript or answer key before help/submission; ordinary print and rotated neutral audio-option labels only',
  limitations: [
    'All Mandarin/teaching text/audio awaiting attributed review',
    'New vector/motion unaccepted; accepted static v6 only',
    'No reviewed stored audio is available',
    'No physical iPad listening or child usability evidence',
    'Synthetic test outcomes cannot grant release',
  ],
  reviewChecklist: [
    'Every spoken line and word reading listened to on exact candidate',
    'Reader sentences and meanings checked by attributed Mandarin reviewer',
    'Every glyph rendered in ordinary print',
    'All motion extremes retain two arms/two grounded feet and 2+2 whiskers',
    'Actual lesson-size friendliness and expression distinction judged',
    'Physical tablet listening/touch/text scaling checked',
    'Exact owner lesson/art decision recorded separately',
  ],
};
function STORY_VERSION() {
  return 'forest-01-v3';
}
function sort(v) {
  return v && typeof v === 'object'
    ? Array.isArray(v)
      ? v.map(sort)
      : Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sort(v[k])]),
        )
    : v;
}
manifest.digest = `sha256:${createHash('sha256')
  .update(JSON.stringify(sort(manifest)))
  .digest('hex')}`;
const json = JSON.stringify(manifest, null, 2) + '\n';
await writeFile('content/story/forest-01-v3.json', json);
await writeFile('public/story/forest-01-v3/review-manifest.json', json);
console.log(manifest.digest);
