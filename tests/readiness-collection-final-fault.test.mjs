// Narrow actual faultFinal boundary with a statement-recording DB, not app proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(
  new URL('../scripts/readiness-story-node-runner.mjs', import.meta.url),
  'utf8',
);
const start = source.indexOf('  async function faultFinal('),
  end = source.indexOf('  async function cleanup()', start);
assert(start >= 0 && end > start);
function boundary(phase) {
  const evidence = [],
    ordinary = [];
  const make = vm.compileFunction(
    source.slice(start, end) + ';return faultFinal;',
    ['manifest', 'client', 'targetClient', 'namespace', 'scope', 'targetScope'],
  );
  return {
    evidence,
    ordinary,
    run: make(
      { phase },
      { execute: async (sql) => evidence.push(sql) },
      { execute: async (sql) => ordinary.push(sql) },
      'owned-namespace',
      { installationId: 'evidence-owned' },
      { installationId: 'target-owned' },
    ),
  };
}
test('R5 final-write controls target collection audit and exact selected installation/namespace', async () => {
  for (const operation of ['plan', 'action'])
    for (const target of [undefined, 'ordinary']) {
      const b = boundary('r5');
      await b.run({ operation, enabled: true, target });
      const statements = target ? b.ordinary : b.evidence;
      assert.equal(statements.length, 2);
      const sql = statements[1];
      assert(sql.includes('BEFORE INSERT ON pilot_collection_learning_audit'));
      assert(
        sql.includes(
          operation === 'plan'
            ? 'FROM pilot_collection_plan'
            : 'FROM pilot_collection_run',
        ),
      );
      assert(
        sql.includes(
          `installation_id='${target ? 'target-owned' : 'evidence-owned'}'`,
        ),
      );
      assert(
        sql.includes(
          target ? 'test_run_id IS NULL' : "test_run_id IS 'owned-namespace'",
        ),
      );
      assert(sql.includes("RAISE(ABORT,'QA_R3_FINAL_WRITE')"));
    }
});
test('preserved R3/R4 plan/action and shared publication fault targets stay unchanged; disabling only drops own trigger', async () => {
  for (const phase of ['r3', 'r4', 'r5'])
    for (const operation of ['plan', 'action', 'publication']) {
      const b = boundary(phase);
      await b.run({ operation, enabled: true });
      const sql = b.evidence[1];
      if (operation === 'publication')
        assert(
          sql.includes('BEFORE INSERT ON pilot_curriculum_publication_audit'),
        );
      else if (phase !== 'r5')
        assert(
          sql.includes('BEFORE INSERT ON pilot_curriculum_learning_audit'),
        );
      const disabled = boundary(phase);
      await disabled.run({ operation, enabled: false });
      assert.deepEqual(disabled.evidence, [
        `DROP TRIGGER IF EXISTS qa_r3_final_${operation}`,
      ]);
    }
});
