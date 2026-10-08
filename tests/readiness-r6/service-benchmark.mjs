/** Exactly twenty warmups and one hundred measured requests per operation. */
import assert from 'node:assert/strict';
export async function runServiceBenchmark(http, binding, oracles, evidence) {
  const h = http.handoff;
  assert.equal(
    h.profile,
    'stress-corpus',
    '800-package benchmark requires stress profile',
  );
  assert.equal(binding.items.length, 800);
  const initial = await http.inspect({ kind: 'counts' });
  assert.equal(
    initial.counts.pilot_corpus_assignment,
    0,
    'Benchmark needs fresh fixture, not completed proof children',
  );
  const rows = new Map(),
    query = '?corpusVersion=' + encodeURIComponent(h.corpusVersion),
    child = (f, suffix) => '/api/pilot/children/' + f.childId + '/' + suffix;
  for (const f of h.families) {
    await http.signIn(f.parentId);
    const r = await http.request(f.parentId, 'PUT', child(f, 'onboarding'), {
      nickname: 'Synthetic benchmark child',
      experience: 'new',
      audioReady: true,
    });
    assert.equal(r.status, 200);
  }
  let cursor = null;
  do {
    const r = await http.request(
      h.families[0].parentId,
      'GET',
      child(h.families[0], 'catalog') +
        query +
        '&limit=50' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    );
    assert.equal(r.status, 200);
    for (const item of r.body.items) rows.set(item.lessonVersion, item);
    cursor = r.body.nextCursor;
  } while (cursor);
  assert.equal(rows.size, 800);
  const state = new Map();
  for (const f of h.families) {
    const r = await http.request(
      f.parentId,
      'GET',
      child(f, 'placement') + query,
    );
    assert.equal(r.status, 200);
    state.set(f.index, r.body.proposal);
  }
  const measurements = { catalog: [], proposal: [] },
    warmups = { catalog: [], proposal: [] };
  async function catalog(f, warm) {
    const r = await http.request(
      f.parentId,
      'GET',
      child(f, 'catalog') + query + '&limit=20',
    );
    const target = warm ? warmups.catalog : measurements.catalog;
    target.push({
      familyIndex: f.index,
      status: r.status,
      serverMs: r.serverMs,
      elapsedMs: r.elapsedMs,
      count: r.body?.items?.length ?? null,
    });
    assert.equal(r.status, 200);
    assert(r.body.items.length <= 20);
    assert.equal(r.body.corpusDigest, h.corpusDigest);
    assert(r.body.items.every((x) => x.available));
  }
  async function proposal(f, n, warm) {
    const item = binding.items[n],
      selected = rows.get(item.lessonVersion),
      old = state.get(f.index);
    assert(selected);
    const r = await http.request(
      f.parentId,
      'POST',
      child(f, 'catalog/proposals'),
      {
        corpusVersion: h.corpusVersion,
        selection: {
          lessonVersion: selected.lessonVersion,
          contentDigest: selected.contentDigest,
          releaseId: selected.releaseId,
          releaseRevision: selected.releaseRevision,
        },
        predecessorProposalId: old?.proposalId ?? null,
        expectedSourceDigest: old?.sourceDigest ?? null,
      },
    );
    (warm ? warmups.proposal : measurements.proposal).push({
      familyIndex: f.index,
      lessonVersion: item.lessonVersion,
      status: r.status,
      serverMs: r.serverMs,
      elapsedMs: r.elapsedMs,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.proposal.lessonVersion, item.lessonVersion);
    state.set(f.index, r.body.proposal);
  }
  const summary = {};
  try {
    for (const f of h.families)
      for (let n = 0; n < 2; n++) {
        await catalog(f, true);
        await proposal(f, 100 + (f.index - 1) * 2 + n, true);
      }
    await Promise.all(
      h.families.map(async (f) => {
        for (let n = 0; n < 10; n++) await catalog(f, false);
      }),
    );
    await Promise.all(
      h.families.map(async (f) => {
        for (let n = 0; n < 10; n++)
          await proposal(f, (f.index - 1) * 10 + n, false);
      }),
    );
    for (const op of ['catalog', 'proposal']) {
      assert.equal(warmups[op].length, 20);
      assert.equal(measurements[op].length, 100);
      assert(measurements[op].every((x) => Number.isFinite(x.serverMs)));
      const sorted = measurements[op]
          .map((x) => x.serverMs)
          .sort((a, b) => a - b),
        p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
      summary[op] = {
        warmups: 20,
        measured: 100,
        sessions: 10,
        p95ServerMs: p95,
        thresholdMs: 1000,
      };
      assert(p95 <= 1000, op + ' server p95 exceeded frozen threshold');
    }
    assert.equal(
      new Set(measurements.proposal.map((x) => x.lessonVersion)).size,
      100,
    );
  } finally {
    const report = {
      schemaVersion: 'r6-local-benchmark-1',
      candidateId: h.candidateId,
      corpusDigest: h.corpusDigest,
      packageCount: 800,
      targetCount: 1600,
      warmups,
      measurements,
      summary,
      method:
        'ten concurrent ordinary synthetic parent sessions; actual HTTP Server-Timing; no mutation retry',
      limitations: [
        'Local Node/libSQL only, not hosted tier/network/device.',
        'Browser usable-page latency measured separately.',
      ],
    };
    evidence('benchmark-measurements', report);
  }
  return summary;
}
