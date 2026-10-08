import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CLI = path.join(ROOT, 'scripts', 'curriculum-check.mjs');
const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'tests', 'fixtures', 'curriculum', 'forest-01-v2.json'),
    'utf8',
  ),
);

const ZERO_TRUST_COUNTS = {
  reviewedReadyDistinct: 0,
  prospectiveStarterDistinct: 0,
  starterReleasedDistinct: 0,
  starterRequiredDistinct: 1600,
};

function clonePackage(value = FIXTURE) {
  return structuredClone(value);
}

function runCli(args, label) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', CLI, ...args],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    },
  );
  assert.equal(
    result.error,
    undefined,
    `${label}: CLI process could not start`,
  );
  return result;
}

function parseJsonStdout(result, label) {
  const stdout = result.stdout.trim();
  assert.notEqual(stdout, '', `${label}: CLI emitted no JSON on stdout`);
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    assert.fail(`${label}: CLI stdout was not valid JSON`);
  }
  assert.ok(
    report && typeof report === 'object' && !Array.isArray(report),
    `${label}: CLI stdout JSON was not an object`,
  );
  return report;
}

async function withTempDir(callback) {
  const directory = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'hanzi-curriculum-cli-'),
  );
  try {
    return await callback(directory);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeFixture(directory, filename = 'forest-01-v2.json') {
  const filePath = path.join(directory, filename);
  await writeJson(filePath, clonePackage());
  return filePath;
}

function assertCommonReportShape(report, machineValidDistinct) {
  assert.equal(report.schemaVersion, 's3-content-1');
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.counts, {
    machineValidDistinct,
    ...ZERO_TRUST_COUNTS,
  });
  assert.deepEqual(report.releaseProof, {
    available: false,
    code: 'STARTER_RELEASE_PROOF_UNAVAILABLE',
  });
}

function assertValidPackage(report, filename = 'forest-01-v2.json') {
  assert.equal(report.packages.length, 1);
  assert.deepEqual(report.packages[0].file, filename);
  assert.equal(report.packages[0].lessonVersion, FIXTURE.lessonVersion);
  assert.equal(report.packages[0].ok, true);
  assert.match(report.packages[0].digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(report.packages[0].errors, []);
}

function packageFor(report, filename) {
  const packageReport = report.packages.find((item) => item.file === filename);
  assert.ok(packageReport, `missing package report for ${filename}`);
  return packageReport;
}

function assertPackageError(packageReport, pathPattern, code) {
  assert.ok(
    packageReport.errors.some(
      (error) => pathPattern.test(error.path) && error.code === code,
    ),
    `expected ${code} at ${pathPattern}`,
  );
}

function assertTopLevelError(report, code) {
  assert.ok(
    report.errors.some((error) => error.code === code),
    `expected top-level ${code}`,
  );
}

test('[S3-AC-004][C-CLI-01] audit reports machine-valid draft coverage without review or release claims', async () => {
  await withTempDir(async (directory) => {
    await writeFixture(directory);
    const audit = runCli(['--dir', directory, '--audit'], 'draft audit');
    assert.equal(audit.status, 0);
    const report = parseJsonStdout(audit, 'draft audit');

    assertCommonReportShape(report, 2);
    assertValidPackage(report);
    assert.doesNotMatch(
      audit.stdout,
      /STARTER_RELEASED|ownerApproved|reviewedAt/,
    );

    const required = runCli(
      ['--dir', directory, '--require-starter'],
      'starter gate',
    );
    assert.equal(required.status, 1);
    const requiredReport = parseJsonStdout(required, 'starter gate');
    assertCommonReportShape(requiredReport, 2);
    assert.deepEqual(requiredReport.packages, report.packages);
  });
});

test('[S3-AC-003][C-CLI-02] malformed JSON and approval-shaped fields fail with package errors', async () => {
  await withTempDir(async (directory) => {
    await fsp.writeFile(
      path.join(directory, '01-malformed.json'),
      '{"lessonId":',
      'utf8',
    );

    const untrusted = clonePackage();
    Object.assign(untrusted, {
      contentDigest: 'sha256:synthetic',
      reviewed: true,
      reviewStatus: 'approved',
      reviewer: 'synthetic-reviewer',
      reviewerName: 'synthetic-reviewer',
      reviewedAt: '2099-01-01T00:00:00Z',
      reviewEvidenceRef: 'synthetic-evidence',
      approved: true,
      ownerApproved: true,
      releaseScope: 'starter-library',
      releasedAt: '2099-01-01T00:00:00Z',
      candidateId: 'synthetic-candidate',
      testRunId: 'synthetic-test-run',
    });
    untrusted.characters[0].reviewerLabel = 'synthetic';
    await writeJson(path.join(directory, '02-untrusted.json'), untrusted);

    const result = runCli(['--dir', directory], 'invalid packages');
    assert.equal(result.status, 1);
    const report = parseJsonStdout(result, 'invalid packages');
    assertCommonReportShape(report, 0);
    assert.equal(report.packages.length, 2);

    const malformed = packageFor(report, '01-malformed.json');
    assert.equal(malformed.ok, false);
    assert.equal(malformed.lessonVersion, null);
    assert.equal(malformed.digest, null);
    assertPackageError(malformed, /^\$$/, 'JSON_PARSE_ERROR');

    const untrustedReport = packageFor(report, '02-untrusted.json');
    assert.equal(untrustedReport.ok, false);
    assert.equal(untrustedReport.lessonVersion, FIXTURE.lessonVersion);
    assert.equal(untrustedReport.digest, null);
    for (const field of [
      'contentDigest',
      'reviewed',
      'reviewStatus',
      'reviewer',
      'reviewerName',
      'reviewedAt',
      'reviewEvidenceRef',
      'approved',
      'ownerApproved',
      'releaseScope',
      'releasedAt',
      'candidateId',
      'testRunId',
    ]) {
      assertPackageError(
        untrustedReport,
        new RegExp(`^${field}$`),
        'UNKNOWN_KEY',
      );
    }
    assertPackageError(
      untrustedReport,
      /^characters\[0\]\.reviewerLabel$/,
      'UNKNOWN_KEY',
    );
  });
});

test('[S3-AC-004][C-CLI-03] duplicate lesson versions invalidate every conflicting package and do not double-count characters', async () => {
  await withTempDir(async (directory) => {
    await writeFixture(directory, 'a.json');
    const conflicting = clonePackage();
    conflicting.title = 'A different synthetic draft';
    await writeJson(path.join(directory, 'b.json'), conflicting);

    const result = runCli(['--dir', directory], 'duplicate versions');
    assert.equal(result.status, 1);
    const report = parseJsonStdout(result, 'duplicate versions');
    assertCommonReportShape(report, 0);
    assert.equal(report.packages.length, 2);
    for (const filename of ['a.json', 'b.json']) {
      const packageReport = packageFor(report, filename);
      assert.equal(packageReport.ok, false);
      assert.equal(packageReport.digest, null);
      assertPackageError(
        packageReport,
        /^lessonVersion$/,
        'DUPLICATE_LESSON_VERSION',
      );
    }
  });
});

test('[S3-AC-004][C-CLI-04] only root regular JSON files are audited; subdirectories and symlinks are ignored', async () => {
  await withTempDir(async (directory) => {
    await writeFixture(directory);
    const nested = path.join(directory, 'nested');
    await fsp.mkdir(nested);
    const ignoredFile = path.join(nested, 'ignored.json');
    await fsp.writeFile(ignoredFile, '{"not": "a package"}', 'utf8');
    await fsp.symlink(ignoredFile, path.join(directory, 'linked.json'));

    const result = runCli(['--dir', directory], 'file selection');
    assert.equal(result.status, 0);
    const report = parseJsonStdout(result, 'file selection');
    assertCommonReportShape(report, 2);
    assertValidPackage(report);

    const empty = path.join(directory, 'empty');
    await fsp.mkdir(empty);
    const emptyResult = runCli(['--dir', empty], 'empty directory');
    assert.equal(emptyResult.status, 0);
    const emptyReport = parseJsonStdout(emptyResult, 'empty directory');
    assertCommonReportShape(emptyReport, 0);
    assert.deepEqual(emptyReport.packages, []);
  });
});

test('[S3-AC-004][C-CLI-05] invalid arguments and unreadable directories exit 2 with sanitized JSON errors', async () => {
  await withTempDir(async (directory) => {
    const unknown = runCli(['--not-a-real-option'], 'unknown option');
    assert.equal(unknown.status, 2);
    const unknownReport = parseJsonStdout(unknown, 'unknown option');
    assertTopLevelError(unknownReport, 'INVALID_ARGUMENT');
    assert.doesNotMatch(unknown.stdout, /not-a-real-option/);

    const missingDirectory = path.join(
      directory,
      `missing-${randomBytes(6).toString('hex')}`,
    );
    const missing = runCli(['--dir', missingDirectory], 'missing directory');
    assert.equal(missing.status, 2);
    const missingReport = parseJsonStdout(missing, 'missing directory');
    assertTopLevelError(missingReport, 'DIRECTORY_UNREADABLE');
    assert.doesNotMatch(missing.stdout, new RegExp(missingDirectory));
  });
});

test('[S3-AC-004][C-CLI-06] audit JSON is deterministic and contains no path or timestamp data', async () => {
  await withTempDir(async (directory) => {
    await writeFixture(directory);
    const first = runCli(['--dir', directory], 'deterministic audit first run');
    const second = runCli(
      ['--dir', directory],
      'deterministic audit second run',
    );
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    const firstReport = parseJsonStdout(first, 'deterministic audit first run');
    const secondReport = parseJsonStdout(
      second,
      'deterministic audit second run',
    );
    assert.deepEqual(secondReport, firstReport);
    assert.equal(second.stdout, first.stdout);
    assert.doesNotMatch(first.stdout, new RegExp(directory));
    assert.doesNotMatch(first.stdout, /20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

test('[S3-AC-004][C-CLI-07] malformed UTF-8 is a JSON parse failure rather than replacement text', async () => {
  await withTempDir(async (directory) => {
    const bytes = Buffer.from(JSON.stringify(clonePackage()), 'utf8');
    const marker = Buffer.from('Build', 'utf8');
    const offset = bytes.indexOf(marker);
    assert.notEqual(offset, -1);
    bytes[offset] = 0xc3;
    bytes[offset + 1] = 0x28;
    await fsp.writeFile(path.join(directory, 'malformed-utf8.json'), bytes);

    const result = runCli(['--dir', directory], 'malformed UTF-8');
    assert.equal(result.status, 1);
    const report = parseJsonStdout(result, 'malformed UTF-8');
    assertCommonReportShape(report, 0);
    const malformed = packageFor(report, 'malformed-utf8.json');
    assert.equal(malformed.ok, false);
    assert.equal(malformed.lessonVersion, null);
    assert.equal(malformed.digest, null);
    assertPackageError(malformed, /^\$$/, 'JSON_PARSE_ERROR');
  });
});
