import { createPilotAuth, type PilotAuth } from './auth.ts';
import {
  getChildIfReadable,
  getPilotUser,
  type PilotDatabase,
  type PilotUserRecord,
  PilotDbError,
} from './db.ts';
import { pilotRuntime, type PilotRuntimeConfig } from './runtime.ts';
import { canManageAccounts, isDisabled, type SafePilotUser, safePilotUser } from './policy.ts';

export interface PilotSessionContext {
  config: PilotRuntimeConfig;
  db: PilotDatabase;
  auth: PilotAuth;
  user: PilotUserRecord;
  session: Record<string, unknown>;
}

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Cache-Control', 'no-store');
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

export function errorResponse(code: string, message: string, status: number, headers?: HeadersInit): Response {
  return json({ error: { code, message } }, status, headers);
}

export function pilotNotFound(): Response {
  return errorResponse('NOT_FOUND', 'pilot mode is unavailable', 404);
}

export function pilotUnavailable(): Response {
  return errorResponse('STORAGE_UNAVAILABLE', 'pilot service is unavailable', 503);
}

export function requirePilotConfig(): PilotRuntimeConfig | Response {
  const config = pilotRuntime();
  if (!config.pilotMode) return pilotNotFound();
  if (!config.database || !config.origin || !config.secret) return pilotUnavailable();
  try {
    const origin = new URL(config.origin);
    if ((origin.protocol !== 'http:' && origin.protocol !== 'https:') || origin.pathname !== '/' || origin.search || origin.hash) return pilotUnavailable();
    if (config.secret.length < 32) return pilotUnavailable();
  } catch {
    return pilotUnavailable();
  }
  return config;
}

export function requireOrigin(request: Request, config: PilotRuntimeConfig): Response | null {
  if (request.headers.get('Origin') !== config.origin) return errorResponse('FORBIDDEN', 'the configured origin is required', 403);
  return null;
}

export async function bodyJson(request: Request, limit = 64_000): Promise<unknown> {
  const text = await request.text();
  if (text.length > limit) throw new PilotDbError('INVALID_REQUEST', 'request body is too large');
  if (!text.trim()) throw new PilotDbError('INVALID_REQUEST', 'request body must be valid JSON');
  try {
    return JSON.parse(text);
  } catch {
    throw new PilotDbError('INVALID_REQUEST', 'request body must be valid JSON');
  }
}

export function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function routeParam(context: { params: unknown }, key: string): Promise<string> {
  return Promise.resolve(context.params).then((params) => {
    const value = (params as Record<string, unknown>)?.[key];
    return typeof value === 'string' ? value : '';
  });
}

export function handlePilotError(caught: unknown): Response {
  if (caught instanceof PilotDbError) return errorResponse(caught.code, caught.message, caught.status);
  // Keep infrastructure details, SQL and credentials out of HTTP responses and logs.
  console.error('Pilot API failure', caught instanceof Error ? caught.name : 'unknown');
  return pilotUnavailable();
}

function authFor(config: PilotRuntimeConfig): PilotAuth {
  return createPilotAuth(config.database as D1Database, {
    origin: config.origin as string,
    secret: config.secret as string,
    secureCookies: config.origin?.startsWith('https://') ?? false,
    ipAddressHeader: config.clientIpHeader,
  });
}

export function createPilotAuthForRequest(config: PilotRuntimeConfig): PilotAuth {
  return authFor(config);
}

export async function requirePilotSession(request: Request, options: { allowPasswordChange?: boolean } = {}): Promise<PilotSessionContext | Response> {
  const required = requirePilotConfig();
  if (required instanceof Response) return required;
  const config = required;
  const db = config.database as unknown as PilotDatabase;
  try {
    const auth = authFor(config);
    const session = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    if (!session) return errorResponse('UNAUTHORIZED', 'authentication is required', 401);
    const userId = typeof session.user?.id === 'string' ? session.user.id : '';
    const user = userId ? await getPilotUser(db, userId) : null;
    if (!user || isDisabled(user)) return errorResponse('UNAUTHORIZED', 'authentication is required', 401);
    if (user.mustChangePassword && !options.allowPasswordChange) return errorResponse('PASSWORD_CHANGE_REQUIRED', 'password change is required before ordinary access', 403);
    return { config, db, auth, user, session: session.session as unknown as Record<string, unknown> };
  } catch (caught) {
    return handlePilotError(caught);
  }
}

export function safeUser(user: PilotUserRecord): SafePilotUser {
  return safePilotUser(user);
}

export function requireAccountManager(context: PilotSessionContext): Response | null {
  if (!canManageAccounts(context.user)) return errorResponse('FORBIDDEN', 'operator access is required', 403);
  return null;
}

export async function requireReadableChild(request: Request, childId: string): Promise<{ context: PilotSessionContext; child: SafePilotUser } | Response> {
  const session = await requirePilotSession(request);
  if (session instanceof Response) return session;
  try {
    const child = await getChildIfReadable(session.db, session.user, childId);
    if (!child) return errorResponse('NOT_FOUND', 'child was not found', 404);
    return { context: session, child };
  } catch (caught) {
    return handlePilotError(caught);
  }
}
