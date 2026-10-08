/** Normal operator HTTP on fixed isolated negative profile; no fake reviewed corpus. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { corpusProfile } from '../../scripts/readiness-corpus-profiles.mjs';
const zero = 'sha256:' + '0'.repeat(64);
export async function runServiceAdmin(http, binding, manifest, execute) {
  const h = http.handoff,
    base = h.ordinaryNegativeBaseURL,
    op = h.accounts.find((a) => a.role === 'operator').id;
  const prefix = '/api/pilot/corpora/' + encodeURIComponent(h.corpusVersion);
  const request = (method, route, body) =>
    http.request(op, method, route, body, base);
  const inspect = async () => {
    const r = await http.control('/inspect', {
      kind: 'counts',
      target: 'ordinary-negative',
    });
    assert.equal(r.status, 200);
    assert.notEqual(r.body.installationId, h.installationId);
    return r.body;
  };
  const profile = corpusProfile(h.profile),
    directory = path.join(manifest.snapshot, profile.batchDirectory);
  const batches = fs
    .readdirSync(directory)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => JSON.parse(fs.readFileSync(path.join(directory, n), 'utf8')));
  assert(batches.length);
  const items = batches.flatMap((b) => b.items);
  assert.equal(items.length, binding.items.length);
  assert.deepEqual(
    items.map((i) => ({
      lessonVersion: i.lessonVersion,
      contentDigest: i.contentDigest,
    })),
    binding.items,
  );
  const batch = (selected) => ({
    ...structuredClone(batches[0]),
    batchId: 'qa-batch-' + randomUUID(),
    batchVersion: 'qa-batch-' + randomUUID(),
    items: structuredClone(selected),
  });
  const code = (r) => r.body?.error?.code ?? r.body?.code;
  await execute('C03-normalization-and-fixture-dedup', async () => {
    await http.signIn(op, base);
    const before = await inspect();
    const original = batch(items.slice(0, 1));
    const duplicate = structuredClone(original);
    duplicate.items.push(structuredClone(duplicate.items[0]));
    const repeated = await request('POST', prefix + '/batches/validate', {
      batch: duplicate,
    });
    assert.equal(repeated.status, 400);
    assert.equal(code(repeated), 'INVALID_BATCH');
    const selector = structuredClone(original);
    selector.items[0].characters[0].coverageIdentity += '\uFE00';
    const invalid = await request('POST', prefix + '/batches/validate', {
      batch: selector,
    });
    assert.equal(invalid.status, 400);
    assert.equal(code(invalid), 'INVALID_IDENTITY');
    const wrongHan = structuredClone(original);
    wrongHan.items[0].characters[0].coverageIdentity =
      items[0].characters[1].coverageIdentity;
    const mismatch = await request('POST', prefix + '/batches/validate', {
      batch: wrongHan,
    });
    assert.equal(mismatch.status, 200);
    assert.deepEqual(mismatch.body.items[0].errors, [
      { fieldId: 'characters', code: 'BATCH_BINDING' },
    ]);
    const after = await inspect();
    assert.deepEqual(after.counts, before.counts);
    const coverage = await request('GET', prefix + '/coverage?limit=50');
    assert.equal(coverage.status, 200);
    for (const category of [
      'reviewedReady',
      'prospectiveStarter',
      'committedStarter',
    ])
      assert.equal(coverage.body.counts[category], 0);
    return {
      duplicateVersionRefused: true,
      variationSelectorRefused: true,
      wrongLiteralHanFieldRefused: true,
      zeroWrites: true,
      fixtureRealCounts: coverage.body.counts,
      limitation:
        'Eligible cross-package Han dedup and aliases require fixed negative fixture facts; fixture diagnostics never certify genuine coverage.',
    };
  });
  await execute('C03-fixture-distinct-Han-dedup', async () => {
    const directory = path.join(
      manifest.snapshot,
      'tests/fixtures/curriculum/corpus-negative',
    );
    const negative = JSON.parse(
      fs.readFileSync(path.join(directory, 'corpus.json'), 'utf8'),
    );
    const negativeBatch = JSON.parse(
      fs.readFileSync(path.join(directory, 'batch.json'), 'utf8'),
    );
    const sources = JSON.parse(
      fs.readFileSync(path.join(directory, 'source-inputs.json'), 'utf8'),
    );
    assert.equal(negative.items.length, 2);
    for (const item of negative.items) {
      const pkg = JSON.parse(
        fs.readFileSync(
          path.join(directory, item.lessonVersion + '.json'),
          'utf8',
        ),
      );
      assert.deepEqual(
        pkg.characters.map((c) => c.hanzi),
        ['木', '林'],
      );
      const imported = await request('POST', '/api/pilot/curriculum', {
        package: pkg,
      });
      assert.equal(imported.status, 201);
      if (item.lessonVersion === negative.items[1].lessonVersion) {
        const review = JSON.parse(
          fs.readFileSync(
            path.join(directory, 'alias-review-input.json'),
            'utf8',
          ),
        );
        assert(review.reason.includes('No human review'));
        const simulated = await request(
          'POST',
          '/api/pilot/curriculum/' + item.lessonVersion + '/reviews',
          review,
        );
        assert.equal(simulated.status, 201);
      }
      const source = await request(
        'POST',
        '/api/pilot/corpora/' + negative.corpusVersion + '/source-evidence',
        sources.find((x) => x.lessonVersion === item.lessonVersion),
      );
      assert.equal(source.status, 200);
    }
    const batchSaved = await request(
      'POST',
      '/api/pilot/corpora/' + negative.corpusVersion + '/batches',
      { requestId: 'qa-negative-dedup-batch-request', batch: negativeBatch },
    );
    assert.equal(batchSaved.status, 200);
    const registered = await request('POST', '/api/pilot/corpora', {
      corpus: negative,
    });
    assert.equal(registered.status, 200);
    const seen = [],
      versions = new Set();
    let cursor;
    do {
      const r = await request(
        'GET',
        '/api/pilot/corpora/' +
          negative.corpusVersion +
          '/coverage?limit=1' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      );
      assert.equal(r.status, 200);
      assert.equal(
        r.body.fixtureCharacterCount,
        2,
        'Repeated fixture Han identities must count twice total, not four',
      );
      assert.equal(r.body.verificationPackageCount, 2);
      for (const key of [
        'reviewedReady',
        'prospectiveStarter',
        'committedStarter',
      ])
        assert.equal(r.body.counts[key], 0);
      for (const member of r.body.items) {
        assert.equal(member.classification, 'verification-fixture');
        assert.equal(member.eligible, false);
        assert(member.reasonCodes.includes('FIXTURE'));
        assert(member.reasonCodes.includes('PACKAGE_INELIGIBLE'));
        for (const reason of [
          'MISSING_LICENSE',
          'UNREVIEWED_AUDIO',
          'INVALID_PROOF',
        ])
          assert(member.reasonCodes.includes(reason), reason);
        if (member.lessonVersion === negative.items[0].lessonVersion)
          assert(member.reasonCodes.includes('UNREVIEWED_CONTENT'));
        if (
          member.lessonVersion === negative.items[1].lessonVersion &&
          member.characterId === 'char-6728'
        )
          assert(member.reasonCodes.includes('ALIAS'));
        seen.push(member);
        versions.add(member.lessonVersion);
      }
      cursor = r.body.nextCursor;
    } while (cursor);
    assert.equal(seen.length, 4);
    assert.equal(versions.size, 2);
    assert.deepEqual(
      [...new Set(seen.map((x) => x.coverageIdentity))].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
      ['木', '林'],
    );
    return {
      syntheticPackages: 2,
      targetRows: 4,
      distinctFixtureHan: 2,
      realEligible: 0,
      exclusions: seen.map((x) => ({
        lessonVersion: x.lessonVersion,
        characterId: x.characterId,
        reasonCodes: x.reasonCodes,
      })),
      limitation:
        'Fixture diagnostic dedup; does not certify eligible DUPLICATE_IDENTITY or human-reviewed coverage.',
    };
  });
  await execute('C04-field-errors-and-source-review-denial', async () => {
    const before = await inspect(),
      original = batch(items.slice(0, 1)),
      results = [];
    for (const field of ['contentDigest', 'characters', 'placement']) {
      const mutated = structuredClone(original);
      if (field === 'contentDigest') mutated.items[0].contentDigest = zero;
      if (field === 'characters') mutated.items[0].characters.reverse();
      if (field === 'placement') mutated.items[0].sequence++;
      const r = await request('POST', prefix + '/batches/validate', {
        batch: mutated,
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.items[0].state, 'rejected');
      assert.deepEqual(r.body.items[0].errors, [
        { fieldId: field, code: 'BATCH_BINDING' },
      ]);
      results.push({ field, errors: r.body.items[0].errors });
    }
    const first = items[0];
    const source = {
      requestId: randomUUID(),
      lessonVersion: first.lessonVersion,
      contentDigest: first.contentDigest,
      classification: 'real-source-reviewed',
      sourceRefs: first.sourceRefs,
      licenseRefs: first.licenseRefs,
      reviewRefs: [],
      identityReviews: [],
      predecessorEvidenceId: null,
      expectedEvidenceDigest: null,
    };
    const denied = await request('POST', prefix + '/source-evidence', source);
    assert.equal(denied.status, 400);
    assert.equal(code(denied), 'SOURCE_REVIEW_REQUIRED');
    for (const field of ['sourceRefs', 'licenseRefs', 'identityReviews']) {
      const missing = structuredClone(source);
      delete missing[field];
      const r = await request('POST', prefix + '/source-evidence', missing);
      assert.equal(r.status, 400);
      assert(['INVALID_REQUEST', 'INVALID_SOURCE'].includes(code(r)));
      results.push({ field, code: code(r) });
    }
    assert.deepEqual((await inspect()).counts, before.counts);
    return {
      results,
      unreviewedSourceDenied: code(denied),
      zeroWrites: true,
      limitation:
        'No invented approved source/licence/audio reviews; independently removing each fact from a genuine eligible package is externally unavailable.',
    };
  });
  await execute('C04-required-package-field-refusals', async () => {
    const before = await inspect(),
      template = JSON.parse(
        fs.readFileSync(
          path.join(
            manifest.snapshot,
            'tests/fixtures/curriculum/corpus-negative/qa-negative-paired-01-v1.json',
          ),
          'utf8',
        ),
      );
    const variants = [
        {
          field: 'readings',
          mutate: (p) => {
            p.characters[0].readings = [];
          },
        },
        {
          field: 'wordAssociations',
          mutate: (p) => {
            p.characters[0].wordAssociations =
              p.characters[0].wordAssociations.slice(0, 1);
          },
        },
        {
          field: 'context',
          mutate: (p) => {
            delete p.characters[0].wordAssociations[0].context.english;
          },
        },
        {
          field: 'assets',
          mutate: (p) => {
            p.assets = [];
          },
        },
        {
          field: 'reviewCheckId',
          mutate: (p) => {
            delete p.pairedStory.targets[0].reviewCheckId;
          },
        },
      ],
      results = [];
    for (const variant of variants) {
      const pkg = structuredClone(template);
      pkg.lessonVersion =
        'qa-negative-missing-' + variant.field.toLowerCase() + '-v1';
      variant.mutate(pkg);
      const r = await request('POST', '/api/pilot/curriculum', {
        package: pkg,
      });
      assert.equal(r.status, 400);
      assert.equal(code(r), 'INVALID_PACKAGE');
      assert(Array.isArray(r.body.errors) && r.body.errors.length > 0);
      results.push({
        field: variant.field,
        status: r.status,
        errors: r.body.errors,
      });
    }
    assert.deepEqual((await inspect()).counts, before.counts);
    return {
      results,
      zeroWrites: true,
      method:
        'Fixed pending synthetic bytes; one required structural field changed per request. Import validation refusal is not a genuine eligibility count.',
    };
  });
  await execute('C05-batch-size-validation-save-replay', async () => {
    const before = await inspect(),
      sizes = [0, 1, Math.min(50, items.length), 51],
      results = [];
    for (const size of new Set(sizes)) {
      const selected = Array.from(
        { length: size },
        (_, i) => items[i % items.length],
      );
      const input = batch(selected),
        r = await request('POST', prefix + '/batches/validate', {
          batch: input,
        });
      assert.equal(r.status, size === 0 || size === 51 ? 400 : 200);
      if (r.status === 400) assert.equal(code(r), 'INVALID_BATCH');
      else {
        assert.equal(r.body.items.length, size);
        assert(r.body.items.every((i) => i.state === 'accepted'));
      }
      results.push({ size, status: r.status, code: code(r) ?? null });
    }
    const unknown = await request('POST', prefix + '/batches/validate', {
      batch: batch(items.slice(0, 1)),
      claimedCount: 1600,
    });
    assert.equal(unknown.status, 400);
    assert.equal(code(unknown), 'INVALID_REQUEST');
    assert.deepEqual(
      (await inspect()).counts,
      before.counts,
      'Read-only batch validation wrote facts',
    );
    const savedInput = {
      requestId: randomUUID(),
      batch: batch(items.slice(0, Math.min(50, items.length))),
    };
    const saved = await request('POST', prefix + '/batches', savedInput);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.items.length, savedInput.batch.items.length);
    const after = await inspect();
    assert.equal(
      after.counts.pilot_corpus_batch,
      before.counts.pilot_corpus_batch + 1,
    );
    const replay = await request('POST', prefix + '/batches', savedInput);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, saved.body);
    assert.deepEqual((await inspect()).counts, after.counts);
    const changed = structuredClone(savedInput);
    changed.batch.items[0].contentDigest = zero;
    const conflict = await request('POST', prefix + '/batches', changed);
    assert.equal(conflict.status, 409);
    assert.equal(code(conflict), 'REQUEST_CONFLICT');
    assert.deepEqual((await inspect()).counts, after.counts);
    const readback = await request(
      'GET',
      prefix + '/batches/' + saved.body.batchId,
    );
    assert.equal(readback.status, 200);
    assert.equal(readback.body.batchId, saved.body.batchId);
    assert.equal(readback.body.manifestDigest, saved.body.manifestDigest);
    return {
      results,
      savedSize: savedInput.batch.items.length,
      exactReplay: true,
      changedBodyConflict: true,
      valid50:
        h.profile === 'stress-corpus'
          ? 'executed'
          : 'Requires stress-corpus run; draft only has ten distinct package versions.',
    };
  });
}
