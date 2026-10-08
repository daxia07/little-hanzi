import { hashPassword } from 'better-auth/crypto';
import {
  isDisabled,
  isPilotRole,
  type PilotRole,
  type SafePilotUser,
  safePilotUser,
} from './policy.ts';

export interface PilotDatabase {
  prepare(query: string): D1PreparedStatement;
  batch<T extends D1PreparedStatement>(statements: T[]): Promise<D1Result<T>[]>;
}

export interface PilotUserRecord extends SafePilotUser {
  disabled: boolean;
  email?: string;
}

export interface ProvisionPilotAccountInput {
  username: string;
  name: string;
  password: string;
  role: PilotRole;
  mustChangePassword?: boolean;
  disabled?: boolean;
  actorUserId?: string | null;
  now?: number;
}

export interface PilotLinkRecord {
  parentId: string;
  childId: string;
  createdAt: number;
}

export interface PilotGrantRecord {
  childId: string;
  teacherId: string;
  grantingParentId: string;
  createdAt: number;
}

export interface PilotGrantView extends PilotGrantRecord {
  teacherName: string;
  teacherDisabled: boolean;
  childName: string;
  childDisabled: boolean;
}

export class PilotDbError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'INVALID_REQUEST'
    | 'STORAGE_UNAVAILABLE'
    | 'ONBOARDING_REQUIRED'
    | 'LESSON_NOT_RELEASED'
    | 'ASSIGNMENT_REQUIRED'
    | 'STALE_REVISION'
    | 'EVENT_CONFLICT'
    | 'INVALID_TRANSITION'
    | 'REVIEW_NOT_DUE';
  readonly status: 400 | 404 | 409 | 503;

  constructor(code: PilotDbError['code'], message: string) {
    super(message);
    this.name = 'PilotDbError';
    this.code = code;
    this.status = code === 'NOT_FOUND' ? 404
      : code === 'INVALID_REQUEST' ? 400
        : code === 'STORAGE_UNAVAILABLE' ? 503
          : 409;
  }
}

const USER_FIELDS = 'id,name,username,role,must_change_password,disabled,email,created_at,updated_at';

function nowMs(input?: number): number {
  return Number.isFinite(input) ? Number(input) : Date.now();
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function internalEmail(username: string): string {
  return `${username}.${crypto.randomUUID()}@accounts.invalid`;
}

function rowToUser(row: Record<string, unknown>): PilotUserRecord {
  const safe = safePilotUser({
    id: String(row.id),
    name: String(row.name),
    username: typeof row.username === 'string' ? row.username : '',
    role: String(row.role),
    mustChangePassword: row.must_change_password as boolean | number | null | undefined,
    disabled: row.disabled as boolean | number | null | undefined,
  });
  return { ...safe, disabled: isDisabled({ disabled: row.disabled as boolean | number }), email: typeof row.email === 'string' ? row.email : undefined };
}

function metadata(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function auditStatement(db: PilotDatabase, action: string, actorUserId: string | null, targetUserId: string | null, details: Record<string, unknown>, at: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO pilot_account_audit
    (id,action,actor_user_id,target_user_id,metadata,created_at) VALUES(?,?,?,?,?,?)`).bind(id('audit'), action, actorUserId, targetUserId, metadata(details), at);
}

async function first<T>(db: PilotDatabase, query: string, values: unknown[] = []): Promise<T | null> {
  try {
    return await db.prepare(query).bind(...values).first<T>();
  } catch {
    throw new PilotDbError('STORAGE_UNAVAILABLE', 'pilot storage is unavailable');
  }
}

async function all<T>(db: PilotDatabase, query: string, values: unknown[] = []): Promise<T[]> {
  try {
    const result = await db.prepare(query).bind(...values).all<T>();
    return result.results;
  } catch {
    throw new PilotDbError('STORAGE_UNAVAILABLE', 'pilot storage is unavailable');
  }
}

async function batch(db: PilotDatabase, statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
  try {
    return await db.batch(statements) as D1Result<unknown>[];
  } catch (caught) {
    const message = caught instanceof Error ? caught.message.toLowerCase() : '';
    if (message.includes('unique') || message.includes('constraint')) throw new PilotDbError('CONFLICT', 'the account or relationship already exists');
    throw new PilotDbError('STORAGE_UNAVAILABLE', 'pilot storage is unavailable');
  }
}

function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new PilotDbError('INVALID_REQUEST', 'password does not meet the required length');
}

function assertProvisionInput(input: ProvisionPilotAccountInput): void {
  if (!input || typeof input.username !== 'string' || !/^[A-Za-z0-9_.]+$/.test(input.username) || input.username.length < 3 || input.username.length > 30) throw new PilotDbError('INVALID_REQUEST', 'username is invalid');
  if (typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.length > 120) throw new PilotDbError('INVALID_REQUEST', 'name is invalid');
  assertPassword(input.password);
  if (!isPilotRole(input.role)) throw new PilotDbError('INVALID_REQUEST', 'role is invalid');
}

export async function getPilotUser(db: PilotDatabase, userId: string): Promise<PilotUserRecord | null> {
  const row = await first<Record<string, unknown>>(db, `SELECT ${USER_FIELDS} FROM pilot_auth_user WHERE id=?`, [userId]);
  return row ? rowToUser(row) : null;
}

export async function getPilotUserByUsername(db: PilotDatabase, username: string): Promise<PilotUserRecord | null> {
  const row = await first<Record<string, unknown>>(db, `SELECT ${USER_FIELDS} FROM pilot_auth_user WHERE username=?`, [username.toLowerCase()]);
  return row ? rowToUser(row) : null;
}

export async function listPilotUsers(db: PilotDatabase): Promise<PilotUserRecord[]> {
  const rows = await all<Record<string, unknown>>(db, `SELECT ${USER_FIELDS} FROM pilot_auth_user ORDER BY created_at,id`);
  return rows.map(rowToUser);
}

export async function provisionPilotAccount(db: PilotDatabase, input: ProvisionPilotAccountInput): Promise<PilotUserRecord> {
  assertProvisionInput(input);
  return (async () => {
    const userId = id('user');
    const accountId = id('account');
    const now = nowMs(input.now);
    const passwordHash = await hashPassword(input.password);
    const username = input.username.toLowerCase();
    const user = {
      id: userId,
      name: input.name.trim(),
      username,
      displayUsername: input.username,
      email: internalEmail(username),
      role: input.role,
      mustChangePassword: input.mustChangePassword ?? true,
      disabled: input.disabled ?? false,
    };
    const statements = [
      db.prepare(`INSERT INTO pilot_auth_user
        (id,name,email,email_verified,image,created_at,updated_at,username,display_username,role,must_change_password,disabled)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(user.id, user.name, user.email, 1, null, now, now, user.username, user.displayUsername, user.role, user.mustChangePassword ? 1 : 0, user.disabled ? 1 : 0),
      db.prepare(`INSERT INTO pilot_auth_account
        (id,account_id,provider_id,user_id,access_token,refresh_token,id_token,access_token_expires_at,refresh_token_expires_at,scope,password,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(accountId, userId, 'credential', userId, null, null, null, null, null, null, passwordHash, now, now),
      auditStatement(db, 'account.issue', input.actorUserId ?? null, userId, { username: user.username, role: user.role }, now),
    ];
    await batch(db, statements);
    return {
      id: userId,
      name: user.name,
      username: user.username,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      disabled: user.disabled,
      email: undefined,
    };
  })();
}

export async function resetPilotPassword(db: PilotDatabase, targetUserId: string, password: string, actorUserId: string, at?: number): Promise<PilotUserRecord> {
  assertPassword(password);
  return (async () => {
    const target = await getPilotUser(db, targetUserId);
    const credential = await first<{ id: string }>(db, `SELECT id FROM pilot_auth_account WHERE user_id=? AND provider_id='credential'`, [targetUserId]);
    if (!target || !credential) throw new PilotDbError('NOT_FOUND', 'account was not found');
    const passwordHash = await hashPassword(password);
    const now = nowMs(at);
    await batch(db, [
      db.prepare('UPDATE pilot_auth_account SET password=?,updated_at=? WHERE id=?').bind(passwordHash, now, credential.id),
      db.prepare('UPDATE pilot_auth_user SET must_change_password=1,updated_at=? WHERE id=?').bind(now, targetUserId),
      db.prepare('DELETE FROM pilot_auth_session WHERE user_id=?').bind(targetUserId),
      auditStatement(db, 'account.password-reset', actorUserId, targetUserId, {}, now),
    ]);
    return (await getPilotUser(db, targetUserId)) as PilotUserRecord;
  })();
}

export async function setPilotAccountStatus(db: PilotDatabase, targetUserId: string, disabled: boolean, actorUserId: string, at?: number): Promise<PilotUserRecord> {
  return (async () => {
    const target = await getPilotUser(db, targetUserId);
    if (!target) throw new PilotDbError('NOT_FOUND', 'account was not found');
    const now = nowMs(at);
    const statements: D1PreparedStatement[] = [
      db.prepare('UPDATE pilot_auth_user SET disabled=?,updated_at=? WHERE id=?').bind(disabled ? 1 : 0, now, targetUserId),
    ];
    if (disabled) statements.push(db.prepare('DELETE FROM pilot_auth_session WHERE user_id=?').bind(targetUserId));
    statements.push(auditStatement(db, disabled ? 'account.disable' : 'account.enable', actorUserId, targetUserId, { disabled }, now));
    await batch(db, statements);
    return (await getPilotUser(db, targetUserId)) as PilotUserRecord;
  })();
}

async function requireRoleUser(db: PilotDatabase, userId: string, role: PilotRole, options: { allowDisabled?: boolean } = {}): Promise<PilotUserRecord> {
  const user = await getPilotUser(db, userId);
  if (!user || user.role !== role || (user.disabled && !options.allowDisabled)) throw new PilotDbError('INVALID_REQUEST', `the account must have role ${role}`);
  return user;
}

export async function listChildrenForUser(db: PilotDatabase, user: PilotUserRecord): Promise<SafePilotUser[]> {
  if (user.role === 'operator') return [];
  if (user.role === 'child') return [safePilotUser(user)];
  const rows = user.role === 'parent'
    ? await all<Record<string, unknown>>(db, `SELECT u.${USER_FIELDS.replaceAll(',', ',u.')} FROM pilot_parent_child l JOIN pilot_auth_user u ON u.id=l.child_id WHERE l.parent_id=? AND u.disabled=0 ORDER BY u.created_at,u.id`, [user.id])
    : await all<Record<string, unknown>>(db, `SELECT DISTINCT u.${USER_FIELDS.replaceAll(',', ',u.')} FROM pilot_teacher_grant g JOIN pilot_parent_child l ON l.parent_id=g.granting_parent_id AND l.child_id=g.child_id JOIN pilot_auth_user p ON p.id=l.parent_id JOIN pilot_auth_user u ON u.id=l.child_id WHERE g.teacher_id=? AND p.disabled=0 AND u.disabled=0 ORDER BY u.created_at,u.id`, [user.id]);
  return rows.map(rowToUser).map(safePilotUser);
}

export async function getChildIfReadable(db: PilotDatabase, actor: PilotUserRecord, childId: string): Promise<SafePilotUser | null> {
  const child = await getPilotUser(db, childId);
  if (!child || child.role !== 'child' || child.disabled) return null;
  if (actor.role === 'child') return actor.id === childId ? safePilotUser(child) : null;
  if (actor.role === 'parent') {
    const link = await first<{ parent_id: string }>(db, 'SELECT parent_id FROM pilot_parent_child WHERE parent_id=? AND child_id=?', [actor.id, childId]);
    return link ? safePilotUser(child) : null;
  }
  if (actor.role === 'teacher') {
    const grant = await first<{ teacher_id: string }>(db, 'SELECT g.teacher_id FROM pilot_teacher_grant g JOIN pilot_parent_child l ON l.parent_id=g.granting_parent_id AND l.child_id=g.child_id JOIN pilot_auth_user p ON p.id=l.parent_id WHERE g.teacher_id=? AND g.child_id=? AND p.disabled=0', [actor.id, childId]);
    return grant ? safePilotUser(child) : null;
  }
  return null;
}

export async function linkParentChild(db: PilotDatabase, actorUserId: string, parentId: string, childId: string, at?: number): Promise<PilotLinkRecord> {
  await requireRoleUser(db, parentId, 'parent');
  await requireRoleUser(db, childId, 'child');
  const now = nowMs(at);
  const existing = await first<{ parent_id: string; child_id: string; created_at: number }>(db, 'SELECT parent_id,child_id,created_at FROM pilot_parent_child WHERE parent_id=? AND child_id=?', [parentId, childId]);
  if (existing) return { parentId: existing.parent_id, childId: existing.child_id, createdAt: existing.created_at };
  await batch(db, [
    db.prepare('INSERT INTO pilot_parent_child(parent_id,child_id,created_at,created_by) VALUES(?,?,?,?)').bind(parentId, childId, now, actorUserId),
    auditStatement(db, 'link.create', actorUserId, childId, { parentId, childId }, now),
  ]);
  return { parentId, childId, createdAt: now };
}

export async function unlinkParentChild(db: PilotDatabase, actorUserId: string, parentId: string, childId: string, at?: number): Promise<boolean> {
  await requireRoleUser(db, parentId, 'parent', { allowDisabled: true });
  await requireRoleUser(db, childId, 'child', { allowDisabled: true });
  const existing = await first<{ parent_id: string }>(db, 'SELECT parent_id FROM pilot_parent_child WHERE parent_id=? AND child_id=?', [parentId, childId]);
  if (!existing) return false;
  const now = nowMs(at);
  await batch(db, [
    db.prepare('DELETE FROM pilot_parent_child WHERE parent_id=? AND child_id=?').bind(parentId, childId),
    auditStatement(db, 'link.remove', actorUserId, childId, { parentId, childId }, now),
  ]);
  return true;
}

export async function grantTeacher(db: PilotDatabase, actorUserId: string, childId: string, teacherId: string, at?: number): Promise<PilotGrantRecord> {
  await requireRoleUser(db, actorUserId, 'parent');
  await requireRoleUser(db, childId, 'child');
  await requireRoleUser(db, teacherId, 'teacher');
  const linked = await first<{ parent_id: string }>(db, 'SELECT parent_id FROM pilot_parent_child WHERE parent_id=? AND child_id=?', [actorUserId, childId]);
  if (!linked) throw new PilotDbError('NOT_FOUND', 'the child is not linked to this parent');
  const existing = await first<{ child_id: string; teacher_id: string; granting_parent_id: string; created_at: number }>(db, 'SELECT child_id,teacher_id,granting_parent_id,created_at FROM pilot_teacher_grant WHERE child_id=? AND teacher_id=? AND granting_parent_id=?', [childId, teacherId, actorUserId]);
  if (existing) return { childId: existing.child_id, teacherId: existing.teacher_id, grantingParentId: existing.granting_parent_id, createdAt: existing.created_at };
  const now = nowMs(at);
  await batch(db, [
    db.prepare('INSERT INTO pilot_teacher_grant(child_id,teacher_id,granting_parent_id,created_at) VALUES(?,?,?,?)').bind(childId, teacherId, actorUserId, now),
    auditStatement(db, 'grant.create', actorUserId, childId, { childId, teacherId, grantingParentId: actorUserId }, now),
  ]);
  return { childId, teacherId, grantingParentId: actorUserId, createdAt: now };
}

export async function revokeTeacher(db: PilotDatabase, actorUserId: string, childId: string, teacherId: string, at?: number): Promise<boolean> {
  await requireRoleUser(db, actorUserId, 'parent');
  await requireRoleUser(db, childId, 'child', { allowDisabled: true });
  // Removing access remains possible while either target is disabled.
  // Creation still requires enabled targets; ownership remains parent-scoped.
  await requireRoleUser(db, teacherId, 'teacher', { allowDisabled: true });
  const existing = await first<{ child_id: string; teacher_id: string; granting_parent_id: string }>(db, 'SELECT child_id,teacher_id,granting_parent_id FROM pilot_teacher_grant WHERE child_id=? AND teacher_id=? AND granting_parent_id=?', [childId, teacherId, actorUserId]);
  if (!existing) return false;
  const now = nowMs(at);
  await batch(db, [
    db.prepare('DELETE FROM pilot_teacher_grant WHERE child_id=? AND teacher_id=? AND granting_parent_id=?').bind(childId, teacherId, actorUserId),
    auditStatement(db, 'grant.remove', actorUserId, childId, { childId, teacherId, grantingParentId: actorUserId }, now),
  ]);
  return true;
}

export async function listGrantsForChild(db: PilotDatabase, childId: string): Promise<PilotGrantRecord[]> {
  const rows = await all<Record<string, unknown>>(db, 'SELECT child_id,teacher_id,granting_parent_id,created_at FROM pilot_teacher_grant WHERE child_id=? ORDER BY created_at,teacher_id,granting_parent_id', [childId]);
  return rows.map((row) => ({ childId: String(row.child_id), teacherId: String(row.teacher_id), grantingParentId: String(row.granting_parent_id), createdAt: Number(row.created_at) }));
}

export async function listGrantsForParent(db: PilotDatabase, parentId: string): Promise<PilotGrantView[]> {
  const rows = await all<Record<string, unknown>>(db, `SELECT g.child_id,g.teacher_id,g.granting_parent_id,g.created_at,t.name AS teacher_name,t.disabled AS teacher_disabled,c.name AS child_name,c.disabled AS child_disabled
    FROM pilot_teacher_grant g
    JOIN pilot_parent_child l ON l.parent_id=g.granting_parent_id AND l.child_id=g.child_id
    JOIN pilot_auth_user t ON t.id=g.teacher_id
    JOIN pilot_auth_user c ON c.id=g.child_id
    WHERE g.granting_parent_id=?
    ORDER BY g.created_at,g.child_id,g.teacher_id`, [parentId]);
  return rows.map((row) => ({
    childId: String(row.child_id),
    teacherId: String(row.teacher_id),
    grantingParentId: String(row.granting_parent_id),
    createdAt: Number(row.created_at),
    teacherName: String(row.teacher_name),
    teacherDisabled: Number(row.teacher_disabled) === 1,
    childName: String(row.child_name),
    childDisabled: Number(row.child_disabled) === 1,
  }));
}
