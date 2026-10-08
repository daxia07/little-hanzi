export const PILOT_ROLES = ['child', 'parent', 'teacher', 'operator'] as const;
export type PilotRole = typeof PILOT_ROLES[number];

export interface PilotUserLike {
  id: string;
  name: string;
  username?: string | null;
  role: string;
  mustChangePassword?: boolean | number | null;
  disabled?: boolean | number | null;
}

export interface SafePilotUser {
  id: string;
  name: string;
  username: string;
  role: PilotRole;
  mustChangePassword: boolean;
}

const AUTH_ROUTE_ALLOWLIST = new Set([
  'POST /api/auth/sign-in/username',
  'GET /api/auth/get-session',
  'POST /api/auth/sign-out',
  'POST /api/auth/change-password',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isPilotRole(value: unknown): value is PilotRole {
  return typeof value === 'string' && (PILOT_ROLES as readonly string[]).includes(value);
}

export function isAllowedAuthRoute(method: string, pathname: string): boolean {
  return AUTH_ROUTE_ALLOWLIST.has(`${method.toUpperCase()} ${pathname}`);
}

export function validateIssuedAccountInput(value: unknown): {
  username: string;
  name: string;
  password: string;
  role: PilotRole;
} | null {
  if (!isRecord(value) || !exactKeys(value, ['username', 'name', 'password', 'role'])) return null;
  const username = value.username;
  const name = value.name;
  const password = value.password;
  const role = value.role;
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.]+$/.test(username) || username.length < 3 || username.length > 30) return null;
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 120) return null;
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return null;
  if (!isPilotRole(role)) return null;
  return { username: username.toLowerCase(), name: name.trim(), password, role };
}

export function validatePasswordInput(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) return null;
  return value;
}

/**
 * Validate a credential that already exists in the database before passing it
 * to the auth library for verification. Issued and replacement passwords use
 * validatePasswordInput; an existing credential may be shorter for the
 * initial hosted pilot accounts.
 */
export function validateExistingCredentialInput(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) return null;
  return value;
}

export function safePilotUser(value: PilotUserLike): SafePilotUser {
  const role = isPilotRole(value.role) ? value.role : 'child';
  return {
    id: value.id,
    name: value.name,
    username: typeof value.username === 'string' ? value.username : '',
    role,
    mustChangePassword: value.mustChangePassword === true || value.mustChangePassword === 1,
  };
}

export function canReadChild(actor: Pick<PilotUserLike, 'id' | 'role'>, childId: string, relation: { linked: boolean; granted: boolean }): boolean {
  if (actor.role === 'child') return actor.id === childId;
  if (actor.role === 'parent') return relation.linked;
  if (actor.role === 'teacher') return relation.granted;
  return false;
}

export function canManageAccounts(actor: Pick<PilotUserLike, 'role'>): boolean {
  return actor.role === 'operator';
}

export function isDisabled(value: Pick<PilotUserLike, 'disabled'>): boolean {
  return value.disabled === true || value.disabled === 1;
}
