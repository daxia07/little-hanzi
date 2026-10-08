/*
 * Browser client for the invited-account pilot.
 *
 * The server owns sessions, roles, links, grants and account state. This file
 * only carries the safe projections needed to render the pilot screens; it
 * never stores credentials or exposes the auth library's internal email.
 */

export type PilotRole = 'child' | 'parent' | 'teacher' | 'operator';

export interface PilotUser {
  id: string;
  name: string;
  username: string;
  role: PilotRole;
  mustChangePassword: boolean;
}

export interface PilotChild {
  id: string;
  name: string;
  username?: string;
  assignment?: {
    lessonId?: string;
    lessonVersion?: string;
    status?: 'assigned' | 'pending' | 'complete';
    runId?: string | null;
  };
}

export interface PilotTeacher {
  id: string;
  name: string;
  username?: string;
}

export interface PilotGrant {
  id?: string;
  childId: string;
  teacherId: string;
  teacherName?: string;
  teacherDisabled?: boolean;
  childDisabled?: boolean;
  childName?: string;
  createdAt?: string;
  grantedBy?: string;
}

export interface PilotMe {
  user: PilotUser;
  installationId: string;
  children: PilotChild[];
  capabilities: { manageAccounts: boolean };
  teachers?: PilotTeacher[];
  grants?: PilotGrant[];
}

export interface PilotAccount {
  id: string;
  name: string;
  username: string;
  role: PilotRole;
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface PilotSessionUser {
  id?: string;
  name?: string;
  username?: string;
}

export interface PilotAuthSession {
  user: PilotSessionUser;
}

export class PilotApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = 'PILOT_REQUEST_FAILED') {
    super(message);
    this.name = 'PilotApiError';
    this.status = status;
    this.code = code;
  }
}

const PENDING_SIGN_OUT_KEY = 'little-hanzi:pending-signout';

interface PilotStorageAccess {
  stores: Storage[];
  accessFailed: boolean;
}

function pilotStorages(): PilotStorageAccess {
  if (typeof window === 'undefined') return { stores: [], accessFailed: false };
  const stores: Storage[] = [];
  let accessFailed = false;
  try {
    stores.push(window.localStorage);
  } catch {
    accessFailed = true;
  }
  try {
    stores.push(window.sessionStorage);
  } catch {
    accessFailed = true;
  }
  return { stores, accessFailed };
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return object(value) ? value : {};
}

function stringValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function booleanValue(value: unknown, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function roleValue(value: unknown): PilotRole {
  return value === 'child' ||
    value === 'parent' ||
    value === 'teacher' ||
    value === 'operator'
    ? value
    : 'child';
}

function unwrap(value: unknown): unknown {
  const body = record(value);
  return body.data ?? body;
}

function errorMessage(status: number, code: string) {
  if (code === 'USERNAME_TAKEN') return 'That username is already in use.';
  if (code === 'INVALID_CREDENTIALS' || status === 401)
    return 'Your username or password was not accepted.';
  if (code === 'ACCOUNT_DISABLED')
    return 'This account is unavailable. Ask the pilot operator for help.';
  if (code === 'MUST_CHANGE_PASSWORD')
    return 'Choose a new password before continuing.';
  if (status === 400) return 'Check the details and try again.';
  if (status === 403) return 'You do not have permission to make that change.';
  if (status === 404) return 'That item is no longer available.';
  if (status === 409)
    return 'This change conflicts with a newer account state. Refresh and try again.';
  if (status === 429) return 'Too many attempts. Wait a moment and try again.';
  if (status >= 500)
    return 'The pilot service is temporarily unavailable. Please retry.';
  return 'The pilot request could not be completed. Please retry.';
}

async function parseBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const body = await parseBody(response);
  if (!response.ok) {
    const bodyRecord = record(body);
    const bodyError = record(bodyRecord.error);
    const code = stringValue(
      bodyError.code || bodyRecord.code,
      'PILOT_REQUEST_FAILED',
    );
    throw new PilotApiError(
      response.status,
      errorMessage(response.status, code),
      code,
    );
  }
  return body as T;
}

// Shared transport for additional pilot screens. Server messages remain private.
export { request as pilotRequest };

function json(value: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(value) };
}

function normalizeSession(value: unknown): PilotAuthSession | null {
  const body = record(unwrap(value));
  const user = record(body.user);
  if (!Object.keys(user).length) return null;
  return {
    user: {
      id: stringValue(user.id) || undefined,
      name: stringValue(user.name) || undefined,
      username: stringValue(user.username) || undefined,
    },
  };
}

function normalizeChild(value: unknown): PilotChild | null {
  const child = record(value);
  const id = stringValue(child.id);
  if (!id) return null;
  const assignment = record(child.assignment);
  return {
    id,
    name: stringValue(child.name, 'Learner'),
    username: stringValue(child.username) || undefined,
    assignment: Object.keys(assignment).length
      ? {
          lessonId: stringValue(assignment.lessonId) || undefined,
          lessonVersion: stringValue(assignment.lessonVersion) || undefined,
          status:
            assignment.status === 'assigned' ||
            assignment.status === 'pending' ||
            assignment.status === 'complete'
              ? assignment.status
              : undefined,
          runId: typeof assignment.runId === 'string' ? assignment.runId : null,
        }
      : undefined,
  };
}

function normalizeMe(value: unknown): PilotMe {
  const body = record(unwrap(value));
  const userRecord = record(body.user);
  const user: PilotUser = {
    id: stringValue(userRecord.id),
    name: stringValue(userRecord.name, 'Pilot user'),
    username: stringValue(userRecord.username),
    role: roleValue(userRecord.role),
    mustChangePassword: booleanValue(userRecord.mustChangePassword),
  };
  const children = Array.isArray(body.children)
    ? body.children
        .map(normalizeChild)
        .filter((item): item is PilotChild => Boolean(item))
    : [];
  const capabilities = record(body.capabilities);
  const teachers: PilotTeacher[] | undefined = Array.isArray(body.teachers)
    ? body.teachers
        .map((value): PilotTeacher | null => {
          const teacher = record(value);
          const id = stringValue(teacher.id);
          return id
            ? {
                id,
                name: stringValue(teacher.name, 'Teacher'),
                username: stringValue(teacher.username) || undefined,
              }
            : null;
        })
        .filter((item): item is PilotTeacher => Boolean(item))
    : undefined;
  const grants: PilotGrant[] | undefined = Array.isArray(body.grants)
    ? body.grants
        .map((value): PilotGrant | null => {
          const grant = record(value);
          const childId = stringValue(grant.childId);
          const teacherId = stringValue(grant.teacherId);
          const grantingParentId = stringValue(
            grant.grantingParentId || grant.grantedBy,
          );
          // A parent projection may include its own grants only. If the
          // server accidentally includes another parent's ownership marker,
          // discard that row before it reaches the UI.
          if (grantingParentId && grantingParentId !== user.id) return null;
          return childId && teacherId
            ? {
                id: stringValue(grant.id) || undefined,
                childId,
                teacherId,
                teacherName: stringValue(grant.teacherName) || undefined,
                teacherDisabled: booleanValue(grant.teacherDisabled),
                childDisabled: booleanValue(grant.childDisabled),
                childName: stringValue(grant.childName) || undefined,
                createdAt: stringValue(grant.createdAt) || undefined,
                grantedBy: grantingParentId || undefined,
              }
            : null;
        })
        .filter((item): item is PilotGrant => Boolean(item))
    : undefined;
  return {
    user,
    installationId: stringValue(body.installationId),
    children,
    capabilities: { manageAccounts: booleanValue(capabilities.manageAccounts) },
    teachers,
    grants,
  };
}

function normalizeAccount(value: unknown): PilotAccount | null {
  const account = record(value);
  const id = stringValue(account.id);
  if (!id) return null;
  return {
    id,
    name: stringValue(account.name, 'Unnamed account'),
    username: stringValue(account.username),
    role: roleValue(account.role),
    disabled: booleanValue(account.disabled),
    mustChangePassword: booleanValue(account.mustChangePassword),
    createdAt: stringValue(account.createdAt) || undefined,
    updatedAt: stringValue(account.updatedAt) || undefined,
  };
}

export async function getPilotSession(): Promise<PilotAuthSession | null> {
  try {
    return normalizeSession(await request<unknown>('/api/auth/get-session'));
  } catch (error) {
    if (
      error instanceof PilotApiError &&
      (error.status === 401 || error.status === 404)
    )
      return null;
    throw error;
  }
}

export async function signInUsername(username: string, password: string) {
  await request('/api/auth/sign-in/username', json({ username, password }));
}

export async function signOutPilot() {
  await request('/api/auth/sign-out', json({}));
}

export async function changePilotPassword(
  currentPassword: string,
  newPassword: string,
) {
  await request(
    '/api/auth/change-password',
    json({ currentPassword, newPassword, revokeOtherSessions: true }),
  );
}

export async function getPilotMe() {
  return normalizeMe(await request<unknown>('/api/pilot/me'));
}

export async function listPilotAccounts() {
  const payload = unwrap(await request<unknown>('/api/pilot/accounts'));
  const body = record(payload);
  const values = Array.isArray(payload)
    ? payload
    : Array.isArray(body.accounts)
      ? body.accounts
      : [];
  return values
    .map(normalizeAccount)
    .filter((item): item is PilotAccount => Boolean(item));
}

export async function createPilotAccount(value: {
  username: string;
  name: string;
  password: string;
  role: PilotRole;
}) {
  const body = unwrap(
    await request<unknown>('/api/pilot/accounts', json(value)),
  );
  return normalizeAccount(body);
}

export async function resetPilotAccount(accountId: string, password: string) {
  await request(
    `/api/pilot/accounts/${encodeURIComponent(accountId)}/reset`,
    json({ password }),
  );
}

export async function setPilotAccountStatus(
  accountId: string,
  disabled: boolean,
) {
  await request(
    `/api/pilot/accounts/${encodeURIComponent(accountId)}/status`,
    json({ disabled }),
  );
}

export async function linkPilotChild(parentId: string, childId: string) {
  await request('/api/pilot/links', json({ parentId, childId }));
}

export async function unlinkPilotChild(parentId: string, childId: string) {
  await request('/api/pilot/links', {
    method: 'DELETE',
    body: JSON.stringify({ parentId, childId }),
  });
}

export async function grantPilotTeacher(childId: string, teacherId: string) {
  await request('/api/pilot/grants', json({ childId, teacherId }));
}

export async function revokePilotTeacher(childId: string, teacherId: string) {
  await request('/api/pilot/grants', {
    method: 'DELETE',
    body: JSON.stringify({ childId, teacherId }),
  });
}

export function markPendingSignOut(): boolean {
  const { stores } = pilotStorages();
  let written = false;
  for (const storage of stores) {
    try {
      storage.setItem(PENDING_SIGN_OUT_KEY, '1');
      written = true;
    } catch {
      // A denied store must not block the server sign-out request.
    }
  }
  return written;
}

export function hasPendingSignOut(): boolean {
  const { stores } = pilotStorages();
  for (const storage of stores) {
    try {
      if (storage.getItem(PENDING_SIGN_OUT_KEY) === '1') return true;
    } catch {
      // An inaccessible store is handled by the caller's visible warning.
    }
  }
  return false;
}

export function clearPendingSignOut(): boolean {
  const { stores, accessFailed } = pilotStorages();
  let cleared = stores.length > 0 && !accessFailed;
  for (const storage of stores) {
    try {
      storage.removeItem(PENDING_SIGN_OUT_KEY);
    } catch {
      cleared = false;
    }
  }
  return cleared;
}

export function clearPilotPrivateState(): boolean {
  const { stores, accessFailed } = pilotStorages();
  if (!stores.length) return false;
  let cleared = !accessFailed;
  for (const storage of stores) {
    try {
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith('little-hanzi:pilot:')) keys.push(key);
      }
      keys.forEach((key) => storage.removeItem(key));
    } catch {
      cleared = false;
    }
  }
  return cleared;
}
