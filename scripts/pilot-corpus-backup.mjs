/** Private V6 validation. Structural acceptance alone is never restore authority. */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
import { inspectJson } from '../lib/curriculum/json.ts';
import { text } from '../lib/curriculum/story-package.ts';
import {
  collectionTableNames,
  collectionSchemaTables,
  collectionColumns,
  historicalCollectionInstallationIds,
} from './pilot-collection-backup.mjs';
import {
  CORPUS_COLUMNS,
  CORPUS_TABLES,
  CORPUS_TYPES,
  CORPUS_NULLABLE,
} from './pilot-corpus-columns.mjs';
import {
  corpusSchemaSource,
  assertCorpusSchema,
} from './pilot-corpus-schema.mjs';
import { validateCorpusRegistryAndLegacyHistory } from './pilot-backup.mjs';
import { validateCorpusRegistryFacts } from './pilot-corpus-registry-backup.mjs';
import { validateCorpusProofFacts } from './pilot-corpus-proof-backup.mjs';
import { validateCorpusSnapshotFacts } from './pilot-corpus-snapshot-backup.mjs';
import { validateCorpusAuthorityFacts } from './pilot-corpus-authority-backup.mjs';
import { validateCorpusSelectionFacts } from './pilot-corpus-selection-backup.mjs';
import { validateCorpusLearningFacts } from './pilot-corpus-learning-backup.mjs';
import { corpusRestoreSteps } from './pilot-corpus-restore-steps.mjs';

export const CORPUS_BACKUP_MAX_BYTES = 128 * 1024 * 1024;
export const corpusTableNames = () => [
  ...collectionTableNames(),
  ...CORPUS_TABLES,
];
export const corpusSchemaTables = () => [
  ...collectionSchemaTables(),
  ...CORPUS_TABLES,
  'pilot_corpus_evidence_epoch',
];
export const corpusColumns = () => ({
  ...collectionColumns(),
  ...CORPUS_COLUMNS,
});
const json = canonicalPackage;
const sha = (v) =>
  crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same = (a, b) => json(a) === json(b);
const textOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  same(Object.keys(v).sort(textOrder), [...keys].sort(textOrder));
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const digest = (v) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const iso = (v) =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
export function corpusBackupInvalid() {
  throw Object.assign(new Error('BACKUP_CORPUS_INVALID'), {
    code: 'BACKUP_CORPUS_INVALID',
  });
}
const check = (v) => {
  if (!v) corpusBackupInvalid();
};
function parsed(text) {
  check(typeof text === 'string');
  const value = JSON.parse(text);
  check(json(value) === text);
  return value;
}

/** Safe copied shape and exact schema; complete semantics are a separate step. */
export function validateCorpusRows(input, source = corpusSchemaSource()) {
  try {
    const inspected = inspectJson(input);
    check(!inspected.errors.length);
    const payload = inspected.value;
    check(
      exact(payload, [
        'format',
        'createdAt',
        'candidateId',
        'sourceInstallationId',
        'migrations',
        'schemaDigest',
        'schema',
        'contentIdentities',
        'tables',
      ]) &&
        payload.format === 'pilot-admin-backup-6' &&
        iso(payload.createdAt) &&
        text(payload.candidateId, 120) &&
        text(payload.sourceInstallationId, 240) &&
        exact(payload.tables, corpusTableNames()) &&
        payload.schemaDigest === sha(payload.schema),
    );
    check(
      Buffer.byteLength(JSON.stringify({ payload, sha256: sha(payload) })) <=
        CORPUS_BACKUP_MAX_BYTES,
    );
    assertCorpusSchema(payload, source);
    for (const name of corpusTableNames())
      check(Array.isArray(payload.tables[name]));
    for (const table of CORPUS_TABLES) {
      for (const row of payload.tables[table]) {
        check(exact(row, CORPUS_COLUMNS[table]));
        for (const [name, value] of Object.entries(row)) {
          if (value === null) {
            check(CORPUS_NULLABLE[table].includes(name));
            continue;
          }
          check(
            CORPUS_TYPES[table][name] === 'INTEGER'
              ? integer(value)
              : typeof value === 'string' &&
                  value.length > 0 &&
                  value.isWellFormed(),
          );
          if (name.endsWith('_digest')) check(digest(value));
          if (name.endsWith('_json')) parsed(value);
        }
      }
    }
    return payload;
  } catch {
    corpusBackupInvalid();
  }
}

export function historicalCorpusInstallationIds(payload) {
  const ids = historicalCollectionInstallationIds(payload);
  for (const table of CORPUS_TABLES) {
    for (const row of payload.tables[table]) {
      if (typeof row.installation_id === 'string') ids.add(row.installation_id);
      if (table === 'pilot_corpus_proof_receipt') {
        const receipt = parsed(row.receipt_json);
        ids.add(receipt.evidenceInstallationId);
        ids.add(receipt.targetInstallationId);
      }
    }
  }
  return ids;
}

/** Additional historical registry stage only; lifecycle/capture/restore still separate. */
export async function validateCorpusRegistryHistory(input, options = {}) {
  try {
    const payload = await validateCorpusRegistryAndLegacyHistory(
      input,
      options,
    );
    await validateCorpusRegistryFacts(payload);
    return payload;
  } catch {
    corpusBackupInvalid();
  }
}

/** Historical proof stage; complete lifecycle validation is still required before restore. */
export async function validateCorpusProofHistory(input, options = {}) {
  try {
    const issuers = structuredClone(options.archiveIssuers ?? []);
    const payload = await validateCorpusRegistryHistory(input, options);
    await validateCorpusProofFacts(payload, issuers);
    return payload;
  } catch {
    corpusBackupInvalid();
  }
}

/** Snapshot history stage; later authority/learning validation still gates restore. */
export async function validateCorpusSnapshotHistory(input, options = {}) {
  try {
    const issuers = structuredClone(options.archiveIssuers ?? []);
    const payload = await validateCorpusRegistryAndLegacyHistory(
      input,
      options,
    );
    const registry = await validateCorpusRegistryFacts(payload);
    const proofs = await validateCorpusProofFacts(payload, issuers);
    await validateCorpusSnapshotFacts(payload, { registry, proofs });
    return payload;
  } catch {
    corpusBackupInvalid();
  }
}

/** Historical group stage; selection/learning/capture/restore remain separately gated. */
export async function validateCorpusAuthorityHistory(input, options = {}) {
  try {
    const issuers = structuredClone(options.archiveIssuers ?? []);
    const payload = await validateCorpusRegistryAndLegacyHistory(
      input,
      options,
    );
    const registry = await validateCorpusRegistryFacts(payload);
    const proofs = await validateCorpusProofFacts(payload, issuers);
    const snapshots = await validateCorpusSnapshotFacts(payload, {
      registry,
      proofs,
    });
    await validateCorpusAuthorityFacts(payload, {
      registry,
      proofs,
      snapshots,
    });
    return payload;
  } catch {
    corpusBackupInvalid();
  }
}

/** Historical parent selection stage; run/event replay and full restore are separate required stages. */
export async function validateCorpusSelectionHistory(input, options = {}) {
  try {
    const issuers = structuredClone(options.archiveIssuers ?? []);
    const payload = await validateCorpusRegistryAndLegacyHistory(
      input,
      options,
    );
    const registry = await validateCorpusRegistryFacts(payload);
    const proofs = await validateCorpusProofFacts(payload, issuers);
    const snapshots = await validateCorpusSnapshotFacts(payload, {
      registry,
      proofs,
    });
    const authority = await validateCorpusAuthorityFacts(payload, {
      registry,
      proofs,
      snapshots,
    });
    await validateCorpusSelectionFacts(payload, {
      registry,
      snapshots,
      authority,
    });
    return payload;
  } catch {
    corpusBackupInvalid();
  }
}

/** Complete historical learning stages; capture/restore and SQL replay remain separately gated. */
export async function validateCorpusLearningHistory(input, options = {}) {
  try {
    const issuers = structuredClone(options.archiveIssuers ?? []);
    const payload = await validateCorpusRegistryAndLegacyHistory(
      input,
      options,
    );
    const registry = await validateCorpusRegistryFacts(payload);
    const proofs = await validateCorpusProofFacts(payload, issuers);
    const snapshots = await validateCorpusSnapshotFacts(payload, {
      registry,
      proofs,
    });
    const authority = await validateCorpusAuthorityFacts(payload, {
      registry,
      proofs,
      snapshots,
    });
    const selection = await validateCorpusSelectionFacts(payload, {
      registry,
      snapshots,
      authority,
    });
    await validateCorpusLearningFacts(payload, {
      registry,
      snapshots,
      authority,
      selection,
    });
    return payload;
  } catch {
    corpusBackupInvalid();
  }
}

/** Complete archive6 validator: semantic union plus exact SQL constraints before effects. */
export async function validatePilotCorpusBackup(input, options = {}) {
  try {
    const source = options.source ?? corpusSchemaSource();
    const payload = await validateCorpusLearningHistory(input, {
      ...options,
      source,
    });
    const installationId = 'archive-validation-' + crypto.randomUUID();
    check(!historicalCorpusInstallationIds(payload).has(installationId));
    const steps = await corpusRestoreSteps(payload);
    const result = spawnSync(
      'python3',
      [
        '-c',
        [
          'import json,sqlite3,sys',
          'v=json.load(sys.stdin); db=sqlite3.connect(":memory:"); db.execute("PRAGMA foreign_keys=ON")',
          'for sql in v["schema"]: db.execute(sql)',
          'db.execute("UPDATE pilot_installation SET installation_id=? WHERE id=1",[v["installationId"]]); db.commit()',
          'db.execute("BEGIN"); db.execute("PRAGMA defer_foreign_keys=ON")',
          'for s in v["steps"]: db.execute(s["sql"],s["args"])',
          'if db.execute("PRAGMA foreign_key_check").fetchall(): raise ValueError("foreign keys")',
          'db.commit(); db.close(); print("VALID")',
        ].join('\n'),
      ],
      {
        input: JSON.stringify({
          schema: source.statements,
          steps,
          installationId,
        }),
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      },
    );
    check(result.status === 0 && result.stdout.trim() === 'VALID');
    return payload;
  } catch {
    corpusBackupInvalid();
  }
}
