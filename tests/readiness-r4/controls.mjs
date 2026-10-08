// Actual HTTP transport for the closed R4 private runner controls. No default URL.
import assert from 'node:assert/strict';
const exact = (v, fields) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === fields.length &&
  fields.every((k) => Object.hasOwn(v, k));
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(v);
export function validateControl(route, body) {
  let valid = false;
  if (route === '/dispatch')
    valid =
      (exact(body, ['kind']) &&
        ['backup', 'monitor', 'retention'].includes(body.kind)) ||
      (exact(body, ['kind', 'subjectJobId']) &&
        body.kind === 'reconcile' &&
        id(body.subjectJobId));
  else if (route === '/clock')
    valid =
      exact(body, ['at']) &&
      Number.isSafeInteger(body.at) &&
      body.at >= 0 &&
      body.at <= 253402300799999;
  else if (route === '/binding')
    valid =
      exact(body, ['state']) &&
      ['available', 'missing', 'unavailable'].includes(body.state);
  else if (route === '/restart')
    valid =
      exact(body, ['service']) &&
      ['app', 'learning-database', 'ops-database', 'all'].includes(
        body.service,
      );
  else if (route === '/inspect')
    valid =
      (exact(body, ['kind']) &&
        ['counts', 'installation', 'archives'].includes(body.kind)) ||
      (exact(body, ['kind', 'id']) &&
        ['record', 'job'].includes(body.kind) &&
        id(body.id));
  else if (route === '/archive-readback')
    valid = exact(body, ['jobId']) && id(body.jobId);
  else if (route === '/fault')
    valid =
      exact(body, ['stage', 'mode']) &&
      ((['upload', 'readback', 'delete'].includes(body.stage) &&
        ['none', 'unavailable', 'ack-lost'].includes(body.mode)) ||
        (body.stage === 'commit' &&
          ['none', 'final-constraint', 'ack-lost'].includes(body.mode)) ||
        (body.stage === 'monitor' &&
          ['none', 'unavailable', 'probe-failed'].includes(body.mode)));
  else if (route === '/hold')
    valid =
      exact(body, ['stage', 'enabled']) &&
      ['after-lease', 'before-readback', 'before-commit'].includes(
        body.stage,
      ) &&
      typeof body.enabled === 'boolean';
  assert(valid, 'Request outside frozen closed R4 control map');
}
export function createControls(handoff, token) {
  const base = new URL(handoff.operations.controlURL);
  assert.equal(base.protocol, 'http:');
  assert.equal(base.hostname, '127.0.0.1');
  assert.equal(base.pathname, '/');
  assert(typeof token === 'string' && token.length > 0);
  return async function control(route, body, timeoutMs = 30000) {
    validateControl(route, body);
    const response = await fetch(new URL(route, base), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hanzi-Test-Token': token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    const result = await response.json();
    // Callers record only redacted evidence, never token or raw private payloads.
    return { status: response.status, body: result };
  };
}
