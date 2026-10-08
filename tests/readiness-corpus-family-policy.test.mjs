import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectCorpusProposalInput,
  inspectCorpusApprovalInput,
} from '../lib/pilot/corpus-family-policy.ts';
const d = 'sha256:' + 'a'.repeat(64);
const proposal = {
  corpusVersion: 'synthetic-corpus',
  selection: {
    lessonVersion: 'synthetic-lesson',
    contentDigest: d,
    releaseId: 'synthetic-release',
    releaseRevision: 1,
  },
  predecessorProposalId: null,
  expectedSourceDigest: null,
};
test('R6 exact parent selection preserves original public identities and supports explicit recommendation', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(inspectCorpusProposalInput(proposal))),
    proposal,
  );
  assert.equal(
    inspectCorpusProposalInput({ ...proposal, selection: null }).selection,
    null,
  );
});
test('R6 proposal inspector rejects mixed legacy selectors, invented authority, count and request IDs', () => {
  for (const change of [
    (p) => (p.collectionVersion = 'old'),
    (p) => (p.requestId = 'invented'),
    (p) => delete p.corpusVersion,
    (p) => (p.selection.correctChoiceId = 'future-answer'),
    (p) => (p.selection.releaseRevision = 0),
    (p) => (p.expectedSourceDigest = 'incorrect'),
  ]) {
    const p = structuredClone(proposal);
    change(p);
    assert.throws(() => inspectCorpusProposalInput(p));
  }
});
test('R6 request inspection never invokes accessors and refuses object prototypes before selected property reads', () => {
  let calls = 0;
  const p = { ...proposal };
  Object.defineProperty(p, 'selection', {
    enumerable: true,
    get() {
      calls++;
      return proposal.selection;
    },
  });
  assert.throws(() => inspectCorpusProposalInput(p));
  assert.equal(calls, 0);
  assert.throws(() =>
    inspectCorpusProposalInput(Object.assign(Object.create({}), proposal)),
  );
});
test('R6 approval is exactly immutable proposal+source and never accepts a caller adapter/clock or request ID', () => {
  const input = { proposalId: 'synthetic-proposal', sourceDigest: d };
  assert.deepEqual(
    JSON.parse(JSON.stringify(inspectCorpusApprovalInput(input))),
    input,
  );
  for (const extra of [
    { requestId: 'invented' },
    { adapterId: 'corpus-paired' },
    { clock: 0 },
    { sourceDigest: 'not-a-digest' },
  ])
    assert.throws(() => inspectCorpusApprovalInput({ ...input, ...extra }));
});
