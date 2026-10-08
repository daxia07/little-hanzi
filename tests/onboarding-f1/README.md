# F1 onboarding QA

This suite is independent QA for the focused Parent and Learner first story. It
owns only this directory and the matching evidence directory
`outputs/qa/onboarding-f1`.

The suite consumes a private `readiness-story-node-runner` handoff at runtime:

```sh
HANZI_F1_HANDOFF=/private/path/to/handoff.json \
  HANZI_F1_OUTPUT=outputs/qa/onboarding-f1 \
  npx playwright test --config tests/onboarding-f1/playwright.config.ts
```

The handoff must describe an owned, fresh candidate. The credentials file is
read only by the test process. Credentials, cookies, control tokens and
private paths are never included in test messages, screenshots or reports.
The candidate controls and runner logs remain owned by the lead.

The HTTP scenarios use real authenticated requests and the candidate's real
database. The browser scenarios use an injected speech adapter only at the
browser speech boundary. The injection reports `onstart` before the parent can
confirm that sound was heard; it does not grant content review, approval or
learning credit.

The browser suite is intended to run with the owned Chrome endpoint when one is
available. If Playwright cannot launch or connect to a browser, the result is
`BLOCKED`/`NOT RUN`; no browser acceptance is claimed.

## Covered F1 outcomes

| ID | Coverage | Evidence |
| --- | --- | --- |
| F1-001 | Focused parent/child story route and no competing curriculum/operator panels | browser DOM assertions and screenshots |
| F1-002 | Linked child and `unsure`/unanswered sound defaults; `onstart`, explicit confirmation and unavailable fallback | browser request/readback assertions |
| F1-003 | Setup save, current proposal, approval, sign-out/handover and role boundaries | real HTTP and browser journey |
| F1-004 | Child start, reload/resume, finish, duplicate/lost action identity and parent recap | real HTTP readback plus browser journey |
| F1-005 | Keyboard/touch-sized controls, reduced motion and review screenshots | browser checks when a supported browser is available |

Synthetic publication and injected speech are technical fixtures. They do not
constitute Mandarin, physical tablet, owner or release acceptance.
