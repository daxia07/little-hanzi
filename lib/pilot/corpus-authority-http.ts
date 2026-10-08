/** Only implemented protected owner and ordinary group authority routes. */
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
  readCorpusOwnerReview,
  readCorpusOwnerItem,
  decideCorpusOwner,
} from './corpus-owner-store.ts';
import { publishCorpus, withdrawCorpus } from './corpus-authority.ts';
export async function corpusAuthorityRoute(
  request: Request,
  operation:
    | 'owner-review'
    | 'owner-item'
    | 'owner-decision'
    | 'publication'
    | 'withdrawal',
  version: string,
  lessonVersion = '',
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
        operation === 'owner-review'
          ? ['snapshotId', 'limit', 'cursor']
          : operation === 'owner-item'
            ? ['snapshotId']
            : [];
    if (
      [...params.keys()].some((k) => !allowed.includes(k)) ||
      allowed.some((k) => params.getAll(k).length > 1) ||
      (mutating && params.size)
    )
      fail('INVALID_QUERY', 400);
    if (operation === 'owner-review' && request.method === 'GET')
      return json(
        await readCorpusOwnerReview(c, version, {
          snapshotId: params.get('snapshotId'),
          ...(params.has('limit') ? { limit: params.get('limit') } : {}),
          ...(params.has('cursor') ? { cursor: params.get('cursor') } : {}),
        }),
      );
    if (operation === 'owner-item' && request.method === 'GET')
      return json(
        await readCorpusOwnerItem(
          c,
          version,
          params.get('snapshotId') ?? '',
          lessonVersion,
        ),
      );
    if (
      request.method !== 'POST' ||
      operation === 'owner-review' ||
      operation === 'owner-item'
    )
      return errorResponse('METHOD_NOT_ALLOWED', 'Method is not allowed.', 405);
    const input = await bodyJson(request, 64000);
    if (operation === 'owner-decision')
      return json(await decideCorpusOwner(c, version, input));
    if (operation === 'publication')
      return json(await publishCorpus(c, version, input));
    return json(await withdrawCorpus(c, version, input));
  } catch (error) {
    if (error instanceof StoryError || error instanceof PilotDbError)
      return errorResponse(
        error.code,
        error.status === 503
          ? 'Corpus authority is temporarily unavailable.'
          : error.code,
        error.status,
      );
    return errorResponse(
      'STORAGE_UNAVAILABLE',
      'Corpus authority is temporarily unavailable.',
      503,
    );
  }
}
