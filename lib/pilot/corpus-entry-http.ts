/** Only entry1 role reads and side-effect-free batch validation. */
import {
  bodyJson,
  errorResponse,
  json,
  requirePilotSession,
  requireOrigin,
} from './http.ts';
import { pilotBindings } from './runtime.ts';
import { parseCorpusBindings } from './corpus-config.ts';
import { StoryError, fail } from './story-policy.ts';
import { PilotDbError } from './db.ts';
import {
  discoverChildCorpora,
  discoverCorpusOwner,
  validateCorpusBatch,
  readCorpusBatch,
  readCorpusSnapshotPackages,
  readCorpusOwnerDecisions,
  readCorpusDecision,
  readCorpusPublication,
  readCorpusPublicationHead,
} from './corpus-entry-store.ts';
export type CorpusEntryOperation =
  | 'family-entry'
  | 'owner-entry'
  | 'batch-validate'
  | 'batch-read'
  | 'snapshot-packages'
  | 'owner-decisions'
  | 'decision-read'
  | 'publication-read'
  | 'publication-head';
export async function corpusEntryRoute(
  request: Request,
  operation: CorpusEntryOperation,
  version = '',
  recordId = '',
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
      paged = [
        'family-entry',
        'owner-entry',
        'snapshot-packages',
        'owner-decisions',
      ].includes(operation),
      allowed = paged ? ['limit', 'cursor'] : [];
    if (
      [...params.keys()].some((k) => !allowed.includes(k)) ||
      allowed.some((k) => params.getAll(k).length > 1) ||
      (mutating && params.size)
    )
      fail('INVALID_QUERY', 400);
    const paging = {
      ...(params.has('limit') ? { limit: params.get('limit') } : {}),
      ...(params.has('cursor') ? { cursor: params.get('cursor') } : {}),
    };
    if (operation === 'batch-validate' && request.method === 'POST')
      return json(
        await validateCorpusBatch(
          c,
          version,
          await bodyJson(request, 2 * 1024 * 1024),
        ),
      );
    if (request.method !== 'GET' || operation === 'batch-validate')
      return errorResponse('METHOD_NOT_ALLOWED', 'Method is not allowed.', 405);
    switch (operation) {
      case 'family-entry':
        return json(await discoverChildCorpora(c, recordId, paging));
      case 'owner-entry':
        return json(await discoverCorpusOwner(c, paging));
      case 'batch-read':
        return json(await readCorpusBatch(c, version, recordId));
      case 'snapshot-packages':
        return json(
          await readCorpusSnapshotPackages(c, version, recordId, paging),
        );
      case 'owner-decisions':
        return json(
          await readCorpusOwnerDecisions(c, version, recordId, paging),
        );
      case 'decision-read':
        return json(await readCorpusDecision(c, version, recordId));
      case 'publication-read':
        return json(await readCorpusPublication(c, version, recordId));
      case 'publication-head':
        return json(await readCorpusPublicationHead(c, version));
    }
  } catch (error) {
    if (error instanceof StoryError || error instanceof PilotDbError)
      return errorResponse(
        error.code,
        error.status === 503
          ? 'Corpus entry is temporarily unavailable.'
          : error.code,
        error.status,
      );
    return errorResponse(
      'STORAGE_UNAVAILABLE',
      'Corpus entry is temporarily unavailable.',
      503,
    );
  }
}
