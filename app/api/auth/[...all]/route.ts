import { getPilotUser, getPilotUserByUsername, type PilotDatabase } from '@/lib/pilot/db';
import {
  isAllowedAuthRoute,
  validateExistingCredentialInput,
  validatePasswordInput,
} from '@/lib/pilot/policy';
import {
  bodyJson,
  createPilotAuthForRequest,
  errorResponse,
  handlePilotError,
  requireOrigin,
  requirePilotConfig,
  requirePilotSession,
  safeUser,
} from '@/lib/pilot/http';
import { PilotDbError } from '@/lib/pilot/db';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function invalidAuthBody(): PilotDbError {
  return new PilotDbError('INVALID_REQUEST', 'request body is invalid');
}

async function parseAuthBody(request: Request, pathname: string): Promise<Record<string, unknown> | null> {
  const body = await bodyJson(request.clone() as unknown as Request);
  if (!record(body)) throw invalidAuthBody();
  const keys = Object.keys(body).sort();
  if (pathname === '/api/auth/sign-in/username') {
    if (keys.join(',') !== 'password,username' || typeof body.username !== 'string' || !body.username || !validateExistingCredentialInput(body.password)) throw invalidAuthBody();
    return body;
  }
  if (pathname === '/api/auth/change-password') {
    const expected = body.revokeOtherSessions === undefined
      ? ['currentPassword', 'newPassword']
      : ['currentPassword', 'newPassword', 'revokeOtherSessions'];
    if (keys.join(',') !== expected.sort().join(',') || !validateExistingCredentialInput(body.currentPassword) || !validatePasswordInput(body.newPassword) || (body.revokeOtherSessions !== undefined && typeof body.revokeOtherSessions !== 'boolean')) throw invalidAuthBody();
    return { ...body, revokeOtherSessions: true };
  }
  return null;
}

function requestWithBody(request: Request, body: Record<string, unknown>): Request {
  const headers = new Headers(request.headers);
  headers.set('Content-Type', 'application/json');
  headers.delete('Content-Length');
  return new Request(request.url, { method: request.method, headers, body: JSON.stringify(body), redirect: 'manual' });
}

async function responseBody(response: Response): Promise<unknown> {
  try { return await response.clone().json(); } catch { return null; }
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return headers;
}

function safeAuthResponse(response: Response, body: unknown): Response {
  return new Response(JSON.stringify(body), { status: response.status, headers: responseHeaders(response) });
}

function authFailure(pathname: string, response: Response): Response {
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    return errorResponse('RATE_LIMITED', 'too many authentication attempts', 429, retryAfter ? { 'Retry-After': retryAfter } : undefined);
  }
  if (pathname === '/api/auth/sign-in/username' && [400, 401, 403, 422].includes(response.status)) {
    return errorResponse('INVALID_CREDENTIALS', 'invalid username or password', 401);
  }
  if (response.status === 401) return errorResponse('UNAUTHORIZED', 'authentication is required', 401);
  if (response.status >= 500) return errorResponse('STORAGE_UNAVAILABLE', 'authentication service is unavailable', 503);
  if (response.status === 403) return errorResponse('FORBIDDEN', 'authentication request was rejected', 403);
  return errorResponse('INVALID_REQUEST', 'authentication request was invalid', response.status >= 400 ? response.status : 400);
}

async function safeUserForPayload(db: PilotDatabase, payload: unknown): Promise<ReturnType<typeof safeUser> | null> {
  if (!record(payload) || !record(payload.user) || typeof payload.user.id !== 'string') return null;
  const user = await getPilotUser(db, payload.user.id);
  if (!user || user.disabled) return null;
  return safeUser(user);
}

async function handleAuth(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (!isAllowedAuthRoute(request.method, pathname)) return errorResponse('NOT_FOUND', 'auth route is unavailable', 404);
  const required = requirePilotConfig();
  if (required instanceof Response) return required;
  const config = required;
  if (request.method === 'POST') {
    const originFailure = requireOrigin(request, config);
    if (originFailure) return originFailure;
  }

  try {
    const db = config.database as unknown as PilotDatabase;
    let forwarded = request;
    if (pathname === '/api/auth/sign-in/username' || pathname === '/api/auth/change-password') {
      const parsed = await parseAuthBody(request, pathname);
      if (!parsed) throw invalidAuthBody();
      if (pathname === '/api/auth/sign-in/username') {
        const existing = await getPilotUserByUsername(db, String(parsed.username));
        if (existing?.disabled) return errorResponse('INVALID_CREDENTIALS', 'invalid username or password', 401);
      }
      if (pathname === '/api/auth/change-password') {
        const current = await requirePilotSession(request, { allowPasswordChange: true });
        if (current instanceof Response) return current;
      }
      forwarded = pathname === '/api/auth/change-password' ? requestWithBody(request, parsed) : request;
    }
    const auth = createPilotAuthForRequest(config);
    const response = await auth.handler(forwarded);
    if (!response.ok) return authFailure(pathname, response);
    const body = await responseBody(response);
    if (pathname === '/api/auth/get-session') {
      if (body === null) return safeAuthResponse(response, null);
      const user = await safeUserForPayload(db, body);
      if (!user) return errorResponse('UNAUTHORIZED', 'authentication is required', 401);
      if (!record(body) || !record(body.session)) return errorResponse('STORAGE_UNAVAILABLE', 'authentication service is unavailable', 503);
      const session = body.session;
      return safeAuthResponse(response, {
        session: {
          id: session.id,
          userId: session.userId,
          expiresAt: session.expiresAt,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
        user,
      });
    }
    if (pathname === '/api/auth/sign-in/username' || pathname === '/api/auth/change-password') {
      const user = await safeUserForPayload(db, body);
      if (!user) return errorResponse('UNAUTHORIZED', 'authentication is required', 401);
      return safeAuthResponse(response, pathname === '/api/auth/sign-in/username'
        ? { user }
        : { status: true, user });
    }
    return safeAuthResponse(response, { success: true });
  } catch (caught) {
    return handlePilotError(caught);
  }
}

export const GET = handleAuth;
export const POST = handleAuth;
