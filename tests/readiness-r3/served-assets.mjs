// External read-only asset check. No auth, controls, database or browser calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const args = process.argv.slice(2);
assert.equal(args.length % 2, 0);
const flags = Object.fromEntries(
  args.reduce((items, value, index) => {
    if (index % 2 === 0) items.push([value, args[index + 1]]);
    return items;
  }, []),
);
for (const key of ['--handoff', '--output', '--candidate', '--tester-sha256'])
  assert(flags[key], key);
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const self = path.resolve(import.meta.filename);
assert.equal(hash(await fs.readFile(self)), flags['--tester-sha256']);
const handoffPath = path.resolve(flags['--handoff']);
const stat = await fs.lstat(handoffPath);
assert(stat.isFile() && !stat.isSymbolicLink() && stat.size < 1048576);
assert.equal(stat.mode & 0o077, 0);
assert.equal(stat.uid, process.getuid());
assert.equal(await fs.realpath(handoffPath), handoffPath);
const h = JSON.parse(await fs.readFile(handoffPath, 'utf8'));
const manifest = JSON.parse(await fs.readFile(h.manifest, 'utf8'));
assert.equal(h.candidateId, flags['--candidate']);
assert.equal(manifest.candidateId, h.candidateId);
assert.equal(h.buildId, h.candidateId);
assert.equal(path.dirname(h.output), manifest.output);
assert(/^story-runtime-\d+$/.test(path.basename(h.output)));
assert.equal(handoffPath, path.join(h.output, 'handoff.json'));
assert.equal(await fs.realpath(h.snapshot), manifest.snapshot);
const base = new URL(h.targetBaseURL);
assert.equal(base.hostname, '127.0.0.1');
assert.equal(base.protocol, 'http:');
const output = path.resolve(flags['--output']);
const parent = path.resolve('outputs/qa/readiness-r3/served-assets');
assert.equal(path.dirname(output), parent);
await fs.mkdir(parent, { recursive: true });
assert.equal(await fs.realpath(parent), parent);
await fs.mkdir(output, { mode: 0o700 });
const verifierPath = path.join(h.snapshot, 'scripts/readiness-node-runner.mjs');
const verifierHash = hash(await fs.readFile(verifierPath));
const { verifyNodeManifest } = await import(pathToFileURL(verifierPath).href);
const verify = async () => {
  verifyNodeManifest(manifest, { built: true });
  assert.equal(h.sourceDigest, `sha256:${manifest.digest}`);
  assert.equal(h.artifactDigest, `sha256:${manifest.artifactDigest}`);
  assert.equal(hash(await fs.readFile(self)), flags['--tester-sha256']);
  assert.equal(hash(await fs.readFile(verifierPath)), verifierHash);
};
await verify();
const packagePath = path.join(h.snapshot, h.packagePath);
assert(manifest.files.includes(h.packagePath));
const fixture = JSON.parse(await fs.readFile(packagePath, 'utf8'));
const expected = new Map(
  fixture.story.questions.map((q) => [q.id, q.correctChoiceId]),
);
assert.equal(expected.size, 10);
const markers = [
  'correctChoiceId',
  'correctChoiceIds',
  'answerKey',
  'FOREST_STORY_LESSON',
  'validateStorySection',
  'STORY_LINEAGE',
];
const report = {
  schemaVersion: 'r3-served-assets-check-1',
  candidateId: h.candidateId,
  sourceDigest: h.sourceDigest,
  artifactDigest: h.artifactDigest,
  buildId: h.buildId,
  profile: h.profile,
  baseURL: base.origin,
  testerHashes: {
    [path.relative(process.cwd(), self)]: flags['--tester-sha256'],
    'frozen/scripts/readiness-node-runner.mjs': verifierHash,
  },
  cases: [],
  assets: [],
  findings: [],
  limitations: [
    'Finite explicit marker and AST constructor/object scans; not mathematical proof of absent obfuscated or runtime-generated answers.',
    'No authenticated DTO HTTP, auth/sign-in, SQL, control endpoint or CDP was used. DTO assessment is frozen-source inspection only.',
    'Only /pilot and manifest-enumerated emitted public JavaScript were requested. Source/test path exposure is artifact/import inventory, not arbitrary URL denial testing.',
    'Separate external security evidence; no signed base-proof claim or human/release acceptance.',
  ],
};
let requests = 0;
const deadline = Date.now() + 180000;
async function get(relative) {
  const url = new URL(relative, base);
  assert.equal(url.origin, base.origin);
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(
      Math.max(1, Math.min(10000, deadline - Date.now())),
    ),
    headers: { 'Accept-Encoding': 'identity' },
  });
  requests++;
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length <= 8 * 1024 * 1024, 'Response size limit');
  return { status: response.status, bytes };
}
function literal(node) {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}
function pairsFromJavascript(file, code) {
  const tree = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.equal(tree.parseDiagnostics.length, 0, 'Public JS parse must succeed');
  const pairs = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const id = literal(node.arguments[0]);
      const answer = literal(node.arguments.at(-1));
      if (expected.has(id) && expected.get(id) === answer) {
        pairs.push({
          questionId: id,
          correctChoiceId: answer,
          form: 'constructor-call',
          offset: node.getStart(tree),
        });
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const fields = new Map(
        node.properties
          .filter(ts.isPropertyAssignment)
          .map((p) => [
            p.name.getText(tree).replace(/^['"`]|['"`]$/g, ''),
            literal(p.initializer),
          ]),
      );
      if (
        expected.has(fields.get('id')) &&
        expected.get(fields.get('id')) === fields.get('correctChoiceId')
      ) {
        pairs.push({
          questionId: fields.get('id'),
          correctChoiceId: fields.get('correctChoiceId'),
          form: 'object-literal',
          offset: node.getStart(tree),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return pairs;
}
try {
  const pilot = await get('/pilot');
  assert.equal(pilot.status, 200);
  const prefix = '.output/public/';
  const assets = manifest.artifactFiles.filter(
    (f) => f.startsWith(prefix) && /\.(?:m?js)$/.test(f),
  );
  assert(assets.length > 0 && assets.length <= 100);
  const allPairs = new Map();
  for (const file of assets) {
    const emittedPath = '/' + file.slice(prefix.length);
    assert(!emittedPath.includes('..'));
    const served = await get(emittedPath);
    const frozen = await fs.readFile(path.join(h.snapshot, file));
    assert.equal(served.status, 200, emittedPath);
    assert.equal(
      hash(served.bytes),
      hash(frozen),
      `HTTP bytes differ: ${emittedPath}`,
    );
    const code = served.bytes.toString('utf8');
    const hits = markers
      .map((marker) => ({ marker, count: code.split(marker).length - 1 }))
      .filter((hit) => hit.count);
    const pairs = pairsFromJavascript(file, code);
    for (const pair of pairs)
      allPairs.set(pair.questionId, pair.correctChoiceId);
    report.assets.push({
      path: emittedPath,
      bytes: served.bytes.length,
      sha256: hash(served.bytes),
      markerHits: hits,
      oraclePairs: pairs,
    });
    if (pairs.length)
      report.findings.push({
        code: 'SAB-01',
        severity: 'blocker',
        asset: emittedPath,
        description:
          'Unauthenticated emitted client JS contains literal correct choices for inherited V4 questions.',
        questionIds: [...new Set(pairs.map((pair) => pair.questionId))],
      });
  }
  report.cases.push({
    id: 'SAB-BYTES',
    status: 'PASS',
    checkedJsAssets: assets.length,
    detail:
      'Every requested emitted public JS asset matches its frozen artifact bytes.',
  });
  const complete =
    expected.size === allPairs.size &&
    [...expected].every(([id, answer]) => allPairs.get(id) === answer);
  report.cases.push({
    id: 'SAB-ORACLE',
    status: allPairs.size ? 'FAIL' : 'PASS',
    completeInheritedAnswerMap: complete,
    matchedQuestionCount: allPairs.size,
    expectedQuestionCount: expected.size,
  });
  const exposedPaths = manifest.artifactFiles.filter(
    (f) => f.startsWith(prefix) && /\/(?:lib|content|tests)\//.test(f),
  );
  const sourceMaps = manifest.artifactFiles.filter(
    (f) => f.startsWith(prefix) && f.endsWith('.map'),
  );
  report.cases.push({
    id: 'SAB-SOURCE-INVENTORY',
    status: exposedPaths.length || sourceMaps.length ? 'REVIEW' : 'PASS',
    sourceOrTestArtifacts: exposedPaths,
    sourceMaps,
    publicManifestArtifacts: manifest.artifactFiles.filter(
      (f) => f.startsWith(prefix) && f.endsWith('manifest.json'),
    ),
  });
  const inspected = [
    'components/pilot/story/OrdinaryStoryLesson.tsx',
    'lib/pilot-story-client.ts',
    'lib/pilot-story-audio.ts',
    'components/pilot/story/StoryView.tsx',
    'lib/pilot/story-store.ts',
  ];
  report.sourceInspection = [];
  for (const file of inspected) {
    assert(manifest.files.includes(file));
    const source = await fs.readFile(path.join(h.snapshot, file), 'utf8');
    const tree = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const imports = tree.statements
      .filter(ts.isImportDeclaration)
      .map((node) => ({
        module: literal(node.moduleSpecifier),
        typeOnly: node.importClause?.getText(tree).startsWith('type ') ?? false,
      }));
    report.sourceInspection.push({ file, sha256: hash(source), imports });
  }
  report.cases.push({
    id: 'SAB-DTO-SOURCE',
    status: 'SOURCE-REVIEW',
    detail:
      'Frozen server safeQuestion destructures correctChoiceId, gated hint/demonstration; lesson questions use safeQuestion; event projection omits payload/result/runId. Direct ordinary client imports contain no grading module. This does not prevent transitive PilotApp/validator bundle leakage and is not a live DTO execution.',
  });
  await verify();
  report.frozenVerifiedBeforeAfter = true;
} catch (error) {
  report.cases.push({
    id: 'SAB-EXECUTION',
    status: 'FAIL',
    message: String(error.message),
  });
  process.exitCode = 1;
} finally {
  report.httpRequestCount = requests;
  report.finishedAt = new Date().toISOString();
  report.result =
    report.findings.length || report.cases.some((c) => c.status === 'FAIL')
      ? 'FAIL'
      : 'PASS';
  if (report.result === 'FAIL') process.exitCode = 1;
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  );
  const headline =
    report.result === 'FAIL'
      ? 'FAIL: publicly served inherited grading oracle'
      : 'PASS within the finite scan boundary';
  await fs.writeFile(
    path.join(output, 'report.md'),
    `# R3 served-assets boundary\n\n${headline}. Candidate ${report.candidateId}; ${report.assets.length} emitted JS assets checked; ${requests} unauthenticated GETs.\n\n${report.findings.map((f) => `${f.code}: ${f.asset} exposes ${f.questionIds.length} exact question/answer pairs.`).join('\n\n')}\n\nTester SHA-256: ${flags['--tester-sha256']}. Source/artifact identity checked before/after: ${report.frozenVerifiedBeforeAfter === true}. Full byte hashes, pair offsets, import inventory and limitations are in report.json.\n\n${report.limitations.join('\n\n')}\n`,
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      result: report.result,
      assets: report.assets.length,
      requests,
      findings: report.findings,
      frozenVerifiedBeforeAfter: report.frozenVerifiedBeforeAfter,
    }),
  );
}
