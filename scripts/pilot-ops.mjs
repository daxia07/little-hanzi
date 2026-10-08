/** Explicit private operations jobs; no cron, migration or deployment effects. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadOpsConfig } from './pilot-ops-config.mjs';
import { PrivateArchiveStore, opsArchiveError } from './pilot-ops-archive.mjs';
const commands = ['backup', 'monitor', 'retention', 'reconcile'];
const opaque = (v) =>
  typeof v === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(v);
const fail = (code) => {
  throw opsArchiveError(code);
};
const safeCode = (e) =>
  typeof e?.code === 'string' && /^(OPS|BACKUP|RESTORE)_[A-Z_]+$/.test(e.code)
    ? e.code
    : 'OPS_UNAVAILABLE';
export function parseOpsArgs(args) {
  const [command, ...rest] = args;
  if (!commands.includes(command) || ![2, 4].includes(rest.length))
    fail('OPS_CLI_INVALID');
  const values = new Map();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i],
      value = rest[i + 1];
    if (
      !['--config', '--job'].includes(key) ||
      values.has(key) ||
      !value ||
      value.startsWith('--')
    )
      fail('OPS_CLI_INVALID');
    values.set(key, value);
  }
  const configPath = values.get('--config');
  if (
    !configPath ||
    !path.isAbsolute(configPath) ||
    path.normalize(configPath) !== configPath ||
    (command === 'reconcile'
      ? !opaque(values.get('--job'))
      : values.has('--job'))
  )
    fail('OPS_CLI_INVALID');
  return {
    command,
    configPath,
    input: command === 'reconcile' ? { subjectJobId: values.get('--job') } : {},
  };
}
function safeResult(result) {
  if (
    !opaque(result?.jobId) ||
    !['running', 'succeeded', 'verified', 'failed', 'uncertain'].includes(
      result.status,
    ) ||
    !Number.isSafeInteger(result.revision) ||
    result.revision < 0
  )
    fail('OPS_RESULT_INVALID');
  const out = {
    jobId: result.jobId,
    status: result.status,
    revision: result.revision,
  };
  if (result.archiveId !== null && result.archiveId !== undefined) {
    if (!opaque(result.archiveId)) fail('OPS_RESULT_INVALID');
    out.archiveId = result.archiveId;
  }
  if (result.code) out.code = safeCode({ code: result.code });
  if (Array.isArray(result.archives)) out.archiveCount = result.archives.length;
  return out;
}
async function openClient(config, kind) {
  const { createClient } = await import('@libsql/client');
  return createClient({
    url: config[kind === 'learning' ? 'learningURL' : 'operationsURL'],
    authToken:
      config[kind === 'learning' ? 'learningToken' : 'operationsToken'],
  });
}
export async function runOpsCommand(
  parsed,
  {
    load = loadOpsConfig,
    openClient: open = openClient,
    executor: factory,
  } = {},
) {
  let config, learningClient, operationsClient;
  try {
    // Revalidate even callers of the programmatic entry; never accept effect/path inputs.
    const checked = parseOpsArgs([
      parsed.command,
      '--config',
      parsed.configPath,
      ...(parsed.command === 'reconcile'
        ? ['--job', parsed.input?.subjectJobId]
        : []),
    ]);
    if (JSON.stringify(parsed.input) !== JSON.stringify(checked.input))
      fail('OPS_CLI_INVALID');
    config = load(checked.configPath);
    learningClient = await open(config, 'learning');
    operationsClient = await open(config, 'operations');
    const createExecutor =
      factory ??
      (
        await import(
          pathToFileURL(
            path.join(config.sourceRoot, 'scripts/pilot-ops-jobs.mjs'),
          ).href
        )
      ).createOpsExecutor;
    const executor = await createExecutor({
      ...config,
      learningClient,
      operationsClient,
      archiveStore: factory
        ? undefined
        : new PrivateArchiveStore(config.archiveRoot),
      probe: async () => {
        const response = await fetch(config.healthURL, {
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
          cache: 'no-store',
        });
        if (!response.ok) return 'unhealthy';
        const body = await response.json();
        return body.candidateId === config.build().candidateId
          ? 'healthy'
          : 'unhealthy';
      },
    });
    return safeResult(await executor.dispatch(checked.command, checked.input));
  } catch (error) {
    fail(safeCode(error));
  } finally {
    let cleanupFailed = false;
    for (const client of [learningClient, operationsClient]) {
      try {
        client?.close();
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      config?.dispose();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) fail('OPS_UNAVAILABLE');
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const result = await runOpsCommand(parseOpsArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result) + '\n');
    if (['uncertain', 'failed', 'running'].includes(result.status))
      process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      JSON.stringify({ status: 'refused', code: safeCode(error) }) + '\n',
    );
    process.exitCode = 1;
  }
}
