/** Private R6 service DB primitives. Identifiers are fixed by server call sites. */
import type { PilotSessionContext } from './http.ts';
import type { CorpusClassification } from '../curriculum/corpus-types.ts';
import type { parseCorpusCapability } from './corpus-policy.ts';
import { fail } from './story-policy.ts';
import { corpusId } from './corpus-policy.ts';
export type CorpusContext = Pick<
  PilotSessionContext,
  'db' | 'config' | 'user' | 'session'
> & {
  corpus: {
    ownerIds: string[];
    fixtureBinding: null | {
      schemaVersion: 'r6-fixture-binding-1';
      installationId: string;
      mode: 'synthetic-only';
    };
    capability: ReturnType<typeof parseCorpusCapability>;
  };
};
export type CorpusRow = Record<string, string | number | null>;
export function sqlValue(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return "'" + value.replaceAll("'", "''") + "'";
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return String(value);
  fail('STORAGE_UNAVAILABLE', 503);
}
export function corpusNow(c: CorpusContext): number {
  const raw = c.config.curriculumTestNow;
  if (raw !== null && raw !== undefined && raw !== '') {
    if (
      !c.config.testMode ||
      !c.config.testContentAllowed ||
      !c.config.testRunId ||
      !c.config.testToken ||
      !c.config.candidateExplicitlyBound ||
      !/^\d+$/u.test(raw) ||
      !Number.isSafeInteger(Number(raw))
    )
      fail('STORAGE_UNAVAILABLE', 503);
    return Number(raw);
  }
  return Date.now();
}
export const corpusISO = (time: unknown) =>
  new Date(Number(time)).toISOString();
export const corpusNewId = (kind: string) => kind + '-' + crypto.randomUUID();
export async function corpusOne(
  c: CorpusContext,
  sql: string,
): Promise<CorpusRow | null> {
  try {
    return await c.db.prepare(sql).first<CorpusRow>();
  } catch {
    fail('STORAGE_UNAVAILABLE', 503);
  }
}
export async function corpusRows(
  c: CorpusContext,
  sql: string,
): Promise<CorpusRow[]> {
  try {
    const r = await c.db.prepare(sql).all<CorpusRow>();
    if (!r.success) fail('STORAGE_UNAVAILABLE', 503);
    return r.results ?? [];
  } catch {
    fail('STORAGE_UNAVAILABLE', 503);
  }
}
export async function corpusBatch(
  c: CorpusContext,
  sql: string[],
): Promise<void> {
  try {
    const r = await c.db.batch(sql.map((s) => c.db.prepare(s)));
    if (r.some((x) => !x.success)) fail('STORAGE_UNAVAILABLE', 503);
  } catch {
    fail('STORAGE_UNAVAILABLE', 503);
  }
}
export function corpusInsert(
  table: string,
  values: Record<string, unknown>,
  guard?: string,
): string {
  const cols = Object.keys(values),
    encoded = cols.map((k) => sqlValue(values[k])).join(',');
  return `INSERT INTO ${table}(${cols.join(',')}) ${guard ? `SELECT ${encoded} WHERE ${guard}` : `VALUES(${encoded})`}`;
}
export function corpusActorGuard(c: CorpusContext, role?: string): string {
  return `EXISTS(SELECT 1 FROM pilot_auth_user u JOIN pilot_auth_session s ON s.user_id=u.id WHERE u.id=${sqlValue(c.user.id)} AND s.id=${sqlValue(c.session.id)} AND s.expires_at>${corpusNow(c)} AND u.role=${sqlValue(role ?? c.user.role)} AND u.disabled=0 AND u.must_change_password=0)`;
}
export async function requireCorpusActor(
  c: CorpusContext,
  role?: string,
): Promise<void> {
  if (role && c.user.role !== role) fail('FORBIDDEN', 403);
  if (
    !(await corpusOne(c, `SELECT 1 AS ok WHERE ${corpusActorGuard(c, role)}`))
  )
    fail('UNAUTHORIZED', 401);
}
export async function corpusInstallation(c: CorpusContext): Promise<string> {
  const r = await corpusOne(
    c,
    'SELECT installation_id FROM pilot_installation WHERE id=1',
  );
  if (!r || typeof r.installation_id !== 'string')
    fail('STORAGE_UNAVAILABLE', 503);
  if (
    c.corpus.fixtureBinding &&
    c.corpus.fixtureBinding.installationId !== r.installation_id
  )
    fail('STORAGE_UNAVAILABLE', 503);
  return r.installation_id;
}
export function corpusClassification(
  c: CorpusContext,
  requested: 'real-source-reviewed' | 'unverified-draft',
  previous?: CorpusClassification,
): CorpusClassification {
  return c.corpus.fixtureBinding || previous === 'verification-fixture'
    ? 'verification-fixture'
    : requested;
}
export const corpusNamespace = (c: CorpusContext) =>
  c.config.testMode ? c.config.testRunId : null;
export function corpusResource(value: unknown): string {
  if (!corpusId(value)) fail('INVALID_REQUEST', 400);
  return value;
}

export function corpusInstallationGuard(installationId: string): string {
  return `EXISTS(SELECT 1 FROM pilot_installation WHERE id=1 AND installation_id=${sqlValue(installationId)})`;
}

/** One final database read binds current actor/session and captured installation together. */
export async function requireCorpusScope(
  c: CorpusContext,
  installationId: string,
): Promise<void> {
  if (
    !(await corpusOne(
      c,
      `SELECT 1 AS ok WHERE ${corpusActorGuard(c, 'operator')} AND ${corpusInstallationGuard(installationId)}`,
    ))
  )
    fail('UNAUTHORIZED', 401);
}
