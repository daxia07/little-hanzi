import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep prior-schema migration tests on their original five immutable inputs.
// New 0005 scenarios are tested separately, without rewriting old expectations.
export function legacyPilotRoot(projectRoot) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-legacy-schema-'),
  );
  fs.writeFileSync(
    path.join(root, '.hanzi-qa-owned'),
    'Immutable historical migration prefix fixture\n',
    { mode: 0o600 },
  );
  const directory = path.join(root, 'db/pilot-migrations');
  fs.mkdirSync(directory, { recursive: true });
  for (const name of [
    '0000-auth.sql',
    '0001-data.sql',
    '0002-learning.sql',
    '0003-curriculum.sql',
    '0004-curriculum-runtime.sql',
  ])
    fs.copyFileSync(
      path.join(projectRoot, 'db/pilot-migrations', name),
      path.join(directory, name),
    );
  process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Keep the exact R3/R4 six-migration contract available after additive R5. */
export function legacyStoryRoot(projectRoot) {
  const root = legacyPilotRoot(projectRoot);
  fs.copyFileSync(
    path.join(projectRoot, 'db/pilot-migrations/0005-family-story.sql'),
    path.join(root, 'db/pilot-migrations/0005-family-story.sql'),
  );
  return root;
}

/** Preserve the original R5 seven-learning/two-operations inputs and assertions. */
export function legacyCollectionRoot(projectRoot) {
  const root = legacyStoryRoot(projectRoot);
  fs.copyFileSync(
    path.join(projectRoot, 'db/pilot-migrations/0006-collection-learning.sql'),
    path.join(root, 'db/pilot-migrations/0006-collection-learning.sql'),
  );
  const ops = path.join(root, 'db/pilot-ops-migrations');
  fs.mkdirSync(ops, { recursive: true });
  for (const name of ['0000_ops.sql', '0001_collection_archives.sql'])
    fs.copyFileSync(
      path.join(projectRoot, 'db/pilot-ops-migrations', name),
      path.join(ops, name),
    );
  fs.symlinkSync(path.join(projectRoot, 'lib'), path.join(root, 'lib'), 'dir');
  return root;
}

/** Preserve R4's original learning4/operations1 archive fixture. */
export function legacyStoryOperationsRoot(projectRoot) {
  const root = legacyStoryRoot(projectRoot);
  fs.symlinkSync(path.join(projectRoot, 'lib'), path.join(root, 'lib'), 'dir');
  fs.mkdirSync(path.join(root, 'db/pilot-ops-migrations'), { recursive: true });
  fs.copyFileSync(
    path.join(projectRoot, 'db/pilot-ops-migrations/0000_ops.sql'),
    path.join(root, 'db/pilot-ops-migrations/0000_ops.sql'),
  );
  return root;
}
