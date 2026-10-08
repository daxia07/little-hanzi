import { inspectCorpusLearningQuery } from '../lib/pilot/corpus-learning-policy.ts';
import { parseCorpusBindings } from '../lib/pilot/corpus-config.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { validateCurriculumPackage } from '../lib/curriculum/validate.ts';
import { curriculumDigest } from '../lib/curriculum/digest.ts';
import { hasCompleteCurriculumProvenance } from '../lib/curriculum/review.ts';
import { exact, compileStoryPackage } from '../lib/curriculum/story-package.ts';
import { StoryError } from '../lib/pilot/story-policy.ts';

const intendedPath = new URL(
  '../content/curriculum/forest-01-v4.json',
  import.meta.url,
);
const fixturePath = new URL(
  './fixtures/curriculum/forest-01-v4-positive-publication.json',
  import.meta.url,
);
const intended = JSON.parse(fs.readFileSync(intendedPath, 'utf8'));
function fixedFixture() {
  assert.ok(
    fs.existsSync(fixturePath),
    'the closed positive profile needs its fixed fixture',
  );
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

// Execute the actual HTTP dispatcher with controlled transport/auth/store boundaries.
// These are route units, not claims of live HTTP, capability digest validation or SQL.
function routeBoundary(overrides = {}) {
  const calls = [];
  const config = {
    testMode: true,
    testContentAllowed: true,
    testToken: 'controlled-token',
    testRunId: 'controlled-namespace',
    candidateExplicitlyBound: true,
    curriculumTrust: {},
    storyCapability: {},
    ...overrides,
  };
  const response = (value, status = 200) =>
    new Response(JSON.stringify(value ?? null), { status });
  const http = {
    requirePilotConfig: () => config,
    requirePilotSession: async () => {
      calls.push('session');
      return (
        overrides.sessionResponse ?? { config, user: { role: 'operator' } }
      );
    },
    requireOrigin: (request) =>
      request.headers.get('Origin') === 'http://controlled.test'
        ? null
        : response({ code: 'FORBIDDEN' }, 403),
    bodyJson: (request) => request.json(),
    json: response,
    errorResponse: (code, _message, status) => response({ code }, status),
  };
  const store = {
    bootstrapStory: async (_context, input, manifest) => {
      calls.push({ input, manifest });
      return {
        publicationId: 'controlled-publication',
        revision: 1,
        status: 'released',
      };
    },
  };
  const source = fs.readFileSync(
    new URL('../lib/pilot/story-http.ts', import.meta.url),
    'utf8',
  );
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const exports = {};
  const require = (name) => {
    if (name === './http.ts') return http;
    if (name === './corpus-learning-policy.ts')
      return { inspectCorpusLearningQuery };
    if (name === './corpus-config.ts') return { parseCorpusBindings };
    // Legacy bootstrap must not enter stored corpus dispatch or load cloud bindings.
    const unexpectedCorpus = () => {
      throw new Error('Legacy bootstrap entered corpus storage/runtime');
    };
    if (name === './runtime.ts') return { pilotBindings: unexpectedCorpus };
    if (name === './corpus-learning-store.ts')
      return Object.fromEntries(
        [
          'isCorpusResource',
          'corpusLearningContext',
          'corpusPlacement',
          'corpusPlans',
          'corpusPractice',
        ].map((key) => [key, unexpectedCorpus]),
      );
    if (name === './story-store.ts') return store;
    if (name === './story-policy.ts') return { StoryError };
    if (name === '../curriculum/story-package.ts') return { exact };
    if (name.endsWith('/forest-01-v4.json')) return intended;
    if (name.endsWith('/forest-01-v4-positive-publication.json'))
      return fs.existsSync(fixturePath) ? fixedFixture() : null;
    throw new Error(`Unexpected dispatcher import: ${name}`);
  };
  vm.runInNewContext(javascript, {
    exports,
    require,
    Response,
    URL,
    Error,
    Object,
    Array,
  });
  return { calls, route: exports.storyRoute };
}
function request(body = { fixture: 'positive-publication' }, headers = {}) {
  return new Request(
    'http://controlled.test/api/test/pilot/story-positive-bootstrap',
    {
      method: 'POST',
      headers: {
        Origin: 'http://controlled.test',
        'X-Hanzi-Test-Token': 'controlled-token',
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );
}

test('R3-P-001 intended draft remains ineligible while the separate labelled fixture is complete', async () => {
  assert.equal(hasCompleteCurriculumProvenance(intended), false);
  const fixture = fixedFixture();
  assert.equal(validateCurriculumPackage(fixture).ok, true);
  const compiled = await compileStoryPackage(fixture);
  assert.equal(compiled.identity.adapterId, 'forest-story');
  assert.equal(
    compiled.identity.contentDigest,
    await curriculumDigest(fixture),
  );
  assert.equal(hasCompleteCurriculumProvenance(fixture), true);
  assert.notEqual(
    await curriculumDigest(fixture),
    await curriculumDigest(intended),
  );
  assert.deepEqual(fixture.story, intended.story);
  assert.deepEqual(fixture.renderer, intended.renderer);
  const withoutProvenance = (value) =>
    JSON.parse(
      JSON.stringify(value, (key, item) =>
        key === 'provenance' || key === 'assets' ? undefined : item,
      ),
    );
  assert.deepEqual(withoutProvenance(fixture), withoutProvenance(intended));
  for (const character of fixture.characters) {
    assert.deepEqual(
      character.assets,
      intended.characters.find(
        (item) => item.characterId === character.characterId,
      ).assets,
    );
    for (const item of [
      ...character.readings,
      ...character.meanings,
      ...character.wordAssociations,
    ]) {
      for (const field of ['source', 'license', 'evidenceRef'])
        assert.match(item.provenance[field], /SIMULATED/);
    }
  }
  for (const asset of fixture.assets) {
    const provenanceKeys = new Set([
      'source',
      'license',
      'evidenceRef',
      'sourceChecked',
      'sourceCheckStatus',
    ]);
    const structuralFields = (value) =>
      Object.fromEntries(
        Object.entries(value).filter(([key]) => !provenanceKeys.has(key)),
      );
    assert.deepEqual(
      structuralFields(asset),
      structuralFields(
        intended.assets.find((item) => item.assetId === asset.assetId),
      ),
    );
    for (const field of ['source', 'license', 'evidenceRef'])
      assert.match(asset[field], /SIMULATED/);
  }
});

test('R3-P-002 ordinary mode denies positive bootstrap before authentication or storage', async () => {
  for (const operation of ['bootstrap', 'bootstrap-positive']) {
    const boundary = routeBoundary({ testMode: false });
    assert.equal((await boundary.route(request(), operation)).status, 404);
    assert.deepEqual(boundary.calls, []);
  }
});

test('R3-P-002 every existing bootstrap capability prerequisite also guards the positive route', async () => {
  for (const [key, value] of Object.entries({
    testContentAllowed: false,
    testToken: null,
    testRunId: null,
    candidateExplicitlyBound: false,
    curriculumTrust: null,
    storyCapability: null,
  })) {
    const boundary = routeBoundary({ [key]: value });
    assert.equal(
      (await boundary.route(request(), 'bootstrap-positive')).status,
      404,
      key,
    );
    assert.deepEqual(boundary.calls, []);
  }
});

test('R3-P-002 wrong token, failed session and wrong Origin cannot invoke bootstrap storage', async () => {
  for (const [config, headers, expected] of [
    [{}, { 'X-Hanzi-Test-Token': 'wrong' }, 403],
    [{ sessionResponse: new Response(null, { status: 401 }) }, {}, 401],
    [{}, { Origin: 'http://wrong.test' }, 403],
  ]) {
    const boundary = routeBoundary(config);
    assert.equal(
      (await boundary.route(request(undefined, headers), 'bootstrap-positive'))
        .status,
      expected,
    );
    assert.equal(
      boundary.calls.filter((item) => typeof item === 'object').length,
      0,
    );
  }
});

test('R3-P-001 positive route accepts only its exact closed body and never caller-selected content', async () => {
  for (const body of [
    null,
    [],
    {},
    { fixture: 'family-story' },
    { fixture: 'positive-publication', package: intended },
    { fixture: 'positive-publication', path: '/tmp/other.json' },
    { fixture: 'positive-publication', module: 'other' },
    { fixture: 'positive-publication', key: 'other' },
  ]) {
    const boundary = routeBoundary();
    assert.equal(
      (await boundary.route(request(body), 'bootstrap-positive')).status,
      400,
      JSON.stringify(body),
    );
    assert.equal(
      boundary.calls.filter((item) => typeof item === 'object').length,
      0,
    );
  }
});

test('R3-P-001 fixed selection normalizes only the store fixture name; original bootstrap still uses intended content', async () => {
  const positive = routeBoundary();
  assert.equal(
    (await positive.route(request(), 'bootstrap-positive')).status,
    200,
  );
  assert.equal(
    JSON.stringify(positive.calls[1].input),
    JSON.stringify({ fixture: 'family-story' }),
  );
  assert.deepEqual(positive.calls[1].manifest, fixedFixture());
  const original = routeBoundary();
  assert.equal(
    (await original.route(request({ fixture: 'family-story' }), 'bootstrap'))
      .status,
    200,
  );
  assert.deepEqual(original.calls[1], {
    input: { fixture: 'family-story' },
    manifest: intended,
  });
});

test('R3-P-002 new thin POST route selects the positive operation', () => {
  const routePath = new URL(
    '../app/api/test/pilot/story-positive-bootstrap/route.ts',
    import.meta.url,
  );
  assert.ok(
    fs.existsSync(routePath),
    'the named positive bootstrap route must exist',
  );
  const source = fs.readFileSync(routePath, 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const calls = [],
    exports = {};
  vm.runInNewContext(code, {
    exports,
    require: (name) => {
      assert.equal(name, '@/lib/pilot/story-http');
      return {
        storyRoute: (req, operation) => {
          calls.push([req, operation]);
          return 'delegated';
        },
      };
    },
  });
  const req = request();
  return exports.POST(req).then((value) => {
    assert.equal(value, 'delegated');
    assert.deepEqual(calls, [[req, 'bootstrap-positive']]);
  });
});

test('R3-P-002 legacy bootstrap uses the real selector guard and refuses corpus query dispatch before storage', async () => {
  const boundary = routeBoundary();
  const base = request();
  const req = new Request(
    base.url + '?corpusVersion=hanzi-starter-draft-v1',
    base,
  );
  assert.equal((await boundary.route(req, 'bootstrap-positive')).status, 400);
  assert.equal(
    boundary.calls.filter((item) => typeof item === 'object').length,
    0,
  );
});
