/** Controlled promise boundary only; this does not simulate a database or restore. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { bounded } from '../../scripts/readiness-node-runner.mjs';

test('bounded timeout leaves its underlying write promise live', async () => {
  let finish;
  let committed = false;
  const pendingWrite = new Promise((resolve) => {
    finish = () => {
      committed = true;
      resolve();
    };
  });
  await assert.rejects(
    bounded(pendingWrite, 5, 'controlled write'),
    /timed out/,
  );
  assert.equal(
    committed,
    false,
    'a readback here could still observe fresh state',
  );
  finish();
  await pendingWrite;
  assert.equal(
    committed,
    true,
    'timeout alone did not establish a terminal write outcome',
  );
});
