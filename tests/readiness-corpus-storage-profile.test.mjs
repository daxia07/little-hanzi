import test from 'node:test';
import assert from 'node:assert/strict';
import * as adapter from '../lib/platform/libsql-d1.ts';

// Before a declared capability exists, an unknown D1 interface is unsupported.
const recognized = adapter.isLibsqlD1Database ?? (() => false);
test('[R6-E-006/015] only an adapter constructed by the Node/libSQL factory supports private snapshot storage', () => {
  const client = {
    async execute() {
      throw new Error('No SQL should run during capability inspection');
    },
    async batch() {
      throw new Error('No SQL should run during capability inspection');
    },
  };
  const db = adapter.createLibsqlD1Database(client);
  assert.equal(recognized(db), true);
  assert.equal(recognized({ ...db }), false);
  assert.equal(
    recognized({
      prepare: db.prepare.bind(db),
      batch: db.batch.bind(db),
      kind: 'libsql',
      supportsLargeSnapshots: true,
    }),
    false,
  );
  assert.equal(recognized(new Proxy(db, {})), false);
  assert.equal(recognized(null), false);
  let touched = false;
  const unknown = Object.defineProperty({}, 'kind', {
    get() {
      touched = true;
      return 'libsql';
    },
  });
  assert.equal(recognized(unknown), false);
  assert.equal(touched, false);
});
