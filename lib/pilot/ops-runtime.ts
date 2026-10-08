import { pilotBindings } from './runtime.ts';
import type { PilotSessionContext } from './http.ts';
import type { OpsContext } from './ops-types.ts';
import type { PilotDatabase } from './db.ts';
import {
  OPS_SCHEMA,
  OPS_SCHEMA_V2,
  OPS_SCHEMA_V3,
  OPS_MIGRATIONS_V1,
  OPS_MIGRATIONS_V2,
  OPS_MIGRATIONS_V3,
} from './ops-schema.ts';
import { fail, slug, integer } from './ops-domain.ts';
/** Optional operations binding is touched only after ordinary authentication. */
export async function opsContext(
  session: PilotSessionContext,
): Promise<OpsContext> {
  try {
    const bindings = pilotBindings() as unknown as Record<string, unknown>,
      db = bindings.OPS_DB as PilotDatabase | undefined,
      environment = bindings.HANZI_OPS_ENVIRONMENT;
    if (!db || !slug(environment)) fail('OPS_UNAVAILABLE', 503);
    const learning = await session.db
      .prepare('SELECT installation_id FROM pilot_installation WHERE id=1')
      .first<{ installation_id: string }>();
    const ledger = await db
      .prepare('SELECT * FROM ops_installation WHERE id=1')
      .first<Record<string, unknown>>();
    if (
      !learning ||
      !ledger ||
      !slug(learning.installation_id) ||
      !slug(ledger.installation_id) ||
      ledger.environment !== environment ||
      ledger.learning_installation_id !== learning.installation_id ||
      ![
        'pilot-ops-schema-1',
        'pilot-ops-schema-2',
        'pilot-ops-schema-3',
      ].includes(String(ledger.schema_version))
    )
      fail('OPS_UNAVAILABLE', 503);
    const expectedSchema =
      ledger.schema_version === 'pilot-ops-schema-1'
        ? OPS_SCHEMA
        : ledger.schema_version === 'pilot-ops-schema-2'
          ? OPS_SCHEMA_V2
          : OPS_SCHEMA_V3;
    const expectedMigrations =
      ledger.schema_version === 'pilot-ops-schema-1'
        ? OPS_MIGRATIONS_V1
        : ledger.schema_version === 'pilot-ops-schema-2'
          ? OPS_MIGRATIONS_V2
          : OPS_MIGRATIONS_V3;
    const migration = await db
      .prepare('SELECT * FROM ops_schema_history')
      .all<Record<string, unknown>>();
    if (
      !migration.success ||
      migration.results?.length !== expectedMigrations.length ||
      expectedMigrations.some(
        (m) =>
          !migration.results?.some(
            (r) =>
              r.version === m.version &&
              r.name === m.name &&
              r.checksum === m.sha256,
          ),
      )
    )
      fail('OPS_UNAVAILABLE', 503);
    const schema = await db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'",
      )
      .all<Record<string, unknown>>();
    const normalize = (v: unknown) =>
      String(v).replaceAll(/\s+/g, ' ').trim().replace(/;+$/, '');
    if (
      !schema.success ||
      schema.results?.length !== expectedSchema.length ||
      schema.results.some(
        (r) =>
          !expectedSchema.some(
            (e) =>
              r.type === e.type &&
              r.name === e.name &&
              r.tbl_name === e.tbl_name &&
              normalize(r.sql) === normalize(e.sql),
          ),
      )
    )
      fail('OPS_UNAVAILABLE', 503);
    let now = Date.now;
    const value = bindings.HANZI_OPS_TEST_NOW;
    if (value !== undefined && value !== '') {
      if (
        !session.config.testMode ||
        !session.config.testToken ||
        !session.config.testRunId ||
        !session.config.candidateExplicitlyBound ||
        typeof value !== 'string' ||
        !/^\d+$/.test(value) ||
        !integer(Number(value))
      )
        fail('OPS_UNAVAILABLE', 503);
      now = () => Number(value);
    }
    const fault = bindings.HANZI_OPS_TEST_FAULT;
    if (fault !== undefined && fault !== '') {
      if (
        !session.config.testMode ||
        !session.config.testToken ||
        !session.config.testRunId ||
        !session.config.candidateExplicitlyBound ||
        (fault !== 'feedback-final-write' && fault !== 'alert-final-write')
      )
        fail('OPS_UNAVAILABLE', 503);
    }
    return {
      ...(fault === 'feedback-final-write' || fault === 'alert-final-write'
        ? { testFault: fault }
        : {}),
      db,
      environment,
      installationId: learning.installation_id,
      opsInstallationId: String(ledger.installation_id),
      buildId: session.config.candidateId,
      now,
    };
  } catch {
    fail('OPS_UNAVAILABLE', 503);
  }
}
