/** Private runner protocol, never imported by product/browser code. */
import path from 'node:path';
export const corpusAppOrigin = (config, baseURL, ordinary) =>
  ordinary ? baseURL : (config.origin ?? baseURL);
export const corpusControlSessionExpiry = (clock, built) =>
  clock + (built ? 14 : 1) * 86400000;
export const corpusHandoffLocation = (work, _output) =>
  path.join(work, 'handoff.json');
export function corpusRuntimeFailure(error) {
  if (
    ['PUBLICATION_STALE', 'SNAPSHOT_STALE', 'CORPUS_CONTROL_CONFLICT'].includes(
      error?.message,
    )
  )
    return { status: 409, code: error.message };
  if (
    ['SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT_TRIGGER'].includes(error?.code) &&
    /^SQLITE_CONSTRAINT(?:_TRIGGER)?: (?:SQLITE_CONSTRAINT(?:_TRIGGER)?: )?(?:SQLite error: )?R6_RUNNER_FINAL_CONSTRAINT$/.test(
      error?.message,
    )
  )
    return { status: 503, code: 'CORPUS_TERMINAL_CONSTRAINT' };
  return {
    status: 400,
    code: [
      'CLOCK_RETROGRADE',
      'FAULT_MUST_BE_DISARMED',
      'CORPUS_RESOURCE_NOT_OWNED',
    ].includes(error?.message)
      ? error.message
      : 'CORPUS_CONTROL_REJECTED',
  };
}
/** Resolution means an exit was observed; timeout never certifies cleanup. */
export async function stopCorpusRuntimeChild(
  child,
  { termMs = 10000, killMs = 5000 } = {},
) {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const waitExit = (ms) =>
    exited()
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          const finish = () => {
            clearTimeout(timer);
            child.removeListener('exit', onExit);
          };
          const onExit = () => {
            finish();
            resolve();
          };
          const timer = setTimeout(() => {
            finish();
            reject(new Error('PROCESS_EXIT_UNCONFIRMED'));
          }, ms);
          child.once('exit', onExit);
        });
  if (exited()) return;
  child.kill('SIGTERM');
  try {
    await waitExit(termMs);
  } catch {
    child.kill('SIGKILL');
    await waitExit(killMs);
  }
}
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(v);
export function validateCorpusRuntimeControl(route, body) {
  const shapes = {
    '/clock': ['at'],
    '/restart': [],
    '/fault': ['stage', 'mode'],
    '/hold': ['stage', 'operation'],
    '/verification': ['operation', 'requestId'],
    '/backup': [],
    '/ops-recovery': [],
    '/restore': ['archiveId', 'variant'],
    '/verify-and-sign': [],
  };
  if (route === '/inspect') {
    if (
      exact(body, ['kind', 'target']) &&
      body.kind === 'counts' &&
      body.target === 'ordinary-negative'
    )
      return true;
    if (exact(body, ['kind']) && ['counts', 'head'].includes(body.kind))
      return true;
    if (
      exact(body, ['kind', 'assignmentId']) &&
      body.kind === 'assignment' &&
      id(body.assignmentId)
    )
      return true;
    if (exact(body, ['kind', 'runId']) && body.kind === 'run' && id(body.runId))
      return true;
  } else if (shapes[route] && exact(body, shapes[route])) {
    if (
      route === '/clock' &&
      (!Number.isSafeInteger(body.at) ||
        body.at < 0 ||
        body.at > 253402300799999)
    )
      throw new Error('CORPUS_CONTROL_INVALID');
    if (
      route === '/hold' &&
      (body.stage !== 'publication-before-commit' ||
        !['arm', 'status', 'release'].includes(body.operation))
    )
      throw new Error('CORPUS_CONTROL_INVALID');
    if (
      route === '/fault' &&
      (!['proposal', 'approval', 'start', 'action', 'publication'].includes(
        body.stage,
      ) ||
        !['none', 'final-constraint', 'accepted-response-loss'].includes(
          body.mode,
        ))
    )
      throw new Error('CORPUS_CONTROL_INVALID');
    if (
      route === '/verification' &&
      (!['withdraw', 'republish'].includes(body.operation) ||
        !id(body.requestId))
    )
      throw new Error('CORPUS_CONTROL_INVALID');
    if (
      route === '/restore' &&
      (!id(body.archiveId) ||
        ![
          'exact',
          'invalid-digest',
          'unknown-format',
          'final-constraint',
          'lost-ack',
        ].includes(body.variant))
    )
      throw new Error('CORPUS_CONTROL_INVALID');
    return true;
  }
  throw new Error('CORPUS_CONTROL_INVALID');
}
export function corpusRuntimeActors() {
  const families = Array.from({ length: 10 }, (_, i) => ({
    index: i + 1,
    parentId: `r6-parent-${String(i + 1).padStart(2, '0')}`,
    childId: `r6-child-${String(i + 1).padStart(2, '0')}`,
  }));
  return {
    families,
    roles: [
      ['r6-operator', 'operator'],
      ['r6-teacher-granted', 'teacher'],
      ['r6-teacher-ungranted', 'teacher'],
      ['r6-parent-foreign', 'parent'],
      ...families.flatMap((f) => [
        [f.parentId, 'parent'],
        [f.childId, 'child'],
      ]),
    ],
  };
}

/** Stable synthetic login name; actor IDs remain separate authorization identities. */
export function corpusRuntimeUsername(actorId) {
  if (!corpusRuntimeActors().roles.some(([id]) => id === actorId))
    throw new Error('CORPUS_ACTOR_INVALID');
  return actorId.replaceAll('-', '_');
}

/** Temporary named terminal trigger; existing immutable schema guards remain unchanged. */
export async function installCorpusRuntimeFault(client, body) {
  validateCorpusRuntimeControl('/fault', body);
  await client.execute('DROP TRIGGER IF EXISTS r6_runner_terminal_fault');
  if (body.mode !== 'final-constraint') return body;
  const table =
    body.stage === 'proposal'
      ? 'pilot_corpus_proposal'
      : body.stage === 'publication'
        ? 'pilot_corpus_publication_audit'
        : 'pilot_corpus_learning_audit';
  const when = {
    approval: "NEW.action='plan-approval'",
    start: "NEW.action='run-start'",
    action: "NEW.action='run-action'",
  }[body.stage];
  await client.execute(
    `CREATE TRIGGER r6_runner_terminal_fault BEFORE INSERT ON ${table} ${when ? 'WHEN ' + when : ''} BEGIN SELECT RAISE(ABORT,'R6_RUNNER_FINAL_CONSTRAINT'); END`,
  );
  return body;
}
export function corpusMutationStage(url) {
  return url.includes('/proposals')
    ? 'proposal'
    : url.includes('/placement/approve')
      ? 'approval'
      : url.endsWith('/start')
        ? 'start'
        : url.endsWith('/actions')
          ? 'action'
          : url.includes('/publications')
            ? 'publication'
            : null;
}

/** Two captured private inputs; no clock, SQL or caller-selected stage. */
export function createCorpusPublicationBarrier({
  signal,
  timeoutMs = 30000,
} = {}) {
  let armed = false,
    released = false,
    waiting = [],
    timer = null,
    closed = false;
  const status = () => ({
    stage: 'publication-before-commit',
    armed,
    waiting: waiting.length,
    released,
  });
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    armed = false;
    const held = waiting;
    waiting = [];
    for (const p of held) p.reject(new Error('PUBLICATION_BARRIER_ABORTED'));
  };
  const onAbort = () => {
    closed = true;
    cancel();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    status,
    arm() {
      if (closed || armed || waiting.length)
        throw new Error('PUBLICATION_BARRIER_BUSY');
      armed = true;
      released = false;
      timer = setTimeout(cancel, timeoutMs);
      return status();
    },
    async wait(input) {
      if (closed || signal?.aborted)
        throw new Error('PUBLICATION_BARRIER_ABORTED');
      if (!armed) return input;
      if (waiting.length >= 2) throw new Error('PUBLICATION_BARRIER_FULL');
      const captured = Object.freeze({ ...input });
      return new Promise((resolve, reject) =>
        waiting.push({ resolve, reject, input: captured }),
      );
    },
    release() {
      if (!armed || waiting.length !== 2)
        throw new Error('PUBLICATION_BARRIER_NOT_READY');
      clearTimeout(timer);
      timer = null;
      const held = waiting;
      waiting = [];
      armed = false;
      released = true;
      for (const p of held) p.resolve(p.input);
      return status();
    },
    destroy() {
      closed = true;
      cancel();
      signal?.removeEventListener('abort', onAbort);
    },
  };
}
