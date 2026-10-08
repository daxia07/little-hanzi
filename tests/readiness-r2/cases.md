# Independent R2 test plan

26 September 2026. Baseline `r2-spec-2` and frozen `r2-integration-1`, R2 (internal historical specification; not distributed)
and R1 retrospective (internal historical specification; not distributed). All scenarios
**NOT RUN**. Await frozen candidate; no current service may
be used. Expected version `forest-01-v3`, URL `/preview/shade-01`; the integration contract (internal historical specification; not distributed) settles media
eligibility, versioned audio timelines and persisted panel routes. Public selectors
and runtime identity/fault/readback handoff remain required.

Use real Node handler → HTTP → real local libSQL sqld → independent SQL readback.
No app-wide mocks, fake database or HTTP-success stub. Browser speech/media
boundary injection is declared separately from real asset/voice/listening review.
Synthetic credentials/token stay outside reports. New CDP contexts only; no
existing tabs, real family accounts or browser.close. Ordinary-mode guard checks
use a second runner-owned isolated server/database, never an active service.

## Identity and isolation before writes

Lead handoff includes spec/version/source/diff digest, temporary candidate snapshot,
runner-owned Node/sqld processes and persistence root, local explicit URLs, private
token delivery, ordinary guard URL, fresh synthetic fixtures, restart control,
read-only SQL query adapter, public controls and fault manifest. Verify snapshot
hashes and token-protected identity (candidate/run/storage marker) before mutations.
Reject wrong identity, non-loopback URLs, non-owned roots or remote bindings; never
fall back to family ports or `.wrangler/state`. Preserve failure artifacts; stop
only runner-owned processes through lead's declared lifecycle, never broad kills.

## HTTP scenarios

| ID | AC mapping | Actions / independent oracle |
| --- | --- | --- |
| R2-I01 | 001; S1-012/020/022 | Load v3 reviewer provenance/package; compare exact canonical/adapter/asset digests to frozen manifest. Exactly mu/lin targets and frozen word/read contexts; old v1 metadata/run interpretation unchanged. Missing review remains explicit; do not infer approval from present metadata |
| R2-I02 | 002; S1-002/004/012/016 | Complete new, both mixed, familiar and helped scripts from independent oracle; read HTTP and SQL events/projection/recap; first choices, attempts/help and unavailable stay separate; clean final4/0/0, helped1/2/1 using server-owned synthetic reviewed-speech fixtures only |
| R2-I03 | 002; S1-004 | Request help before first wrong: first wrong still retry; second wrong demonstrates. First error never erased by correction. Another question remains independent |
| R2-I04 | 004; S1-005/006 | One component cannot Continue; occupied/same-component placement rejected without partial write; two distinct slots complete. Find/read events separate from independent recognition; ordinary print returns |
| R2-I05 | 002/003; S1-012/013 | Same event/body replay after revision advances returns original ack, one SQL event; same ID different choice/step/revision conflicts409 and no mutation; browser must not roll back newer state on old ack |
| R2-I06 | 002; S1-014 | Two valid distinct actions at same revision in parallel produce one200/one409 STALE_REVISION, one event/revision increment. Invalid transition/malformed/forged correct field rejected; readback unchanged |
| R2-I07 | 002/003; S1-010/015 | Inject declared storage fault:503 no event/projection partial write, UI pending/not saved; same event retry after fault succeeds once. Lost response after real commit: replay same event after reload restores acknowledgement without duplicate |
| R2-I08 | 001/002; S1-010/011/020 | Save middle v3 run, restart only owned Node/sqld through control, read same revision/events. v1 and synthetic poc-1 records unchanged by v3 creation/progression/reset; reset only designated synthetic run |
| R2-I09 | 002; S1-018 | Complete initial; before24h review rejected, at24h permitted; delayed2/0/0 separate; changed positions vs corresponding final; clock override only selected synthetic run; no device-clock scheduling |
| R2-I10 | 001/003; S1-019/012 | No-store on run/actions/content-sensitive errors; test controls missing/wrong token403; foreign/legacy reset forbidden; outside test/preview mode routes404 and query/header flags cannot activate. Correct answers/scoring internals absent from learner projections/bundles |
| R2-I11 | 001/003 | Audio failure event timeline according to frozen v3 rule, missing/unreviewed source eligibility, replay not help, explicit unavailable no wrong count; never silently transfer R1 client grading/corrections to persistedv1 |

## Real browser → API → SQL scenarios

| ID | AC mapping | Action / required observation |
| --- | --- | --- |
| R2-B01–05 | 001/002/004 | Actual new/both mixed/familiar/helped UI journeys; no fixture auto-answer. UI final oracle + observed successful requests + SQL events agree. Familiar actual panel count shorter; opposite scenario instructions cannot override actual answers; no mastery claim |
| R2-B06 | 002/003 | Loaded welcome/focused/help/demo/completion/recap performances distinct at actual size, finite bounded rest without blocked controls; quiet familiarity/final/delayed suppress picture/prop/pinyin/transcript/gaze/face/position cues over whole learner view. Only requested help exposes clue |
| R2-B07 | 003 | Start → navigation/reset/scenario/quiet/reduced/mute cancels audio/acting; stale start/end/error callbacks cannot unlock next question or change departed evidence. V3 answer then current failure appends unavailable, blocks Continue until ack; unavailable cannot reopen; retain R1 adverse timeline coverage |
| R2-B08 | 003 | Declared speech/media errors: no voice, remote/Cantonese voice if fallback applies, required asset404, rejected playback, timeout; retry/continue unavailable. Unreviewed media never silently earns independent credit; real listening remains manual |
| R2-B09 | 003 | Layered SVG404, malformed SVG, static raster404: usable static/text fallback and unchanged scoring. Quiet remains cue free while load success/failure arrives late |
| R2-B10 | 002/003 | Save in progress, fresh context resume/reload; first answer/help preserved. Drop response after actual action commit via route.fetch then abort fulfilment; queue pending and retry same ID; SQL one event; browser never falsely says Saved before ack |
| R2-B11 | 002/003 | Storage denied for browser outbox, server503, stale revision concurrent tab, repeated Retry/Continue and lost response; useful recovery/no partial duplicate; browser storage limitation explicitly labelled. Only synthetic owned tabs/context |
| R2-B12 | 004/005 | Complete keyboard-only journey from initial sound/welcome through components/choices/options/recap; Tab/Enter/Space and focus outlines; no drag requirement; 40-character unbroken labels where supported |
| R2-B13 | 003/005 | Desktop/tablet portrait+landscape/phone when supported: actual essential hit areas≥44×44 (radio/checkbox associated label); focused skip link measured after focus; no clipped controls/overflow. Text4.5:1/control-focus3:1 measured from declared actual pairs |
| R2-B14 | 003/005 | Teaching/check/recap at200% CSS layout zoom, exact method recorded; OS initial/live plus local reduced motion. Observe actual preference event delivery before cancellation assertion; emulation not physical iPad |
| R2-B15 | 001/002/003 | Visit preserved v1 preview and existing six-character route using synthetic state; frozen old lesson/art unchanged. Production-mode preview/test guards denied on owned ordinary server, never real deployment |

Every report identifies exact candidate/runtime/libSQL version, processes/storage,
commands, injected faults, PASS/FAIL/BLOCKED/NOT RUN per scenario/AC, executed HTTP
responses/SQL evidence and captures. Screenshots: welcome/teaching/build/quiet/recap
in tablet orientations. Human Mandarin/asset provenance/audio quality, v6 fidelity,
physical touch/sound, learner observation and owner acceptance stay pending.

## Clarifications resolved by r2-integration-1

1. Server-owned synthetic namespace sets soundReview=synthetic; ordinary V3 stays
   pending. Pending sound-dependent answers reject409 INVALID_TRANSITION and allow
   only unavailable completion. Test4/0/0 is technical synthetic evidence, not human
   audio review. Browser cannot forge media acceptance in create/actions.
2. V3 audio-unavailable appends after answer/demonstration while current, preserves
   answer facts and wins classification; repeated distinct unavailable invalid,
   duplicate same envelope idempotent. UI serializes behind pending answer and
   blocks Continue until unavailable ack; stale previous-question failure rejected.
   Committed unavailable never reopens. V1 historical open-only rule unchanged.
3. V3 persists learn-mu then learn-lin for new/mixed, one reminder for familiar;
   refresh must resume exact panel. Only V3 gets learnPanel/soundReview; V1 JSON
   unchanged. V3 client rejects V1 run without mutation/deletion.
4. Root will supply ordinary guard instance, owned restart and independent SQL
   inspection for real Node/libSQL. Exact handoff remains pending, not evidence.

Additional frozen-contract cases: ordinary media pending cannot earn independent
credit despite successful injected speech; malicious soundReview payload rejected;
answer→current error leaves two append-only facts and unavailable outcome; retry
after committed unavailable never reopens; Continue before correction saved is
blocked; old callbacks after question navigation cannot mutate previous events.
Reopen both learn-mu/learn-lin and combined reminder; content manifest digest uses
sorted object keys with array order retained and excludes own digest. Retain V2
curriculum package bytes/adapter identity and V1 version default for historical
callers. Pilot preview disablement gets an explicit guard configuration check.

Additional I01 wire slice: V3 feedback retains run/version and exact replay,
conflicting same-ID content fails, ordinary namespace cannot target the synthetic
run. A clearly labelled synthetic decision retains version/current candidate and
synthetic=true; mismatched candidate and unknown version fail. Ordinary V3
decision stays draft, V1 feedback/run/decision readback remains unchanged. NOT RUN.

Executed final candidate readiness-r2-44fae355c1ab: independent HTTP16/16 PASS;
browser35 distinct cases PASS, including explicit mute readiness/cancellation.
Two initial recovery failures were harness interactions corrected against frozen
contract (open disclosure; explicit retry), retained separately. Full scenario/
AC evidence and remaining human/runtime limits are in active runtime report.md
under outputs/qa/readiness-r2/2026-09-26T13-38-56-482Z-44fae355/.
