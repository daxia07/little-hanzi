# 小小汉字 · Little Hanzi

An open-source Chinese literacy prototype for children learning simplified characters, Hanyu Pinyin and handwriting. Designed for parent-guided practice on an iPad, with large touch controls and separate progress records for different skills.

## Included

- Six characters: 一、二、三、大、小、人.
- Listen/read, guided or covered-model finger writing, and pinyin letter/tone entry.
- Stroke demonstrations and resumable practice using Hanzi Writer.
- A short untimed recognition/pinyin quiz, recording first answers and help separately.
- Parent-controlled character selection and one to three characters per lesson.
- Local server-side SQLite/D1 progress, browser draft/outbox recovery, and JSON backup import/export.
- A proposed [character-library roadmap through age 12](docs/hanzi-plan-to-age-12.md).

Finger-writing results describe the screen task. Paper handwriting and reading comprehension require separate checks.

## Quick start

Use Node.js 22.13 or newer (tested with 22.22.3) and npm.

```sh
npm ci
npm run dev -- --hostname 0.0.0.0 --port 4173
```

Open `http://localhost:4173` on the host. On an iPad on the same network, open `http://<host-LAN-IP>:4173`.

For the built app:

```sh
npm run build
npm run serve
```

The built server exposes port 4173 and forwards to a local worker on loopback port 4175. Keep the process running while using the app. To use different ports:

```sh
HANZI_PORT=4183 HANZI_BACKEND_PORT=4185 npm run serve
```

This prototype uses one shared family profile and has no sign-in or access control. Run it on a trusted local network; publishing the source does not deploy a public learning-data service.

## Pronunciation

The public build uses the browser/device's Mandarin speech synthesis. Voice availability and quality depend on the device. No speech API key or redistributed voice recording is required.

Optional, appropriately licensed recordings may be placed in `public/audio/` using the keys in `lib/audio.ts` as `.m4a` filenames. Set `NEXT_PUBLIC_LOCAL_AUDIO=1` in an ignored `.env.local` before running the development server or building. Existing private household recordings are deliberately excluded from Git. See [third-party notices](THIRD_PARTY.md).

`NEXT_PUBLIC_SITE_URL` optionally configures the absolute base URL for preview metadata. `.env.example` contains safe defaults. Public environment variables are embedded in browser code; never put secrets in them.

## Progress and backups

Authoritative local records live under `.wrangler/state/`. Preserve this directory across builds, moves and restarts. Export progress from the parent screen for a portable JSON backup. Runtime databases, recordings, logs and local handoff notes are ignored by Git.

The API initializes missing tables for a fresh checkout. `db/schema.ts` and `db/migrations/` retain the schema. `qa-*` profiles hold isolated test records and do not appear in the family interface.

## Checks

```sh
npm run typecheck
npm test
npm run lint
npm run build
```

With the app running, the HTTP integration check writes only isolated QA profiles:

```sh
HANZI_BASE_URL=http://localhost:4173 python3 tests/lan_smoke.py
```

For a private installation containing the original recordings, add `HANZI_LOCAL_AUDIO=1`. `HANZI_REQUIRE_RESTART_PROBE=1` additionally checks an existing deployment's named persistence probe; omit it for a new checkout.

Browser smoke checks covered the lesson, writing pad, parent view and saving at a tablet-sized viewport. Physical iPad touch accuracy, rotation/interruption and audio quality still need device testing. The HTTP LAN version requires its server/network and does not provide offline installation or microphone scoring.

## Licence

Application code and original teaching text: [MIT](LICENSE). Vendored character data: separate Arphic Public License. See [THIRD_PARTY.md](THIRD_PARTY.md) for sources and notices.
