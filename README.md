# Little Hanzi

An English-guided Mandarin character-learning application with saved practice,
parent reporting and a paired-story curriculum renderer.

This source-transfer branch preserves the existing public repository history and
exports the locally validated continuation without its private task notes, account
metadata, learner data, recordings or internal QA logs. It does not deploy or
approve a lesson. Synthetic test personas use generic names.

## Current content status

The starter corpus v5 contains **400 distinct draft targets in 200 paired lessons**.
All remain unreviewed and unreleased. Mandarin content review, actual licensed
audio and listening/device acceptance, ordinary hosted flow and version-specific
owner/recovery evidence remain necessary. No recorded audio is included. Pending
scripts and their exact cue/digest consumers are in `content/authoring/`.

## Local validation

Use Node >=22.13 and the pinned lockfile:

```sh
npm ci
npm test
npm run typecheck
npm run build:node
node --experimental-strip-types scripts/build-expansion-draft.mjs --check
# For exact source reproduction, supply the pinned CC-CEDICT gzip archive:
# node scripts/author-expansion-draft.mjs --archive PATH_TO_PINNED_ARCHIVE --check
```

Node builds support source validation without private deployment metadata. A
Cloudflare Worker build intentionally requires independently configured hosting
metadata; this export supplies no production binding or credentials. Configure
local environment variables from `.env.example` and keep real data outside source.

Code is MIT-licensed. CC-CEDICT-derived lexical facts/curriculum adaptations and
stroke data retain their separate licenses; see `THIRD_PARTY.md` and item evidence.

This 400-draft branch adds to the preserved 100-draft source commit `4b3b57dca225d74edfabca1c7f2091e4eb532c5f`. The earlier 100-draft branch and labels remain unchanged. No private continuation history is transferred.
