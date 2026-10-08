import test from 'node:test';
import assert from 'node:assert/strict';
import { runCorpusOpsRecovery } from '../scripts/readiness-corpus-ops-recovery.mjs';

test('[R6-E-013/014] paired rehearsal refuses non-R6 or unverified candidates before source or destination effects', async () => {
  let sourceQueries = 0;
  const client = {
    execute: () => {
      sourceQueries++;
      throw Error('Source should not be queried');
    },
  };
  await assert.rejects(
    () => runCorpusOpsRecovery({ manifest: { phase: 'r5' }, client }),
    (e) => e.code === 'OPS_CORPUS_CANDIDATE_REQUIRED',
  );
  await assert.rejects(
    () =>
      runCorpusOpsRecovery({
        manifest: {
          phase: 'r6',
          specVersion: 'r6-spec-2',
          integrationVersion: 'r6-integration-1',
          lessonVersion: 'hanzi-starter-draft-v1',
        },
        client,
      }),
    /owned runner directory/,
  );
  assert.equal(sourceQueries, 0);
});
