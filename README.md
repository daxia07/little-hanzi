# Little Hanzi

An English-guided Mandarin character-learning application with saved practice,
parent reporting and a paired-story curriculum renderer.

This source-transfer branch preserves the existing public repository history and
exports the locally validated continuation without its private task notes, account
metadata, learner data, recordings or internal QA logs. It does not deploy or
approve a lesson. Synthetic test personas use generic names.

## Current content status

The starter corpus v3 contains **100 distinct draft targets in 50 paired lessons**.
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
node --experimental-strip-types scripts/build-everyday-draft.mjs --check
```

Node builds support source validation without private deployment metadata. A
Cloudflare Worker build intentionally requires independently configured hosting
metadata; this export supplies no production binding or credentials. Configure
local environment variables from `.env.example` and keep real data outside source.

Code is MIT-licensed. CC-CEDICT-derived lexical facts/curriculum adaptations and
stroke data retain their separate licenses; see `THIRD_PARTY.md` and item evidence.
