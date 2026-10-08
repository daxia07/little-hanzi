/** Real HTTP only. No fallback URL, cookies or application imports. */
import assert from 'node:assert/strict';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const local = (value) => {
  const u = new URL(value);
  assert.equal(u.protocol, 'http:');
  assert(['127.0.0.1', 'localhost'].includes(u.hostname));
  return u.origin;
};
export function createServiceHTTP(handoff, evidence) {
  const h = handoff,
    cookies = new Map(),
    transcript = [];
  const base = local(h.baseURL),
    control = local(h.controlURL);
  const actor = (id) => {
    const a = h.accounts.find((x) => x.id === id);
    assert(a, 'Unknown fixed actor');
    return a;
  };
  async function raw(origin, method, route, body, headers = {}) {
    assert(route.startsWith('/') && !route.startsWith('//'));
    const started = performance.now();
    const response = await fetch(origin + route, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(45000),
      redirect: 'error',
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const duration = Number(
      /(?:catalog|proposal);dur=([\d.]+)/u.exec(
        response.headers.get('server-timing') ?? '',
      )?.[1],
    );
    transcript.push({
      method,
      route: route.split('?')[0],
      status: response.status,
      code: parsed?.error?.code ?? parsed?.code ?? null,
      elapsedMs: performance.now() - started,
      serverMs: Number.isFinite(duration) ? duration : null,
    });
    return {
      status: response.status,
      body: parsed,
      headers: response.headers,
      elapsedMs: performance.now() - started,
      serverMs: Number.isFinite(duration) ? duration : null,
    };
  }
  async function signIn(id, origin = base) {
    origin = local(origin);
    const key = origin + '|' + id,
      a = actor(id);
    if (cookies.has(key)) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await raw(origin, 'POST', '/api/auth/sign-in/username', {
        username: a.username,
        password: a.password,
      });
      if (r.status === 429 && attempt < 2) {
        const retry = Number(r.headers.get('retry-after'));
        const waitMs =
          Number.isFinite(retry) && retry > 0
            ? Math.min(120000, Math.ceil(retry * 1000) + 100)
            : 61000;
        transcript.push({
          kind: 'auth-throttle',
          role: a.role,
          attempt: attempt + 1,
          waitMs,
        });
        await sleep(waitMs);
        continue;
      }
      assert.equal(r.status, 200, 'Normal sign-in failed: ' + r.status);
      const values =
        r.headers.getSetCookie?.() ??
        [r.headers.get('set-cookie')].filter(Boolean);
      const cookie = values.map((v) => v.split(';')[0]).join('; ');
      assert(cookie, 'Sign-in returned no real session');
      cookies.set(key, cookie);
      return;
    }
  }
  async function request(id, method, route, body, origin = base) {
    origin = local(origin);
    await signIn(id, origin);
    return raw(origin, method, route, body, {
      Cookie: cookies.get(origin + '|' + id),
    });
  }
  async function controlRequest(route, body) {
    const r = await raw(control, 'POST', route, body, {
      'x-hanzi-test-token': h.token,
    });
    evidence('control-' + transcript.length, {
      route,
      status: r.status,
      elapsedMs: r.elapsedMs,
      result: {
        status: r.body?.status,
        commit: r.body?.commit,
        formatVersion: r.body?.formatVersion,
        installationId: r.body?.installationId,
        baseURLPresent: !!r.body?.baseURL,
        counts: r.body?.counts,
        error: r.body?.error?.code ?? r.body?.code,
      },
    });
    return r;
  }
  return {
    handoff: h,
    request,
    replaySession: async (id, route, targetOrigin) => {
      await signIn(id, base);
      return raw(local(targetOrigin), 'GET', route, undefined, {
        Cookie: cookies.get(base + '|' + id),
      });
    },
    signIn,
    control: controlRequest,
    inspect: async (body) => {
      const r = await controlRequest('/inspect', body);
      assert.equal(r.status, 200);
      assert.equal(r.body.installationId, h.installationId);
      return r.body;
    },
    transcript,
    forget: (id, origin = base) => cookies.delete(local(origin) + '|' + id),
  };
}
