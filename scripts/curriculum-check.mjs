import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { curriculumDigest } from '../lib/curriculum/digest.ts';
import { orderIssues } from '../lib/curriculum/json.ts';
import { validateCurriculumPackage } from '../lib/curriculum/validate.ts';

const report = {
  schemaVersion: 's3-content-1',
  errors: [],
  packages: [],
  counts: {
    machineValidDistinct: 0,
    reviewedReadyDistinct: 0,
    prospectiveStarterDistinct: 0,
    starterReleasedDistinct: 0,
    starterRequiredDistinct: 1600,
  },
  releaseProof: { available: false, code: 'STARTER_RELEASE_PROOF_UNAVAILABLE' },
};

function options(args) {
  let directory = fileURLToPath(
    new URL('../content/curriculum', import.meta.url),
  );
  let mode = 'audit';
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (seen.has(arg)) return null;
    seen.add(arg);
    if (arg === '--dir') {
      const value = args[++index];
      if (!value || value.startsWith('--')) return null;
      directory = path.resolve(value);
    } else if (arg === '--audit' || arg === '--require-starter') {
      if (seen.has('--audit') && seen.has('--require-starter')) return null;
      mode = arg === '--audit' ? 'audit' : 'starter';
    } else return null;
  }
  return { directory, mode };
}

async function readPackage(directory, filename) {
  const result = {
    file: filename,
    lessonVersion: null,
    ok: false,
    digest: null,
    errors: [],
  };
  let handle;
  let source;
  try {
    // The entry may change after readdir: never follow a replacement symlink.
    handle = await open(
      path.join(directory, filename),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    if (!(await handle.stat()).isFile()) throw new Error('Not a regular file');
    source = await handle.readFile();
  } catch {
    result.errors.push({ path: '$', code: 'FILE_READ_ERROR' });
    return { result, input: null };
  } finally {
    await handle?.close();
  }
  let input;
  try {
    input = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(source),
    );
  } catch {
    result.errors.push({ path: '$', code: 'JSON_PARSE_ERROR' });
    return { result, input: null };
  }
  // Only bounded version identifiers belong in the audit, never arbitrary text.
  if (
    input &&
    typeof input.lessonVersion === 'string' &&
    /^[a-z0-9][a-z0-9._-]{0,79}$/.test(input.lessonVersion)
  ) {
    result.lessonVersion = input.lessonVersion;
  }
  const validated = validateCurriculumPackage(input);
  result.errors = validated.errors;
  return { result, input };
}

async function audit(args) {
  const parsed = options(args);
  if (!parsed) {
    report.errors.push({ path: '$', code: 'INVALID_ARGUMENT' });
    return 2;
  }
  let entries;
  try {
    // A directory symlink is also an input symlink, so do not follow it.
    if (!(await lstat(parsed.directory)).isDirectory())
      throw new Error('Not a directory');
    entries = await readdir(parsed.directory, { withFileTypes: true });
  } catch {
    report.errors.push({ path: '$', code: 'DIRECTORY_UNREADABLE' });
    return 2;
  }
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  const packages = [];
  for (const filename of filenames)
    packages.push(await readPackage(parsed.directory, filename));
  const versions = new Map();
  for (const { result } of packages) {
    if (result.lessonVersion !== null)
      versions.set(
        result.lessonVersion,
        (versions.get(result.lessonVersion) ?? 0) + 1,
      );
  }
  const characters = new Set();
  for (const { result, input } of packages) {
    if (versions.get(result.lessonVersion) > 1) {
      result.errors.push({
        path: 'lessonVersion',
        code: 'DUPLICATE_LESSON_VERSION',
      });
    }
    result.errors = orderIssues(result.errors);
    result.ok = result.errors.length === 0;
    if (result.ok) {
      result.digest = await curriculumDigest(input);
      for (const character of input.characters) characters.add(character.hanzi);
    }
    report.packages.push(result);
  }
  report.counts.machineValidDistinct = characters.size;
  return parsed.mode === 'starter' || report.packages.some((item) => !item.ok)
    ? 1
    : 0;
}

process.exitCode = await audit(process.argv.slice(2));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
