import { ingestCorpusProof } from './corpus-proof-store.ts';
import {
  beginCorpusSnapshot,
  appendCorpusSnapshotChunk,
  sealCorpusSnapshot,
  readCorpusSnapshot,
  readCorpusSnapshotMembers,
} from './corpus-snapshot-store.ts';
/** Only implemented registration/diagnostic routes. No lifecycle or family authority facade. */
import {
  bodyJson,
  errorResponse,
  json,
  requirePilotSession,
  requireOrigin,
} from './http.ts';
import { pilotBindings } from './runtime.ts';
import { PilotDbError } from './db.ts';
import { StoryError, fail } from './story-policy.ts';
import { parseCorpusBindings } from './corpus-config.ts';
import {
  registerCorpus,
  listCorpora,
  registerCorpusBatch,
  recordCorpusSource,
} from './corpus-store.ts';
import { corpusCoverage } from './corpus-coverage.ts';
export type CorpusFoundationOperation =
  | 'corpora'
  | 'batch'
  | 'source'
  | 'coverage';
export async function corpusFoundationRoute(
  request: Request,
  operation: CorpusFoundationOperation,
  version = '',
): Promise<Response> {
  const session = await requirePilotSession(request);
  if (session instanceof Response) return session;
  const mutating = request.method !== 'GET';
  if (mutating) {
    const denied = requireOrigin(request, session.config);
    if (denied) return denied;
  }
  try {
    const c = {
      ...session,
      corpus: parseCorpusBindings(
        pilotBindings() as unknown as Record<string, unknown>,
      ),
    };
    const params = new URL(request.url).searchParams;
    if (
      [...params.keys()].some((k) => !['limit', 'cursor'].includes(k)) ||
      ['limit', 'cursor'].some((k) => params.getAll(k).length > 1) ||
      (mutating && params.size > 0)
    )
      fail('INVALID_QUERY', 400);
    const paging = {
      ...(params.has('limit') ? { limit: params.get('limit') } : {}),
      ...(params.has('cursor') ? { cursor: params.get('cursor') } : {}),
    };
    if (operation === 'corpora' && request.method === 'GET')
      return json(await listCorpora(c, paging));
    if (operation === 'coverage' && request.method === 'GET')
      return json(await corpusCoverage(c, version, paging));
    if (request.method !== 'POST')
      return errorResponse('METHOD_NOT_ALLOWED', 'Method is not allowed.', 405);
    const input = await bodyJson(request, 2 * 1024 * 1024);
    if (operation === 'corpora') return json(await registerCorpus(c, input));
    if (operation === 'batch')
      return json(await registerCorpusBatch(c, version, input));
    if (operation === 'source')
      return json(await recordCorpusSource(c, version, input));
    return errorResponse('METHOD_NOT_ALLOWED', 'Method is not allowed.', 405);
  } catch (error) {
    if (error instanceof StoryError || error instanceof PilotDbError)
      return errorResponse(
        error.code,
        error.status === 503
          ? 'Corpus administration is temporarily unavailable.'
          : error.code,
        error.status,
      );
    return errorResponse(
      'STORAGE_UNAVAILABLE',
      'Corpus administration is temporarily unavailable.',
      503,
    );
  }
}

/** Ordinary evidence/snapshot routes only; no verification bootstrap or publication. */
export type CorpusSnapshotOperation =
  | 'proof'
  | 'snapshot-begin'
  | 'snapshot-chunk'
  | 'snapshot-seal'
  | 'snapshot-read'
  | 'snapshot-members';
export async function corpusSnapshotRoute(
  request: Request,
  operation: CorpusSnapshotOperation,
  version: string,
  snapshotId = '',
): Promise<Response> {
  const session = await requirePilotSession(request);
  if (session instanceof Response) return session;
  const mutating = request.method !== 'GET';
  if (mutating) {
    const denied = requireOrigin(request, session.config);
    if (denied) return denied;
  }
  try {
    const c = {
        ...session,
        corpus: parseCorpusBindings(
          pilotBindings() as unknown as Record<string, unknown>,
        ),
      },
      params = new URL(request.url).searchParams,
      allowed =
        operation === 'snapshot-members' ? ['status', 'limit', 'cursor'] : [];
    if (
      [...params.keys()].some((k) => !allowed.includes(k)) ||
      allowed.some((k) => params.getAll(k).length > 1) ||
      (mutating && params.size > 0)
    )
      fail('INVALID_QUERY', 400);
    if (request.method === 'GET' && operation === 'snapshot-read')
      return json(await readCorpusSnapshot(c, version, snapshotId));
    if (request.method === 'GET' && operation === 'snapshot-members')
      return json(
        await readCorpusSnapshotMembers(c, version, snapshotId, {
          ...(params.has('status') ? { status: params.get('status') } : {}),
          ...(params.has('limit') ? { limit: params.get('limit') } : {}),
          ...(params.has('cursor') ? { cursor: params.get('cursor') } : {}),
        }),
      );
    if (
      request.method !== 'POST' ||
      operation === 'snapshot-read' ||
      operation === 'snapshot-members'
    )
      return errorResponse('METHOD_NOT_ALLOWED', 'Method is not allowed.', 405);
    const input = await bodyJson(
      request,
      operation === 'proof'
        ? 128 * 1024
        : operation === 'snapshot-chunk'
          ? 16384
          : 64000,
    );
    if (operation === 'proof')
      return json(await ingestCorpusProof(c, version, input));
    if (operation === 'snapshot-begin')
      return json(await beginCorpusSnapshot(c, version, input));
    if (operation === 'snapshot-chunk')
      return json(
        await appendCorpusSnapshotChunk(c, version, snapshotId, input),
      );
    return json(await sealCorpusSnapshot(c, version, snapshotId, input));
  } catch (error) {
    if (error instanceof StoryError || error instanceof PilotDbError)
      return errorResponse(
        error.code,
        error.status === 503
          ? 'Corpus administration is temporarily unavailable.'
          : error.code,
        error.status,
      );
    return errorResponse(
      'STORAGE_UNAVAILABLE',
      'Corpus administration is temporarily unavailable.',
      503,
    );
  }
}
