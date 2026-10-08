import { chromium } from '@playwright/test';

/** Connect to the authorized Chrome endpoint without adopting existing tabs. */
export async function connectOwnedChrome(endpoint = 'http://127.0.0.1:9222') {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname)
  )
    throw new Error('An explicit local Chrome endpoint is required');
  const version = await (
    await fetch(new URL('/json/version', url), {
      signal: AbortSignal.timeout(5000),
    })
  ).json();
  const socketURL = new URL(version.webSocketDebuggerUrl);
  if (
    socketURL.protocol !== 'ws:' ||
    socketURL.hostname !== url.hostname ||
    socketURL.port !== url.port
  )
    throw new Error('Chrome returned an unexpected debugger endpoint');
  const socket = new WebSocket(socketURL);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Chrome socket timeout'));
    }, 5000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('Chrome socket failed'));
      },
      { once: true },
    );
  });
  const requests = new Map(),
    contexts = new Set(),
    targets = new Set();
  const internal = new Set(),
    targetReplies = new Map();
  let nextInternal = -1;
  const metadata = {
    adoptedExistingTargets: 0,
    createdContexts: 0,
    createdTargets: 0,
    blockedCommands: 0,
  };
  const transport = {
    send(message) {
      const p = message.params || {};
      if (
        message.method === 'Browser.close' ||
        ([
          'Target.closeTarget',
          'Target.attachToTarget',
          'Target.activateTarget',
        ].includes(message.method) &&
          !targets.has(p.targetId)) ||
        (message.method === 'Target.disposeBrowserContext' &&
          !contexts.has(p.browserContextId)) ||
        (message.method === 'Target.createTarget' &&
          !contexts.has(p.browserContextId))
      ) {
        metadata.blockedCommands++;
        throw new Error(
          'Chrome command requires a tester-owned context or target',
        );
      }
      requests.set(message.id, { method: message.method, params: p });
      // Root auto-attachment makes Playwright initialize every existing user
      // page. Only our explicitly created targets are attached below. Child
      // sessions retain native auto-attachment for their own frames/workers.
      const outgoing =
        message.method === 'Target.setAutoAttach' && !message.sessionId
          ? {
              ...message,
              params: {
                ...p,
                autoAttach: false,
                waitForDebuggerOnStart: false,
              },
            }
          : message;
      socket.send(JSON.stringify(outgoing));
    },
    close() {
      socket.close();
    },
  };
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (internal.delete(message.id)) {
      if (message.error) socket.close();
      return;
    }
    if (message.method === 'Target.attachedToTarget') {
      const info = message.params.targetInfo;
      if (info.type === 'browser') {
        transport.onmessage?.(message);
        return;
      }
      if (!contexts.has(info.browserContextId)) {
        metadata.adoptedExistingTargets++;
        socket.close();
        return;
      }
      targets.add(info.targetId);
      transport.onmessage?.(message);
      const reply = targetReplies.get(info.targetId);
      if (reply) {
        targetReplies.delete(info.targetId);
        // Native automatic attachment precedes createTarget completion. Keep
        // that ordering when attaching the newly created target explicitly.
        setImmediate(() => transport.onmessage?.(reply));
      }
      return;
    }
    const request = requests.get(message.id);
    if (request) {
      requests.delete(message.id);
      if (!message.error && request.method === 'Target.createBrowserContext') {
        contexts.add(message.result.browserContextId);
        metadata.createdContexts++;
      }
      if (!message.error && request.method === 'Target.createTarget') {
        const targetId = message.result.targetId;
        targets.add(targetId);
        metadata.createdTargets++;
        targetReplies.set(targetId, message);
        const id = nextInternal--;
        internal.add(id);
        socket.send(
          JSON.stringify({
            id,
            method: 'Target.attachToTarget',
            params: { targetId, flatten: true },
          }),
        );
        return;
      }
      if (!message.error && request.method === 'Target.disposeBrowserContext')
        contexts.delete(request.params.browserContextId);
    }
    transport.onmessage?.(message);
  });
  socket.addEventListener('close', () => transport.onclose?.());
  try {
    const browser = await chromium.connectOverCDP(transport, {
      noDefaults: true,
      timeout: 15000,
    });
    return { browser, metadata, disconnect: () => transport.close() };
  } catch (error) {
    transport.close();
    throw error;
  }
}
