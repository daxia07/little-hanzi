import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function storage(entries = [], { denied = false } = {}) {
  const values = new Map(entries);
  const guard = () => {
    if (denied) throw new Error('Synthetic storage denial');
  };
  return {
    get length() {
      guard();
      return values.size;
    },
    key(index) {
      guard();
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      guard();
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      guard();
      values.set(key, String(value));
    },
    removeItem(key) {
      guard();
      values.delete(key);
    },
    keys() {
      guard();
      return [...values.keys()];
    },
  };
}

function restoreGlobal(name, previous) {
  if (previous === undefined) delete globalThis[name];
  else globalThis[name] = previous;
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestPath(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === 'object' && 'url' in input) {
    const url = input.url;
    return typeof url === 'string' ? url : '';
  }
  return '';
}

function runProjection(runId = 'run-1', revision = 0, stepId = 'welcome') {
  return {
    runId,
    childId: 'child-a',
    lessonId: 'forest-01',
    lessonVersion: 'forest-01-v1',
    seed: 17,
    state: {
      phase: 'initial',
      stepId,
      questionId: null,
      questionStatus: null,
      placedComponents: [],
      completedAt: null,
      reviewCompletedAt: null,
    },
    revision,
    events: [],
    recap: {},
    feedback: [],
    reviewAvailableAt: null,
  };
}

function safeMe(accountId, installationId) {
  return {
    user: {
      id: accountId,
      name: 'Child A',
      username: 'child-a',
      role: 'child',
      mustChangePassword: false,
    },
    installationId,
    children: [{ id: 'child-a', name: 'Child A' }],
    capabilities: { manageAccounts: false },
  };
}

/**
 * Node's strip-types runner does not resolve the app's @/* alias and retains
 * interface names in ordinary import lists. Copy the small browser-client
 * graph to a temporary .ts tree and make only those loader adaptations. The
 * tests still execute the product modules and observe their fetch/storage
 * behavior.
 */
async function loadClient() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'little-hanzi-pilot-client-'),
  );
  const files = [
    ['lib/pilot-learning-client.ts', 'pilot-learning-client.ts'],
    ['lib/forest-client.ts', 'forest-client.ts'],
    ['lib/pilot-client.ts', 'pilot-client.ts'],
    ['lib/forest-transport.ts', 'forest-transport.ts'],
    ['lib/preview/audio.ts', 'preview/audio.ts'],
  ];
  for (const [source, destination] of files) {
    let text = fs.readFileSync(source, 'utf8');
    text = text
      .replaceAll('@/lib/forest-client', './forest-client.ts')
      .replaceAll('@/lib/pilot-client', './pilot-client.ts')
      .replaceAll('@/lib/forest-transport', './forest-transport.ts')
      .replaceAll('@/lib/preview/audio', './preview/audio.ts');
    if (destination === 'pilot-learning-client.ts') {
      text = text.replace(
        /import \{\n  FOREST_LESSON_VERSION,\n  ForestActionResponse,\n  ForestPendingAction,\n  ForestRun,\n  normalizeForestRun,\n  newForestId,\n\} from '\.\/forest-client\.ts';/,
        "import { FOREST_LESSON_VERSION, normalizeForestRun, newForestId } from './forest-client.ts';\nimport type { ForestActionResponse, ForestPendingAction, ForestRun } from './forest-client.ts';",
      );
    }
    const destinationPath = path.join(root, destination);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, text);
  }
  try {
    return await import(
      pathToFileURL(path.join(root, 'pilot-learning-client.ts')).href
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const client = await loadClient();

const baseContext = {
  installationId: 'installation-a',
  accountId: 'account-a',
  childId: 'child-a',
  lessonVersion: 'forest-01-v1',
};

const baseScope = { runId: 'run-1', lessonVersion: 'forest-01-v1' };

const pendingAction = {
  runId: 'run-1',
  lessonVersion: 'forest-01-v1',
  eventId: 'event-1',
  expectedRevision: 0,
  stepId: 'welcome',
  type: 'continue',
  payload: {},
  createdAt: '2026-09-26T00:00:00.000Z',
};

test('[S2-AC-012] pilot recovery separates installation, account, child, version and run scopes', () => {
  const previousWindow = globalThis.window;
  const local = storage();
  globalThis.window = { localStorage: local, sessionStorage: local };
  try {
    const first = client.createPilotRecoveryStore(baseContext);
    const otherAccount = client.createPilotRecoveryStore({
      ...baseContext,
      accountId: 'account-b',
    });
    const otherInstallation = client.createPilotRecoveryStore({
      ...baseContext,
      installationId: 'installation-b',
    });
    const otherRun = { runId: 'run-2', lessonVersion: 'forest-01-v1' };

    assert.equal(first.available(), true);
    assert.equal(first.write(baseScope, [pendingAction]), true);
    assert.deepEqual(first.read(baseScope), [pendingAction]);
    assert.deepEqual(otherAccount.read(baseScope), []);
    assert.deepEqual(otherInstallation.read(baseScope), []);
    assert.deepEqual(first.read(otherRun), []);

    const outboxKey = local.keys().find((key) => key.endsWith(':outbox'));
    assert.equal(typeof outboxKey, 'string');
    local.setItem(
      outboxKey,
      JSON.stringify([{ ...pendingAction, runId: 'tampered-run' }]),
    );
    assert.deepEqual(first.read(baseScope), []);
    assert.equal(
      first.write(baseScope, [
        { ...pendingAction, lessonVersion: 'forest-01-v2' },
      ]),
      false,
    );
  } finally {
    restoreGlobal('window', previousWindow);
  }
});

test('[S2-AC-012] denied storage reports unavailable recovery truthfully', () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    get localStorage() {
      throw new Error('Synthetic storage denial');
    },
    get sessionStorage() {
      throw new Error('Synthetic storage denial');
    },
  };
  try {
    const store = client.createPilotRecoveryStore(baseContext);
    assert.equal(store.available(), false);
    assert.deepEqual(store.read(baseScope), []);
    assert.equal(store.write(baseScope, [pendingAction]), false);
    assert.equal(store.clear(baseScope), false);
  } finally {
    restoreGlobal('window', previousWindow);
  }
});

test('[S2-AC-012] account and restored-installation changes block before a run request', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { localStorage: storage(), sessionStorage: storage() };
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const pathValue = requestPath(input);
    requests.push({ path: pathValue, method: init.method || 'GET' });
    if (pathValue === '/api/auth/get-session')
      return response({ user: { id: 'account-b' } });
    if (pathValue === '/api/pilot/me')
      return response(safeMe('account-a', 'installation-b'));
    return response(runProjection(), 500);
  };
  try {
    const transport = client.createPilotForestTransport(baseContext);
    await assert.rejects(
      () => transport.getRun('run-1'),
      (error) => error?.code === 'SESSION_CHANGED',
    );
    assert.deepEqual(
      requests.map((item) => item.path),
      ['/api/auth/get-session'],
    );

    requests.length = 0;
    globalThis.fetch = async (input, init = {}) => {
      const pathValue = requestPath(input);
      requests.push({ path: pathValue, method: init.method || 'GET' });
      if (pathValue === '/api/auth/get-session')
        return response({ user: { id: 'account-a' } });
      if (pathValue === '/api/pilot/me')
        return response(safeMe('account-a', 'installation-b'));
      return response(runProjection(), 500);
    };
    await assert.rejects(
      () => transport.getRun('run-1'),
      (error) => error?.code === 'INSTALLATION_CHANGED',
    );
    assert.deepEqual(
      requests.map((item) => item.path),
      ['/api/auth/get-session', '/api/pilot/me'],
    );
  } finally {
    restoreGlobal('window', previousWindow);
    restoreGlobal('fetch', previousFetch);
  }
});

test('[S2-AC-012] authenticated Forest transport uses child run paths and never preview paths', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { localStorage: storage(), sessionStorage: storage() };
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const pathValue = requestPath(input);
    const body =
      typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ path: pathValue, method: init.method || 'GET', body });
    if (pathValue === '/api/auth/get-session')
      return response({ user: { id: 'account-a' } });
    if (pathValue === '/api/pilot/me')
      return response(safeMe('account-a', 'installation-a'));
    const method = init.method || 'GET';
    if (
      pathValue === '/api/pilot/children/child%2Fone/runs' &&
      method === 'POST'
    )
      return response(runProjection('run one'));
    if (
      pathValue === '/api/pilot/children/child%2Fone/runs/run%20one' &&
      method === 'GET'
    )
      return response(runProjection('run one'));
    if (
      pathValue === '/api/pilot/children/child%2Fone/runs/run%20one/actions' &&
      method === 'POST'
    ) {
      return response({
        eventId: body.eventId,
        result: { outcome: 'recorded' },
        state: runProjection('run one', 1, 'familiarity').state,
        revision: 1,
      });
    }
    return response(
      { error: { code: 'UNEXPECTED_TEST_REQUEST', message: pathValue } },
      500,
    );
  };
  try {
    const transport = client.createPilotForestTransport({
      ...baseContext,
      childId: 'child/one',
    });
    const created = await transport.createRun();
    const loaded = await transport.getRun('run one');
    const action = await transport.sendAction(
      'run one',
      0,
      'welcome',
      'continue',
      {},
      'event-1',
    );
    assert.equal(created.runId, 'run one');
    assert.equal(loaded.runId, 'run one');
    assert.equal(action.eventId, 'event-1');

    const learningRequests = requests.filter((item) =>
      item.path.startsWith('/api/pilot/children/'),
    );
    assert.deepEqual(
      learningRequests.map((item) => `${item.method} ${item.path}`),
      [
        'POST /api/pilot/children/child%2Fone/runs',
        'GET /api/pilot/children/child%2Fone/runs/run%20one',
        'POST /api/pilot/children/child%2Fone/runs/run%20one/actions',
      ],
    );
    assert.deepEqual(learningRequests[0].body, {
      lessonVersion: 'forest-01-v1',
    });
    assert.deepEqual(learningRequests[2].body, {
      eventId: 'event-1',
      expectedRevision: 0,
      stepId: 'welcome',
      type: 'continue',
      payload: {},
    });
    assert.equal(
      requests.some((item) => item.path.includes('/api/preview/')),
      false,
    );
  } finally {
    restoreGlobal('window', previousWindow);
    restoreGlobal('fetch', previousFetch);
  }
});
