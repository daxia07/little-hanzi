/** Private execution coordinator. No uploaded report or caller-selected workload. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { canonicalPackage as canonical } from '../lib/curriculum/digest.ts';
import { inspectCorpusManifest } from '../lib/pilot/corpus-policy.ts';
import { validIssuer } from '../lib/pilot/story-policy.ts';
import {
  CORPUS_MEMBER_CHECKS,
  CORPUS_FAMILY_SCENARIOS,
  corpusRepresentatives,
  inspectCorpusProof,
} from '../lib/pilot/corpus-proof.ts';
import { corpusProfile } from './readiness-corpus-profiles.mjs';
import {
  verifyNodeManifest,
  runtimeEnvironment,
  launched,
  bounded,
} from './readiness-node-runner.mjs';

const IDENTITY_FIELDS = [
  'candidateId',
  'sourceDigest',
  'artifactDigest',
  'buildId',
  'corpusVersion',
  'corpusDigest',
  'profile',
  'profileDigest',
  'runnerManifestDigest',
];
const RUNTIME_FIELDS = ['evidenceInstallationId', 'namespace'];
const rawHash = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
const hash = (bytes) => 'sha256:' + rawHash(bytes);
const H = (value) => hash(canonical(value));
const prefix = (value) => {
  check(typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(value));
  return value.startsWith('sha256:') ? value : 'sha256:' + value;
};
const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const equal = (a, b) => canonical(a) === canonical(b);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function check(value) {
  if (!value) throw new Error('PROOF_EXECUTION_INVALID');
}
function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  check(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o077) === 0 &&
      fs.realpathSync(directory) === directory,
  );
}

/** Identity only: checks actual candidate bytes; never grants content review. */
export function corpusExecutionBinding(manifest, name) {
  verifyNodeManifest(manifest, { built: true });
  check(manifest.phase === 'r6');
  const profile = corpusProfile(name);
  const profileFiles = [profile.manifestPath, profile.oraclePath];
  for (const dir of [profile.packageDirectory, profile.batchDirectory]) {
    check(
      fs.realpathSync(path.join(manifest.snapshot, dir)) ===
        path.join(manifest.snapshot, dir),
    );
    profileFiles.push(
      ...fs
        .readdirSync(path.join(manifest.snapshot, dir))
        .filter((file) => file.endsWith('.json'))
        .map((file) => dir + '/' + file),
    );
  }
  const bytes = (file) => {
    check(manifest.files.includes(file));
    return fs.readFileSync(path.join(manifest.snapshot, file));
  };
  const profileHashes = Object.fromEntries(
    profileFiles.sort(compare).map((file) => [file, rawHash(bytes(file))]),
  );
  const profileDigest = H(profileHashes);
  const corpus = inspectCorpusManifest(
    JSON.parse(bytes(profile.manifestPath).toString('utf8')),
  );
  const items = corpus.items.map(({ lessonVersion, contentDigest }) => ({
    lessonVersion,
    contentDigest,
  }));
  check(items.length === (name === 'draft-corpus' ? 10 : 800));
  for (const item of items) {
    const doc = JSON.parse(
      bytes(
        profile.packageDirectory + '/' + item.lessonVersion + '.json',
      ).toString('utf8'),
    );
    check(
      doc.lessonVersion === item.lessonVersion && H(doc) === item.contentDigest,
    );
  }
  const required = [
    'scripts/readiness-node-runner.mjs',
    'scripts/readiness-corpus-node-runner.mjs',
    'scripts/readiness-corpus-bootstrap.mjs',
    'scripts/readiness-corpus-profiles.mjs',
    'scripts/readiness-corpus-proof-issuer.mjs',
    'tests/readiness-r6/service-run.mjs',
    'tests/readiness-r6/member-checks.mjs',
    'tests/readiness-r6/oracle.mjs',
  ];
  check(required.every((file) => manifest.files.includes(file)));
  const testFiles = manifest.files
    .filter((file) => /^tests\/readiness-r6\/[^/]+\.mjs$/.test(file))
    .sort(compare);
  const testSourceHashes = Object.fromEntries(
    testFiles.map((file) => [file, rawHash(bytes(file))]),
  );
  const runnerFiles = manifest.files.filter((file) =>
    /^scripts\/readiness-corpus-[^/]+\.mjs$/.test(file),
  );
  const sourceHashes = Object.fromEntries(
    [...new Set([...required, ...testFiles, ...runnerFiles])]
      .sort(compare)
      .map((file) => [file, rawHash(bytes(file))]),
  );
  const identity = {
    candidateId: manifest.candidateId,
    sourceDigest: prefix(manifest.digest),
    artifactDigest: prefix(manifest.artifactDigest),
    buildId: manifest.candidateId,
    corpusVersion: corpus.corpusVersion,
    corpusDigest: H(corpus),
    profile: name,
    profileDigest,
    runnerManifestDigest: H({
      schemaVersion: 'r6-runner-manifest-1',
      profile: name,
      profileDigest,
      sourceHashes,
    }),
  };
  check(
    rawHash(fs.readFileSync(fileURLToPath(import.meta.url))) ===
      sourceHashes['scripts/readiness-corpus-proof-issuer.mjs'],
  );
  return { profile, corpus, items, identity, testSourceHashes };
}

function evidenceFile(output, relative, maxBytes = 20 * 1024 * 1024) {
  check(
    typeof relative === 'string' &&
      relative.length > 0 &&
      relative.length <= 512 &&
      !path.isAbsolute(relative) &&
      !relative.includes('\\'),
  );
  const parts = relative.split('/');
  check(
    parts.every(
      (part) =>
        part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'),
    ),
  );
  let full = output;
  for (const part of parts) {
    full = path.join(full, part);
    const stat = fs.lstatSync(full);
    check(!stat.isSymbolicLink() && stat.uid === process.getuid());
  }
  const stat = fs.lstatSync(full);
  check(
    stat.isFile() &&
      stat.size > 0 &&
      stat.size <= maxBytes &&
      fs.realpathSync(full).startsWith(fs.realpathSync(output) + path.sep),
  );
  const bytes = fs.readFileSync(full);
  check(bytes.length === stat.size);
  return { path: relative, sha256: hash(bytes), bytes };
}
function jsonEvidence(output, relative, limit) {
  const file = evidenceFile(output, relative, limit);
  return {
    value: JSON.parse(file.bytes.toString('utf8')),
    digest: file.sha256,
  };
}
function inspectStep(step, keys, allowed, cases, output) {
  check(
    exact(step, keys) && allowed.includes(step.id) && step.outcome === 'PASS',
  );
  for (const key of ['caseIds', 'evidenceFiles'])
    check(
      Array.isArray(step[key]) &&
        step[key].length > 0 &&
        new Set(step[key]).size === step[key].length,
    );
  check(step.caseIds.every((id) => typeof id === 'string' && cases.has(id)));
  const caseFiles = new Set(
    step.caseIds.flatMap((id) => cases.get(id).evidenceRefs),
  );
  check(step.evidenceFiles.every((file) => caseFiles.has(file)));
  const artifacts = step.evidenceFiles.map((file) => {
    check(file !== 'report.json');
    const { path: relative, sha256 } = evidenceFile(output, file);
    return { path: relative, sha256 };
  });
  return {
    id: step.id,
    outcome: 'PASS',
    evidenceDigest: H({ caseIds: step.caseIds, artifacts }),
  };
}

/** Inspects fixed child output only. Pure validator tests cannot issue a proof. */
export function inspectExecutedCorpusReport(report, context) {
  try {
    privateDirectory(context.output);
    check(
      context.exitCode === 0 &&
        exact(report, [
          'schemaVersion',
          ...IDENTITY_FIELDS,
          ...RUNTIME_FIELDS,
          'startedAt',
          'finishedAt',
          'testSourceHashes',
          'memberReports',
          'familyReportFile',
          'cases',
          'cleanup',
        ]) &&
        report.schemaVersion === 'r6-executed-report-1',
    );
    check(
      [...IDENTITY_FIELDS, ...RUNTIME_FIELDS].every(
        (field) => report[field] === context.identity[field],
      ),
    );
    check(
      Number.isSafeInteger(report.startedAt) &&
        Number.isSafeInteger(report.finishedAt) &&
        report.startedAt >= context.startedAt &&
        report.finishedAt >= report.startedAt &&
        report.finishedAt <= context.finishedAt &&
        equal(report.testSourceHashes, context.testSourceHashes),
    );
    check(
      exact(report.cleanup, [
        'ownedBrowserContextsClosed',
        'sharedBrowserDisconnected',
      ]) &&
        report.cleanup.ownedBrowserContextsClosed === true &&
        report.cleanup.sharedBrowserDisconnected === true,
    );
    check(
      Array.isArray(report.cases) &&
        report.cases.length > 0 &&
        report.cases.length <= 50000,
    );
    const cases = new Map();
    for (const item of report.cases) {
      check(
        exact(item, ['id', 'outcome', 'evidenceRefs']) &&
          typeof item.id === 'string' &&
          item.id.length > 0 &&
          item.id.length <= 240 &&
          !cases.has(item.id) &&
          item.outcome === 'PASS' &&
          Array.isArray(item.evidenceRefs) &&
          item.evidenceRefs.length > 0 &&
          new Set(item.evidenceRefs).size === item.evidenceRefs.length,
      );
      for (const file of item.evidenceRefs) {
        check(file !== 'report.json');
        evidenceFile(context.output, file);
      }
      cases.set(item.id, item);
    }
    check(
      Array.isArray(report.memberReports) &&
        report.memberReports.length === context.items.length,
    );
    const reportFiles = new Set([report.familyReportFile, 'report.json']);
    const members = report.memberReports.map((reference, i) => {
      const item = context.items[i];
      check(
        exact(reference, ['lessonVersion', 'contentDigest', 'reportFile']) &&
          reference.lessonVersion === item.lessonVersion &&
          reference.contentDigest === item.contentDigest &&
          !reportFiles.has(reference.reportFile),
      );
      reportFiles.add(reference.reportFile);
      const { value, digest } = jsonEvidence(
        context.output,
        reference.reportFile,
        1024 * 1024,
      );
      check(
        exact(value, [
          'schemaVersion',
          'lessonVersion',
          'contentDigest',
          'checks',
        ]) &&
          value.schemaVersion === 'r6-member-execution-1' &&
          value.lessonVersion === item.lessonVersion &&
          value.contentDigest === item.contentDigest &&
          Array.isArray(value.checks) &&
          value.checks.length === CORPUS_MEMBER_CHECKS.length &&
          new Set(value.checks.map((step) => step.id)).size ===
            CORPUS_MEMBER_CHECKS.length,
      );
      return {
        ...item,
        memberReportDigest: digest,
        memberChecks: value.checks.map((step) =>
          inspectStep(
            step,
            ['id', 'outcome', 'caseIds', 'evidenceFiles'],
            CORPUS_MEMBER_CHECKS,
            cases,
            context.output,
          ),
        ),
      };
    });
    check(report.familyReportFile !== 'report.json');
    const { value: family, digest: familyDigest } = jsonEvidence(
      context.output,
      report.familyReportFile,
      1024 * 1024,
    );
    const reps = corpusRepresentatives(context.items);
    check(
      exact(family, [
        'schemaVersion',
        'evidenceInstallationId',
        'namespace',
        'representatives',
        'scenarios',
      ]) &&
        family.schemaVersion === 'r6-family-execution-1' &&
        family.evidenceInstallationId ===
          context.identity.evidenceInstallationId &&
        family.namespace === context.identity.namespace &&
        equal(family.representatives, reps) &&
        Array.isArray(family.scenarios) &&
        family.scenarios.length ===
          reps.length * CORPUS_FAMILY_SCENARIOS.length,
    );
    const seen = new Set();
    const scenarios = family.scenarios.map((step) => {
      check(
        reps.some(
          (item) =>
            item.lessonVersion === step.lessonVersion &&
            item.contentDigest === step.contentDigest,
        ),
      );
      const key = canonical([step.lessonVersion, step.contentDigest, step.id]);
      check(!seen.has(key));
      seen.add(key);
      return {
        lessonVersion: step.lessonVersion,
        contentDigest: step.contentDigest,
        ...inspectStep(
          step,
          [
            'lessonVersion',
            'contentDigest',
            'id',
            'outcome',
            'caseIds',
            'evidenceFiles',
          ],
          CORPUS_FAMILY_SCENARIOS,
          cases,
          context.output,
        ),
      };
    });
    return {
      members,
      familyEvidence: {
        reportDigest: familyDigest,
        representatives: reps,
        scenarios,
      },
    };
  } catch {
    throw new Error('PROOF_EXECUTION_INVALID');
  }
}

/** Formatting only; no signature or claim of execution is made here. */
export function buildCorpusProofReceipt(
  identity,
  member,
  familyEvidence,
  details,
) {
  return {
    schemaVersion: 'r6-proof-receipt-1',
    policyVersion: 'r6-corpus-proof-1',
    receiptId: details.receiptId,
    issuerId: details.issuerId,
    issuedAt: details.issuedAt,
    candidateId: identity.candidateId,
    sourceDigest: identity.sourceDigest,
    artifactDigest: identity.artifactDigest,
    buildId: identity.buildId,
    corpusVersion: identity.corpusVersion,
    corpusDigest: identity.corpusDigest,
    lessonVersion: member.lessonVersion,
    contentDigest: member.contentDigest,
    canonicalizationVersion: 's3-json-1',
    adapterId: 'corpus-paired',
    adapterVersion: 'corpus-paired-v1',
    profileVersion: 'r6-paired-profile-1',
    evidenceInstallationId: identity.evidenceInstallationId,
    targetInstallationId: identity.evidenceInstallationId,
    namespace: identity.namespace,
    syntheticOnly: true,
    runnerManifestDigest: identity.runnerManifestDigest,
    memberReportDigest: member.memberReportDigest,
    memberChecks: member.memberChecks,
    familyEvidence,
  };
}

function localURL(value) {
  const url = new URL(value);
  check(
    url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port !== '' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash,
  );
}

/** Launch exactly one frozen tester process and sign only its complete output. */
export async function verifyAndSignCorpusProof({
  manifest,
  handoff,
  output,
  issuerId,
  privateKey,
  signal,
}) {
  const binding = corpusExecutionBinding(manifest, handoff.profile);
  check(
    !signal?.aborted &&
      typeof output === 'string' &&
      path.dirname(output) === manifest.work &&
      /^corpus-proof-[0-9a-f-]{36}$/.test(path.basename(output)) &&
      !fs.existsSync(output),
  );
  privateDirectory(manifest.work);
  check(
    handoff.schemaVersion === 'r6-corpus-runtime-1' &&
      IDENTITY_FIELDS.every(
        (field) => handoff[field] === binding.identity[field],
      ) &&
      handoff.phase === manifest.phase &&
      handoff.specVersion === manifest.specVersion &&
      handoff.integrationVersion === manifest.integrationVersion &&
      handoff.runId === manifest.runId &&
      typeof handoff.installationId === 'string' &&
      handoff.installationId.length > 0 &&
      typeof handoff.namespace === 'string' &&
      handoff.namespace.length > 0,
  );
  localURL(handoff.baseURL);
  localURL(handoff.ordinaryNegativeBaseURL);
  localURL(handoff.controlURL);
  check(
    new Set([
      handoff.baseURL,
      handoff.ordinaryNegativeBaseURL,
      handoff.controlURL,
    ]).size === 3,
  );
  const issuer = handoff.publicIssuer;
  check(
    validIssuer(issuer) &&
      issuer.issuerId === issuerId &&
      issuer.purpose === 'candidate' &&
      issuer.revokedAt === null &&
      issuer.notBefore <= Date.now(),
  );
  const publicKey = crypto
    .createPublicKey(privateKey)
    .export({ format: 'jwk' });
  check(
    ['kty', 'crv', 'x'].every(
      (field) => publicKey[field] === issuer.publicKeyJwk[field],
    ),
  );
  const identity = {
    ...binding.identity,
    evidenceInstallationId: handoff.installationId,
    namespace: handoff.namespace,
  };
  const input = path.join(
    manifest.work,
    'corpus-proof-handoff-' + crypto.randomUUID() + '.json',
  );
  const log = path.join(
    manifest.work,
    'corpus-proof-log-' + crypto.randomUUID() + '.log',
  );
  fs.writeFileSync(input, JSON.stringify(handoff), { mode: 0o600, flag: 'wx' });
  let child = null,
    stopping = null,
    aborted = false;
  const abort = () => {
    aborted = true;
    if (child && !stopping) stopping = child.stop();
  };
  signal?.addEventListener('abort', abort, { once: true });
  const startedAt = Date.now();
  try {
    check(!signal?.aborted);
    child = launched(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(manifest.snapshot, 'tests/readiness-r6/service-run.mjs'),
        '--handoff',
        input,
        '--output',
        output,
        '--mode',
        'proof',
      ],
      {
        cwd: manifest.snapshot,
        env: runtimeEnvironment(),
        log,
        secrets: [
          handoff.token,
          ...(handoff.accounts ?? []).flatMap((a) => [a.password]),
        ],
      },
    );
    if (signal?.aborted) abort();
    const [exitCode] = await bounded(
      once(child.child, 'exit'),
      30 * 60 * 1000,
      'Independent corpus proof suite',
    );
    await child.stop();
    check(!aborted && !signal?.aborted && !child.error && exitCode === 0);
    const after = corpusExecutionBinding(manifest, handoff.profile);
    check(
      equal(after.identity, binding.identity) &&
        equal(after.testSourceHashes, binding.testSourceHashes),
    );
    const { value: report } = jsonEvidence(
      output,
      'report.json',
      4 * 1024 * 1024,
    );
    const evidence = inspectExecutedCorpusReport(report, {
      identity,
      items: binding.items,
      output,
      startedAt,
      finishedAt: Date.now(),
      testSourceHashes: binding.testSourceHashes,
      exitCode,
    });
    check(!aborted && !signal?.aborted);
    const issuedAt = new Date().toISOString();
    const receipts = evidence.members.map((member) => {
      const receipt = buildCorpusProofReceipt(
        identity,
        member,
        evidence.familyEvidence,
        {
          receiptId: 'corpus-proof-' + crypto.randomUUID(),
          issuerId,
          issuedAt,
        },
      );
      inspectCorpusProof(receipt, binding.items);
      return {
        receipt,
        signature: crypto
          .sign(null, Buffer.from(canonical(receipt)), privateKey)
          .toString('base64url'),
      };
    });
    const issued = {
      schemaVersion: 'r6-issued-proofs-1',
      candidateId: identity.candidateId,
      corpusVersion: identity.corpusVersion,
      corpusDigest: identity.corpusDigest,
      receipts,
    };
    fs.writeFileSync(
      path.join(output, 'issued-receipts.json'),
      JSON.stringify(issued),
      { mode: 0o600, flag: 'wx' },
    );
    return {
      runId: manifest.runId,
      outcome: 'PASS',
      receiptCount: receipts.length,
      receiptsFile: 'issued-receipts.json',
      reportFile: 'report.json',
    };
  } finally {
    signal?.removeEventListener('abort', abort);
    try {
      if (stopping) await Promise.resolve(stopping);
      if (child) await child.stop();
    } finally {
      fs.rmSync(input, { force: true });
      if (
        fs.existsSync(output) &&
        fs.lstatSync(output).isDirectory() &&
        fs.realpathSync(output) === output &&
        fs.existsSync(log)
      ) {
        fs.copyFileSync(
          log,
          path.join(output, 'coordinator.log'),
          fs.constants.COPYFILE_EXCL,
        );
        fs.rmSync(log);
      }
    }
  }
}
