/** Constraint-preserving replay, shared by private validation and fresh restore. */
import {
  collectionRestoreRows,
  collectionColumns,
} from './pilot-collection-backup.mjs';
import { CORPUS_COLUMNS } from './pilot-corpus-columns.mjs';
import { canonicalPackage as json } from '../lib/curriculum/digest.ts';
import {
  compileCorpusRuntime,
  createCorpusRun,
  applyCorpusAction,
} from '../lib/curriculum/corpus-runtime.ts';

const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ident = (v) => '"' + v.replaceAll('"', '""') + '"';
const check = (v) => {
  if (!v) throw new Error('BACKUP_CORPUS_INVALID');
};

/** Input has already passed every historical semantic stage. No current grants. */
export async function corpusRestoreSteps(payload) {
  const t = payload.tables,
    columns = { ...collectionColumns(), ...CORPUS_COLUMNS },
    steps = [];
  function insert(table, row) {
    const cols = columns[table];
    check(cols);
    steps.push({
      sql: `INSERT INTO ${ident(table)}(${cols.map(ident).join(',')}) VALUES(${cols.map(() => '?').join(',')})`,
      args: cols.map((k) => row[k]),
    });
  }
  const append = (table, rows = t[table]) =>
    rows.forEach((row) => insert(table, row));
  const registry = t.pilot_curriculum_registry_state[0];
  steps.push({
    sql: 'UPDATE pilot_curriculum_registry_state SET revision=?,updated_at=? WHERE id=1',
    args: [registry.revision, registry.updated_at],
  });
  for (const { table, row } of collectionRestoreRows(payload))
    insert(table, row);
  append(
    'pilot_corpus_source_evidence',
    [...t.pilot_corpus_source_evidence].sort(
      (a, b) => a.source_ordinal - b.source_ordinal || order(a.id, b.id),
    ),
  );
  for (const table of [
    'pilot_corpus_batch',
    'pilot_corpus',
    'pilot_corpus_item',
    'pilot_corpus_character',
    'pilot_corpus_search_term',
    'pilot_corpus_proof_receipt',
  ])
    append(table);
  const sealing = [
    'status',
    'seal_request_id',
    'seal_request_json',
    'seal_request_digest',
    'seal_ack_json',
    'sealed_at',
  ];
  for (const row of t.pilot_corpus_snapshot) {
    const initial = { ...row, status: 'building' };
    for (const key of sealing.slice(1)) initial[key] = null;
    insert('pilot_corpus_snapshot', initial);
    append(
      'pilot_corpus_snapshot_member',
      t.pilot_corpus_snapshot_member
        .filter((m) => m.snapshot_id === row.id)
        .sort((a, b) => a.member_ordinal - b.member_ordinal),
    );
    if (row.status === 'sealed')
      steps.push({
        sql: `UPDATE pilot_corpus_snapshot SET ${sealing.map((k) => ident(k) + '=?').join(',')} WHERE id=?`,
        args: [...sealing.map((k) => row[k]), row.id],
      });
  }
  append('pilot_corpus_owner_decision');
  const publications = [...t.pilot_corpus_publication].sort(
    (a, b) => a.revision - b.revision || order(a.id, b.id),
  );
  const groupKey = (p) =>
    json([p.corpus_version, p.installation_id, p.namespace_key]);
  const expectedHeads = new Map(
    t.pilot_corpus_publication_state.map((p) => [groupKey(p), p]),
  );
  const reconstructedHeads = new Map();
  for (const p of publications) {
    insert('pilot_corpus_publication', p);
    const head = {
      corpus_version: p.corpus_version,
      installation_id: p.installation_id,
      namespace_key: p.namespace_key,
      latest_publication_id: p.id,
      revision: p.revision,
      updated_at: p.created_at,
    };
    if (p.revision === 1) insert('pilot_corpus_publication_state', head);
    else
      steps.push({
        sql: 'UPDATE pilot_corpus_publication_state SET latest_publication_id=?,revision=?,updated_at=? WHERE corpus_version=? AND installation_id=? AND namespace_key=?',
        args: [
          p.id,
          p.revision,
          p.created_at,
          p.corpus_version,
          p.installation_id,
          p.namespace_key,
        ],
      });
    reconstructedHeads.set(groupKey(p), head);
  }
  check(expectedHeads.size === reconstructedHeads.size);
  for (const [key, value] of reconstructedHeads)
    check(json(value) === json(expectedHeads.get(key)));
  append('pilot_corpus_trial_member');
  append('pilot_corpus_publication_audit');
  append(
    'pilot_corpus_proposal',
    [...t.pilot_corpus_proposal].sort(
      (a, b) => a.selection_ordinal - b.selection_ordinal || order(a.id, b.id),
    ),
  );
  for (const table of [
    'pilot_corpus_plan',
    'pilot_corpus_plan_item',
    'pilot_corpus_assignment',
  ])
    append(table);
  const lessons = new Map(),
    packages = new Map(
      t.pilot_curriculum_package.map((p) => [p.lesson_version, p]),
    );
  for (const initial of [true, false]) {
    append(
      'pilot_corpus_schedule',
      t.pilot_corpus_schedule.filter((s) => (s.kind === 'initial') === initial),
    );
    for (const row of t.pilot_corpus_run.filter(
      (r) => (r.phase === 'initial') === initial,
    )) {
      if (!lessons.has(row.lesson_version))
        lessons.set(
          row.lesson_version,
          await compileCorpusRuntime(
            JSON.parse(packages.get(row.lesson_version).manifest_json),
          ),
        );
      const lesson = lessons.get(row.lesson_version);
      let run = createCorpusRun(lesson, {
        runId: row.id,
        seed: row.seed,
        phase: row.phase,
        now: row.created_at,
      });
      insert('pilot_corpus_run', {
        ...row,
        run_json: json(run),
        revision: 0,
        completed_at: null,
        updated_at: row.created_at,
      });
      const events = t.pilot_corpus_event
        .filter((e) => e.run_id === row.id)
        .sort((a, b) => a.sequence - b.sequence);
      for (const event of events) {
        const result = JSON.parse(event.result_json);
        insert('pilot_corpus_event', event);
        run = applyCorpusAction(lesson, run, JSON.parse(event.action_json), {
          now: event.server_at,
          soundReview: result.policy.soundReview,
        }).run;
        steps.push({
          sql: 'UPDATE pilot_corpus_run SET run_json=?,revision=?,updated_at=?,completed_at=? WHERE id=?',
          args: [
            json(run),
            run.revision,
            event.server_at,
            run.state.completedAt === null
              ? null
              : Date.parse(run.state.completedAt),
            row.id,
          ],
        });
      }
      check(json(run) === row.run_json);
    }
  }
  append('pilot_corpus_learning_audit');
  return steps;
}
