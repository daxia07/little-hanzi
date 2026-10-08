import { expect, test } from '@playwright/test';

import {
  account,
  close,
  getJson,
  loadHandoff,
  noStore,
  sendJson,
  signIn,
  type F1Handoff,
  type F1Session,
} from './support';

test.describe.configure({ mode: 'serial' });

let handoff: F1Handoff;

test.beforeAll(() => {
  handoff = loadHandoff();
});

type StoryProposal = {
  proposalId: string;
  sourceDigest: string;
};

type ApprovedPlan = {
  planId: string;
  available: boolean;
  items?: Array<{
    lessonVersion?: string;
    contentDigest?: string;
    available?: boolean;
    assignmentId?: string;
  }>;
};

async function saveAndApprove(
  parent: F1Session,
  child: ReturnType<typeof account>,
  nickname = child.name,
) {
  const setup = await sendJson(
    parent,
    'PUT',
    `/api/pilot/children/${encodeURIComponent(child.id)}/onboarding`,
    { nickname, experience: 'unsure', audioReady: false },
  );
  expect(setup.response.status()).toBe(200);
  noStore(setup.response);
  expect(setup.body.onboarding).toMatchObject({
    nickname,
    experience: 'unsure',
    audioReady: false,
  });

  const proposal = await sendJson(
    parent,
    'POST',
    `/api/pilot/children/${encodeURIComponent(child.id)}/placement/proposals`,
    { lessonVersion: handoff.lessonVersion },
  );
  expect(proposal.response.status()).toBe(200);
  noStore(proposal.response);
  expect(proposal.body.proposal).toMatchObject({
    childId: child.id,
    lessonVersion: handoff.lessonVersion,
    contentDigest: handoff.contentDigest,
  });
  const currentProposal = proposal.body.proposal as StoryProposal;

  const approval = await sendJson(
    parent,
    'POST',
    `/api/pilot/children/${encodeURIComponent(child.id)}/placement/approve`,
    {
      proposalId: currentProposal.proposalId,
      sourceDigest: currentProposal.sourceDigest,
    },
  );
  expect(approval.response.status()).toBe(200);
  noStore(approval.response);
  expect(approval.body.plan).toMatchObject({
    childId: child.id,
    available: true,
  });
  const approvedPlan = approval.body.plan as ApprovedPlan;
  const item = approvedPlan.items?.[0];
  expect(item).toMatchObject({
    lessonVersion: handoff.lessonVersion,
    contentDigest: handoff.contentDigest,
    available: true,
  });
  expect(typeof item?.assignmentId).toBe('string');
  return {
    proposal: currentProposal,
    plan: approvedPlan,
    assignmentId: item?.assignmentId as string,
  };
}

type StoryRun = {
  runId: string;
  revision: number;
  available: boolean;
  state: {
    stepId: string;
    questionStatus: string | null;
    questionId: string | null;
    placedComponents: { left: string | null; right: string | null };
  };
  question: { choices: Array<{ id: string }> } | null;
  recap: Record<string, unknown>;
};

type StoryActionRecord = {
  eventId: string;
  expectedRevision: number;
  stepId: string;
  type: string;
  payload: Record<string, unknown>;
  ack: StoryAck;
};

type StoryAck = {
  eventId: string;
  lessonVersion: string;
  state: StoryRun['state'];
  revision: number;
  result: Record<string, unknown>;
};

async function storyRun(child: F1Session, runId: string): Promise<StoryRun> {
  const result = await getJson(
    child,
    `/api/pilot/curriculum/learning-runs/${encodeURIComponent(runId)}`,
  );
  expect(result.response.status()).toBe(200);
  noStore(result.response);
  return result.body as StoryRun;
}

async function storyAction(
  child: F1Session,
  run: StoryRun,
  eventId: string,
  type: string,
  payload: Record<string, unknown> = {},
  expectedRevision = run.revision,
  stepId = run.state.stepId,
) {
  const result = await sendJson(
    child,
    'POST',
    `/api/pilot/curriculum/learning-runs/${encodeURIComponent(run.runId)}/actions`,
    {
      eventId,
      expectedRevision,
      stepId,
      type,
      payload,
    },
  );
  return result;
}

async function finishSyntheticStory(child: F1Session, run: StoryRun) {
  let current = run;
  let firstAction: StoryActionRecord | null = null;
  for (let index = 0; index < 100 && current.state.stepId !== 'recap'; index++) {
    let type = 'continue';
    let payload: Record<string, unknown> = {};
    if (current.state.stepId === 'build') {
      const placed = current.state.placedComponents;
      if (!placed.left)
        [type, payload] = [
          'place-component',
          { componentId: 'mu-a', slot: 'left' },
        ];
      else if (!placed.right)
        [type, payload] = [
          'place-component',
          { componentId: 'mu-b', slot: 'right' },
        ];
    } else if (
      current.question &&
      current.state.questionStatus === 'open'
    ) {
      type = 'answer';
      payload = {
        questionId: current.state.questionId,
        choiceId: current.question.choices[0]?.id,
      };
    }
    const eventId = `f1-http-${current.runId}-${String(index).padStart(3, '0')}`;
    const result = await storyAction(child, current, eventId, type, payload);
    expect(result.response.status(), `${type} action`).toBe(200);
    noStore(result.response);
    if (!firstAction) {
      const ack = result.body.ack as StoryAck;
      expect(ack).toMatchObject({
        eventId,
        lessonVersion: handoff.lessonVersion,
        revision: current.revision + 1,
      });
      firstAction = {
        eventId,
        expectedRevision: current.revision,
        stepId: current.state.stepId,
        type,
        payload,
        ack,
      };
    }
    current = await storyRun(child, current.runId);
  }
  expect(current.state.stepId).toBe('recap');
  return { run: current, firstAction: firstAction! };
}

test('[F1-003][F1-004] parent saves unsure setup, approves one story, and child owns the run', async () => {
  const parent = await signIn(handoff, account(handoff, 'parent-a'), 'parent');
  const childAccount = account(handoff, 'child-a');
  let child: F1Session | undefined;
  try {
    const initialSetup = await getJson(
      parent,
      `/api/pilot/children/${encodeURIComponent(childAccount.id)}/onboarding`,
    );
    expect(initialSetup.response.status()).toBe(200);
    noStore(initialSetup.response);
    expect(initialSetup.body.onboarding).toBeNull();

    const initialPlacement = await getJson(
      parent,
      `/api/pilot/children/${encodeURIComponent(childAccount.id)}/placement`,
    );
    expect(initialPlacement.response.status()).toBe(200);
    expect(initialPlacement.body).toMatchObject({
      setupComplete: false,
      proposal: null,
    });

    const approved = await saveAndApprove(parent, childAccount);
    const plan = await getJson(
      parent,
      `/api/pilot/children/${encodeURIComponent(childAccount.id)}/plan`,
    );
    expect(plan.response.status()).toBe(200);
    noStore(plan.response);
    expect(plan.body.plan).toMatchObject({
      planId: approved.plan.planId,
      available: true,
    });

    const parentStart = await sendJson(
      parent,
      'POST',
      `/api/pilot/curriculum/assignments/${encodeURIComponent(approved.assignmentId)}/start`,
      { requestId: 'f1-parent-must-not-start' },
    );
    expect(parentStart.response.status()).toBe(403);
    noStore(parentStart.response);

    child = await signIn(handoff, childAccount, 'child');
    const childPlan = await getJson(
      child,
      `/api/pilot/children/${encodeURIComponent(childAccount.id)}/plan`,
    );
    expect(childPlan.response.status()).toBe(200);
    expect(childPlan.body.plan).toMatchObject({
      planId: approved.plan.planId,
      available: true,
    });

    const startBody = {
      requestId: `f1-start-${Date.now()}`,
    };
    const start = await sendJson(
      child,
      'POST',
      `/api/pilot/curriculum/assignments/${encodeURIComponent(approved.assignmentId)}/start`,
      startBody,
    );
    expect(start.response.status()).toBe(200);
    noStore(start.response);
    expect(start.body).toMatchObject({
      assignmentId: approved.assignmentId,
      lessonVersion: handoff.lessonVersion,
    });
    const startRunId = start.body.runId;
    expect(typeof startRunId).toBe('string');

    const duplicateStart = await sendJson(
      child,
      'POST',
      `/api/pilot/curriculum/assignments/${encodeURIComponent(approved.assignmentId)}/start`,
      startBody,
    );
    expect(duplicateStart.response.status()).toBe(200);
    expect(duplicateStart.body.runId).toBe(startRunId);

    const opened = await storyRun(child, startRunId as string);
    expect(opened.available).toBe(true);
    const finished = await finishSyntheticStory(child, opened);

    const duplicate = await storyAction(
      child,
      finished.run,
      finished.firstAction.eventId,
      finished.firstAction.type,
      finished.firstAction.payload,
      finished.firstAction.expectedRevision,
      finished.firstAction.stepId,
    );
    expect(duplicate.response.status()).toBe(200);
    noStore(duplicate.response);
    expect(duplicate.body).toMatchObject({
      replayed: true,
      ack: finished.firstAction.ack,
    });

    const changed = await storyAction(
      child,
      finished.run,
      String(finished.firstAction.eventId),
      String(finished.firstAction.type),
      { ...finished.firstAction.payload, changed: true },
      finished.firstAction.expectedRevision,
      finished.firstAction.stepId,
    );
    expect(changed.response.status()).toBe(409);
    noStore(changed.response);

    const persisted = await storyRun(child, startRunId as string);
    expect(persisted.state.stepId).toBe('recap');
    expect(persisted.recap).toEqual(finished.run.recap);

    const parentProgress = await getJson(
      parent,
      `/api/pilot/children/${encodeURIComponent(childAccount.id)}/progress`,
    );
    expect(parentProgress.response.status()).toBe(200);
    noStore(parentProgress.response);
    const curriculum = parentProgress.body.curriculum as
      | { runs?: Array<{ runId?: string; recap?: unknown }> }
      | undefined;
    const recapRun = curriculum?.runs?.find(
      (candidate) => candidate.runId === startRunId,
    );
    expect(recapRun?.recap).toEqual(persisted.recap);
  } finally {
    if (child) await close(child);
    await close(parent);
  }
});

test('[F1-003] wrong family and wrong role cannot read or write Learner’s story', async () => {
  const parentA = await signIn(handoff, account(handoff, 'parent-a'), 'parent A');
  const childA = account(handoff, 'child-a2');
  const parentB = await signIn(handoff, account(handoff, 'parent-b'), 'parent B');
  const childB = account(handoff, 'child-b');
  let childBSession: F1Session | undefined;
  try {
    const approved = await saveAndApprove(parentA, childA, childA.name);
    const foreignParentRead = await getJson(
      parentB,
      `/api/pilot/children/${encodeURIComponent(childA.id)}/plan`,
    );
    expect(foreignParentRead.response.status()).toBe(404);
    noStore(foreignParentRead.response);

    const foreignParentWrite = await sendJson(
      parentB,
      'PUT',
      `/api/pilot/children/${encodeURIComponent(childA.id)}/onboarding`,
      { nickname: 'foreign', experience: 'new', audioReady: true },
    );
    expect(foreignParentWrite.response.status()).toBe(404);

    childBSession = await signIn(handoff, childB, 'child B');
    const foreignChildRead = await getJson(
      childBSession,
      `/api/pilot/children/${encodeURIComponent(childA.id)}/plan`,
    );
    expect(foreignChildRead.response.status()).toBe(404);

    const childBWrite = await sendJson(
      childBSession,
      'POST',
      `/api/pilot/curriculum/assignments/${encodeURIComponent(approved.assignmentId)}/start`,
      { requestId: 'f1-foreign-start' },
    );
    expect([403, 404]).toContain(childBWrite.response.status());

    const childASession = await signIn(
      handoff,
      account(handoff, 'child-a2'),
      'child A',
    );
    try {
      const parentAction = await sendJson(
        parentA,
        'POST',
        '/api/pilot/curriculum/learning-runs/unknown-f1-run/actions',
        {
          eventId: 'f1-parent-action',
          expectedRevision: 0,
          stepId: 'welcome',
          type: 'continue',
          payload: {},
        },
      );
      expect(parentAction.response.status()).toBe(403);
      noStore(parentAction.response);
    } finally {
      await close(childASession).catch(() => undefined);
    }
  } finally {
    if (childBSession) await close(childBSession);
    await close(parentB);
    await close(parentA);
  }
});
