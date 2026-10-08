import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getCurriculumDetail } from '../lib/pilot-curriculum-client.ts';
const root = path.resolve(import.meta.dirname, '..');
const fixture = JSON.parse(
  fs.readFileSync(root + '/content/curriculum/forest-01-v4.json', 'utf8'),
);
function detail(pkg) {
  return {
    package: pkg,
    contentDigest: 'sha256:' + 'a'.repeat(64),
    importedAt: 1,
    testFixture: false,
    reviews: [],
  };
}
async function fetchDetail(pkg) {
  const previous = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(detail(pkg)), {
      headers: { 'content-type': 'application/json' },
    });
  try {
    return await getCurriculumDetail(pkg.lessonVersion);
  } finally {
    globalThis.fetch = previous;
  }
}
test('[R3-E-001/010/015] operator browser import graph cannot reach authoritative package or lesson grading modules', () => {
  const visited = new Set();
  const walk = (file) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s['"]([^'"]+)['"]/g,
    )) {
      if (!match[1].startsWith('.')) continue;
      walk(path.resolve(path.dirname(file), match[1]));
    }
  };
  walk(root + '/lib/pilot-curriculum-client.ts');
  for (const forbidden of [
    'lib/curriculum/validate.ts',
    'lib/curriculum/story-package.ts',
    'lib/preview/content.ts',
    'lib/preview/reducer.ts',
  ])
    assert(
      !visited.has(root + '/' + forbidden),
      'Browser graph reaches ' + forbidden,
    );
});
test('[R3-E-015] operator package response is a display shape, never browser answer-key validation', async () => {
  const pkg = structuredClone(fixture);
  pkg.story.questions[0].correctChoiceId = 'server-authored-display-value';
  const value = await fetchDetail(pkg);
  assert.deepEqual(value.package, pkg);
  assert.notEqual(value.package, pkg);
});
test('[R3-E-010/015] missing malformed display fields fail with sanitized response error', async () => {
  for (const mutate of [
    (p) => delete p.characters,
    (p) => (p.characters[0].readings[0].pinyin = 12),
    (p) => (p.characters[0].wordAssociations[0].context.english = []),
    (p) => (p.assets = {}),
    (p) => (p.steps[0].instructionEnglish = null),
    (p) => (p.title = ''),
    (p) => (p.renderer.capabilities = 42),
  ]) {
    const pkg = structuredClone(fixture);
    mutate(pkg);
    await assert.rejects(
      fetchDetail(pkg),
      (e) =>
        e.code === 'INVALID_RESPONSE' &&
        e.status === 502 &&
        !e.message.includes('server-authored'),
    );
  }
});

test('[R3-E-010/015] display parser safely refuses accessors, hostile objects and oversized JSON', async () => {
  const { parseCurriculumDisplayDocument: parse } =
    await import('../lib/curriculum/display-document.ts');
  let reads = 0;
  const accessor = structuredClone(fixture);
  Object.defineProperty(accessor, 'title', {
    enumerable: true,
    get() {
      reads++;
      throw new Error('secret');
    },
  });
  assert.equal(parse(accessor), null);
  assert.equal(reads, 0);
  const inherited = Object.assign(
    Object.create({ title: 'inherited' }),
    fixture,
  );
  assert.equal(parse(inherited), null);
  const dangerous = JSON.parse(JSON.stringify(fixture));
  Object.defineProperty(dangerous, '__proto__', {
    enumerable: true,
    value: { polluted: true },
  });
  assert.equal(parse(dangerous), null);
  assert.equal({}.polluted, undefined);
  const cyclic = structuredClone(fixture);
  cyclic.extra = cyclic;
  assert.equal(parse(cyclic), null);
  const symbol = structuredClone(fixture);
  symbol[Symbol('extra')] = 'secret';
  assert.equal(parse(symbol), null);
  const sparse = structuredClone(fixture);
  sparse.extra = [];
  sparse.extra.length = 2;
  assert.equal(parse(sparse), null);
  const long = structuredClone(fixture);
  long.extra = 'x'.repeat(16_385);
  assert.equal(parse(long), null);
  const big = structuredClone(fixture);
  big.extra = Array.from({ length: 100 }, () => '木'.repeat(10_000));
  assert.equal(parse(big), null);
  const deep = structuredClone(fixture);
  let nested = deep;
  for (let i = 0; i < 40; i++) {
    nested.extra = {};
    nested = nested.extra;
  }
  assert.equal(parse(deep), null);
  const hostile = new Proxy(fixture, {
    ownKeys() {
      throw new Error('secret');
    },
  });
  assert.equal(parse(hostile), null);
  const nonfinite = structuredClone(fixture);
  nonfinite.extra = Infinity;
  assert.equal(parse(nonfinite), null);
  const hidden = structuredClone(fixture);
  Object.defineProperty(hidden, 'hidden', { value: 'secret' });
  assert.equal(parse(hidden), null);
});

test('[R3-E-015] canonical V2, V4 and simulated positive documents retain operator display data', async () => {
  const { parseCurriculumDisplayDocument: parse } =
    await import('../lib/curriculum/display-document.ts');
  for (const file of [
    'tests/fixtures/curriculum/forest-01-v2.json',
    'content/curriculum/forest-01-v4.json',
    'tests/fixtures/curriculum/forest-01-v4-positive-publication.json',
  ]) {
    const original = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const parsed = parse(original);
    assert.deepEqual(parsed, original);
    assert.notEqual(parsed, original);
    assert.notEqual(parsed.characters, original.characters);
  }
  const extra = structuredClone(fixture);
  extra.story = {
    opaque: 'authenticated server material',
    nested: [null, true, 12],
  };
  assert.deepEqual(parse(extra), extra);
});

test('[R3-E-010/015] array descriptors are copied without reading a Proxy getter', async () => {
  const { parseCurriculumDisplayDocument: parse } =
    await import('../lib/curriculum/display-document.ts');
  const pkg = structuredClone(fixture);
  let reads = 0;
  pkg.characters = new Proxy(pkg.characters, {
    get(target, key, receiver) {
      reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.deepEqual(parse(pkg), fixture);
  assert.equal(reads, 0);
});
