import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectOwnedChrome } from '../../scripts/owned-cdp.mjs';
export async function createBrowserAdapter(h, http, output, lessonVersion) {
  const privateData = JSON.parse(await readFile(h.credentialsFile, 'utf8'));
  const connection = await connectOwnedChrome(h.cdpURL);
  let context;
  try {
    context = await connection.browser.newContext({
      viewport: { width: 820, height: 1180 },
    });
    context.setDefaultTimeout(15000);
    await context.addInitScript(() => {
      window.SpeechSynthesisUtterance = class {
        constructor(text) {
          this.text = text;
        }
      };
      let current;
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          getVoices: () => [
            { name: 'Tingting', lang: 'zh-CN', localService: true },
          ],
          cancel: () => {
            current = null;
          },
          speak: (u) => {
            current = u;
            queueMicrotask(() => {
              if (current === u) {
                u.onstart?.({});
                setTimeout(() => {
                  if (current === u) u.onend?.({});
                }, 30);
              }
            });
          },
        },
      });
    });
    const page = await context.newPage(),
      native = await context.newCDPSession(page),
      info = (await native.send('Target.getTargetInfo')).targetInfo;
    assert(info.browserContextId && info.targetId);
    await writeFile(
      path.join(output, 'owned-browser-ids.json'),
      JSON.stringify(
        { browserContextId: info.browserContextId, targetId: info.targetId },
        null,
        2,
      ) + '\n',
    );
    await native.detach();
    const controls = {
      collectionChild:
        '[data-role=collection-plan] [data-control=collection-child]',
      collectionLesson:
        '[data-role=collection-plan] [data-control=collection-lesson-select]',
      collectionPropose:
        '[data-role=collection-plan] [data-control=collection-propose]',
      proposalReady:
        '[data-role=collection-plan] [data-proposal-id][data-source-digest]',
      collectionApprove:
        '[data-role=collection-plan] [data-control=collection-approve]',
      planReady: '[data-role=collection-plan] [data-plan-id]',
      practiceReady: '[data-role=collection-home][data-ready=true]',
      scheduleStart:
        '[data-role=collection-home] [data-phase={phase}][data-schedule-id="{scheduleId}"] [data-control=collection-start]',
      runSaved: '[data-role=collection-run][data-save-state=saved]',
      cue: '[data-role=collection-run] [data-control=collection-listen]',
      audioStarted:
        '[data-role=collection-run][data-audio-status=playing], [data-role=collection-run][data-audio-status=ended]',
      choice:
        '[data-role=collection-run] [data-control=collection-answer][data-choice-id="{choiceId}"]',
      continue: '[data-role=collection-run] [data-control=collection-next]',
    };
    let actor;
    async function signInThroughUI(who) {
      if (actor) {
        await page
          .getByRole('button', { name: 'Sign out', exact: true })
          .click();
        await page
          .getByRole('heading', { name: 'Sign in', exact: true })
          .waitFor();
      }
      await page.goto(h.baseURL);
      const a = privateData.accounts.find((a) => a.id === who.id);
      assert(a);
      await page.getByLabel('Username', { exact: true }).fill(a.username);
      await page.getByLabel('Password', { exact: true }).fill(a.password);
      for (let attempt = 0; attempt < 3; attempt++) {
        const pending = page.waitForResponse(
          (r) => new URL(r.url()).pathname === '/api/auth/sign-in/username',
        );
        await page
          .getByRole('button', { name: 'Sign in', exact: true })
          .click();
        const response = await pending;
        if (response.status() === 429) {
          await new Promise((r) => setTimeout(r, 61000));
          continue;
        }
        assert.equal(response.status(), 200);
        actor = who;
        return;
      }
      throw Error('Ordinary browser auth exhausted');
    }
    return {
      page,
      publicControls: controls,
      lessonVersion,
      recordResults: http.recordResults,
      familyFixture: http.familyFixture,
      nextInitial: async (child, version, planId, parent) => {
        const planResponse = await http.request(
          parent,
          'GET',
          '/api/pilot/children/' +
            child.id +
            '/plan?collectionVersion=' +
            encodeURIComponent(h.collection.collectionVersion),
        );
        assert.equal(planResponse.status, 200);
        const plan = [
          planResponse.body.plan,
          ...planResponse.body.history,
        ].find((p) => p?.planId === planId);
        assert(plan && plan.items.length === 1);
        const assignmentId = plan.items[0].assignmentId;
        assert(assignmentId);
        const response = await http.request(
          child,
          'GET',
          '/api/pilot/children/' +
            child.id +
            '/practice?collectionVersion=' +
            encodeURIComponent(h.collection.collectionVersion),
        );
        assert.equal(response.status, 200);
        const item = response.body.items.find(
          (i) =>
            i.kind === 'initial' &&
            i.assignmentId === assignmentId &&
            i.lessonVersion === version &&
            !i.runId &&
            i.available,
        );
        assert(item);
        return item;
      },
      signInThroughUI,
      recordOwnedBrowserIds: async () => {},
      readActiveRun: async () => {
        const id = await page
          .locator('[data-role=collection-run]')
          .getAttribute('data-run-id');
        assert(id);
        const response = await http.request(
          actor,
          'GET',
          '/api/pilot/curriculum/learning-runs/' + id,
        );
        assert.equal(response.status, 200);
        return response.body;
      },
      captureAccessibleView: async (label) => {
        await page
          .locator('[data-role=collection-run]')
          .screenshot({ path: path.join(output, label + '.png') });
      },
      cleanup: async () => {
        await context.close();
        connection.disconnect();
        await writeFile(
          path.join(output, 'browser-cleanup.json'),
          JSON.stringify({
            ownedContextClosed: true,
            disconnected: true,
            adoptedExistingTargets: connection.metadata.adoptedExistingTargets,
          }) + '\n',
        );
      },
    };
  } catch (error) {
    if (context) await context.close();
    connection.disconnect();
    await writeFile(
      path.join(output, 'browser-partial-cleanup.json'),
      JSON.stringify({ ownedContextClosed: !!context, disconnected: true }) +
        '\n',
    );
    throw error;
  }
}
