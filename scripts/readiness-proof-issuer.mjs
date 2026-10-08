import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
import { validIssuer } from '../lib/pilot/story-policy.ts';
import { storyProfile } from './readiness-story-profiles.mjs';
import {
  verifyNodeManifest,
  runtimeEnvironment,
  launched,
  bounded,
} from './readiness-node-runner.mjs';

export const PROOF_SCENARIOS = [
  'selection',
  'approval',
  'recognition',
  'help',
  'audio-unavailable',
  'restart',
  'duplicate-conflict',
  'delayed-review',
  'progress-export',
  'recovery',
  'ownership',
  'browser-family',
];
const IDENTITY_FIELDS = [
  'candidateId',
  'sourceDigest',
  'artifactDigest',
  'buildId',
  'lessonVersion',
  'contentDigest',
  'evidenceInstallationId',
  'targetInstallationId',
  'namespace',
];
const digest = (bytes) =>
  `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const rawHash = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
const prefixed = (value) =>
  value.startsWith('sha256:') ? value : `sha256:${value}`;
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) =>
  record(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
function invalid() {
  throw new Error('PROOF_EXECUTION_INVALID');
}
function check(condition) {
  if (!condition) invalid();
}

/** Bind fixture and signing authority before executing or signing any report. */
export function proofProfileBinding({
  manifest,
  handoff,
  profile = 'family-story',
  installationId,
  targetInstallationId = installationId,
  issuerId,
  privateKey,
}) {
  try {
    const selected = storyProfile(profile);
    check(
      (handoff.profile ?? 'family-story') === selected.name &&
        (handoff.packagePath ?? 'content/curriculum/forest-01-v4.json') ===
          selected.packagePath &&
        typeof installationId === 'string' &&
        installationId.length > 0 &&
        handoff.evidenceInstallationId === installationId &&
        typeof targetInstallationId === 'string' &&
        targetInstallationId.length > 0 &&
        handoff.targetInstallationId === targetInstallationId,
    );
    const positive = selected.name === 'positive-publication';
    if (positive) {
      const target = new URL(handoff.targetBaseURL);
      check(
        targetInstallationId !== installationId &&
          target.protocol === 'http:' &&
          target.hostname === '127.0.0.1' &&
          target.port !== '' &&
          !target.username &&
          !target.password &&
          target.pathname === '/' &&
          !target.search &&
          !target.hash &&
          target.origin !== new URL(handoff.baseURL).origin &&
          target.origin !== new URL(handoff.ordinaryBaseURL).origin &&
          typeof handoff.targetState === 'string' &&
          path.dirname(handoff.targetState) === manifest.work &&
          handoff.targetState !== handoff.state &&
          fs.realpathSync(handoff.targetState) === handoff.targetState &&
          fs.lstatSync(handoff.targetState).isDirectory(),
      );
    } else check(targetInstallationId === installationId);
    const issuer = positive ? handoff.targetIssuer : handoff.publicIssuer;
    check(
      validIssuer(issuer) &&
        issuer.issuerId === issuerId &&
        issuer.purpose === (positive ? 'release' : 'candidate'),
    );
    const publicKey = crypto
      .createPublicKey(privateKey)
      .export({ format: 'jwk' });
    check(
      ['kty', 'crv', 'x'].every(
        (field) => publicKey[field] === issuer.publicKeyJwk[field],
      ),
    );
    return selected;
  } catch {
    invalid();
  }
}

/** Receipt formatting only; this does not execute, attest or sign evidence. */
export function buildStoryProofReceipt(identity, details) {
  return {
    schemaVersion: 'r3-proof-receipt-1',
    receiptId: details.receiptId,
    issuerId: details.issuerId,
    issuedAt: details.issuedAt,
    candidateId: identity.candidateId,
    sourceDigest: identity.sourceDigest,
    artifactDigest: identity.artifactDigest,
    buildId: identity.buildId,
    lessonVersion: identity.lessonVersion,
    contentDigest: identity.contentDigest,
    canonicalizationVersion: 's3-json-1',
    adapterId: 'forest-story',
    adapterVersion: 'forest-story-v1',
    evidenceInstallationId: identity.evidenceInstallationId,
    targetInstallationId: identity.targetInstallationId,
    namespace: identity.namespace,
    syntheticOnly: true,
    scenarios: details.scenarios,
    reportDigest: details.reportDigest,
  };
}

function evidenceFile(output, relative) {
  check(
    typeof relative === 'string' &&
      relative.length > 0 &&
      !path.isAbsolute(relative) &&
      !relative.includes('\\') &&
      relative !== 'report.json',
  );
  const parts = relative.split('/');
  check(
    parts.every(
      (part) =>
        part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'),
    ),
  );
  let file = output;
  for (const part of parts) {
    file = path.join(file, part);
    const info = fs.lstatSync(file);
    check(!info.isSymbolicLink());
  }
  const info = fs.statSync(file);
  check(
    info.isFile() &&
      info.size > 0 &&
      info.size <= 20 * 1024 * 1024 &&
      fs.realpathSync(file).startsWith(fs.realpathSync(output) + path.sep),
  );
  return { path: relative, sha256: digest(fs.readFileSync(file)) };
}

/** Validates output of the fixed process below; this is not an upload API. */
export function inspectExecutedStoryReport(report, context) {
  try {
    check(
      context.exitCode === 0 &&
        exact(report, [
          'schemaVersion',
          ...IDENTITY_FIELDS,
          'startedAt',
          'finishedAt',
          'scenarios',
          'cases',
          'testSourceHashes',
        ]) &&
        report.schemaVersion === 'r3-executed-report-1',
    );
    check(
      IDENTITY_FIELDS.every(
        (field) => report[field] === context.identity[field],
      ),
    );
    check(
      Number.isSafeInteger(report.startedAt) &&
        Number.isSafeInteger(report.finishedAt) &&
        report.startedAt >= context.startedAt &&
        report.finishedAt <= context.finishedAt &&
        report.finishedAt >= report.startedAt,
    );
    check(
      canonicalPackage(report.testSourceHashes) ===
        canonicalPackage(context.testSourceHashes),
    );
    check(Array.isArray(report.cases) && report.cases.length > 0);
    const cases = new Map();
    for (const item of report.cases) {
      check(
        exact(item, ['id', 'outcome', 'evidenceRefs']) &&
          typeof item.id === 'string' &&
          item.id.length > 0 &&
          !cases.has(item.id) &&
          item.outcome === 'PASS' &&
          Array.isArray(item.evidenceRefs) &&
          item.evidenceRefs.length > 0,
      );
      for (const file of item.evidenceRefs) evidenceFile(context.output, file);
      cases.set(item.id, item);
    }
    check(
      Array.isArray(report.scenarios) &&
        report.scenarios.length === PROOF_SCENARIOS.length,
    );
    const seen = new Set();
    return report.scenarios.map((scenario) => {
      check(
        exact(scenario, ['id', 'outcome', 'caseIds', 'evidenceFiles']) &&
          PROOF_SCENARIOS.includes(scenario.id) &&
          !seen.has(scenario.id) &&
          scenario.outcome === 'PASS',
      );
      seen.add(scenario.id);
      check(
        Array.isArray(scenario.caseIds) &&
          scenario.caseIds.length > 0 &&
          new Set(scenario.caseIds).size === scenario.caseIds.length &&
          scenario.caseIds.every((id) => cases.has(id)),
      );
      check(
        Array.isArray(scenario.evidenceFiles) &&
          scenario.evidenceFiles.length > 0 &&
          new Set(scenario.evidenceFiles).size ===
            scenario.evidenceFiles.length,
      );
      const artifacts = scenario.evidenceFiles.map((relative) =>
        evidenceFile(context.output, relative),
      );
      const caseEvidence = new Set(
        scenario.caseIds.flatMap((id) => cases.get(id).evidenceRefs),
      );
      check(artifacts.every((file) => caseEvidence.has(file.path)));
      return {
        id: scenario.id,
        outcome: 'PASS',
        evidenceDigest: digest(
          canonicalPackage({ caseIds: scenario.caseIds, artifacts }),
        ),
      };
    });
  } catch {
    invalid();
  }
}

/** Execute the frozen independent suite once, then attest its inspected output. */
export async function verifyAndSignStoryProof({
  manifest,
  handoff,
  output,
  issuerId,
  privateKey,
  installationId,
  targetInstallationId = installationId,
  profile = 'family-story',
  contentDigest,
  namespace,
  signal,
}) {
  verifyNodeManifest(manifest, { built: true });
  check(
    manifest.phase === 'r3' &&
      typeof output === 'string' &&
      path.dirname(output) === manifest.work &&
      /^proof-[A-Za-z0-9-]+$/.test(path.basename(output)) &&
      !fs.existsSync(output),
  );
  check(
    !signal?.aborted && typeof issuerId === 'string' && issuerId.length > 0,
  );
  const selected = proofProfileBinding({
    manifest,
    handoff,
    profile,
    installationId,
    targetInstallationId,
    issuerId,
    privateKey,
  });
  const identity = {
    candidateId: manifest.candidateId,
    sourceDigest: prefixed(manifest.digest),
    artifactDigest: prefixed(manifest.artifactDigest),
    buildId: manifest.candidateId,
    lessonVersion: 'forest-01-v4',
    contentDigest,
    evidenceInstallationId: installationId,
    targetInstallationId,
    namespace,
  };
  check(
    IDENTITY_FIELDS.every((field) => handoff[field] === identity[field]) &&
      typeof identity.buildId === 'string' &&
      identity.buildId.length > 0,
  );
  const packageFile = selected.packagePath;
  check(manifest.files.includes(packageFile));
  const declaredPackage = JSON.parse(
    fs.readFileSync(path.join(manifest.snapshot, packageFile), 'utf8'),
  );
  check(
    declaredPackage.lessonVersion === 'forest-01-v4' &&
      contentDigest === digest(canonicalPackage(declaredPackage)),
  );
  const coordinator = 'tests/readiness-r3/run.mjs';
  check(manifest.files.includes(coordinator));
  const testSourceHashes = Object.fromEntries(
    manifest.files
      .filter((file) => /^tests\/readiness-r3\/[^/]+\.mjs$/.test(file))
      .sort()
      .map((file) => [
        file,
        rawHash(fs.readFileSync(path.join(manifest.snapshot, file))),
      ]),
  );
  const childInput = path.join(
    manifest.work,
    `proof-handoff-${crypto.randomUUID()}.json`,
  );
  const childLog = path.join(
    manifest.work,
    `proof-log-${crypto.randomUUID()}.log`,
  );
  fs.writeFileSync(childInput, JSON.stringify(handoff), {
    mode: 0o600,
    flag: 'wx',
  });
  let processHandle = null,
    aborted = false,
    stopping = null;
  const abort = () => {
    aborted = true;
    if (processHandle && !stopping) stopping = processHandle.stop();
  };
  signal?.addEventListener('abort', abort, { once: true });
  const startedAt = Date.now();
  try {
    check(!signal?.aborted);
    processHandle = launched(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(manifest.snapshot, coordinator),
        '--handoff',
        childInput,
        '--output',
        output,
        '--mode',
        'proof',
      ],
      {
        cwd: manifest.snapshot,
        env: runtimeEnvironment(),
        log: childLog,
      },
    );
    if (signal?.aborted) abort();
    const [exitCode] = await bounded(
      once(processHandle.child, 'exit'),
      20 * 60 * 1000,
      'Independent story proof suite',
    );
    await processHandle.stop();
    check(
      !aborted && !signal?.aborted && !processHandle.error && exitCode === 0,
    );
    // Both identities remain immutable after the child process has used them.
    verifyNodeManifest(manifest, { built: true });
    const reportPath = path.join(output, 'report.json'),
      stat = fs.lstatSync(reportPath);
    check(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size > 0 &&
        stat.size <= 2 * 1024 * 1024,
    );
    const reportBytes = fs.readFileSync(reportPath),
      report = JSON.parse(reportBytes.toString('utf8'));
    const finishedAt = Date.now();
    const scenarios = inspectExecutedStoryReport(report, {
      identity,
      output,
      startedAt,
      finishedAt,
      testSourceHashes,
      exitCode,
    });
    const receipt = buildStoryProofReceipt(identity, {
      receiptId: `proof-${crypto.randomUUID()}`,
      issuerId,
      issuedAt: Date.now(),
      scenarios,
      reportDigest: digest(reportBytes),
    });
    check(!aborted && !signal?.aborted);
    const signature = crypto
      .sign(null, Buffer.from(canonicalPackage(receipt)), privateKey)
      .toString('base64url');
    fs.writeFileSync(
      path.join(output, 'issued-receipt.json'),
      JSON.stringify({ receipt, signature }),
      { mode: 0o600, flag: 'wx' },
    );
    return { receipt, signature };
  } finally {
    signal?.removeEventListener('abort', abort);
    try {
      if (stopping) await Promise.resolve(stopping);
      if (processHandle) await processHandle.stop();
    } finally {
      fs.rmSync(childInput, { force: true });
      // The coordinator exclusively creates the evidence directory. Its process
      // log starts outside that directory so no pre-existing evidence is accepted.
      if (
        fs.existsSync(output) &&
        fs.realpathSync(output) === output &&
        fs.lstatSync(output).isDirectory() &&
        fs.existsSync(childLog)
      ) {
        fs.copyFileSync(
          childLog,
          path.join(output, 'coordinator.log'),
          fs.constants.COPYFILE_EXCL,
        );
        fs.rmSync(childLog);
      }
    }
  }
}
