/** New R6 family endpoints only. Existing R5 dispatch remains unchanged. */
import {
  bodyJson,
  errorResponse,
  json,
  requireOrigin,
  requirePilotSession,
} from './http.ts';
import { pilotBindings } from './runtime.ts';
import { parseCorpusBindings } from './corpus-config.ts';
import { StoryError, fail } from './story-policy.ts';
import { PilotDbError } from './db.ts';
import { readCorpusCatalog, proposeCorpus } from './corpus-family-store.ts';
export async function corpusFamilyRoute(
  request: Request,
  childId: string,
  operation: 'catalog' | 'proposal',
): Promise<Response> {
  const start = performance.now();
  const finish = (response: Response) => {
    response.headers.set(
      'Server-Timing',
      `${operation === 'catalog' ? 'catalog' : 'proposal'};dur=${(performance.now() - start).toFixed(2)}`,
    );
    return response;
  };
  const session = await requirePilotSession(request);
  if (session instanceof Response) return finish(session);
  if (request.method === 'POST') {
    const denied = requireOrigin(request, session.config);
    if (denied) return finish(denied);
  }
  try {
    const c = {
        ...session,
        corpus: parseCorpusBindings(
          pilotBindings() as unknown as Record<string, unknown>,
        ),
      },
      params = new URL(request.url).searchParams;
    if (operation === 'catalog' && request.method === 'GET') {
      if (
        [...params.keys()].some(
          (k) => !['corpusVersion', 'q', 'limit', 'cursor'].includes(k),
        ) ||
        ['corpusVersion', 'q', 'limit', 'cursor'].some(
          (k) => params.getAll(k).length > 1,
        ) ||
        !params.has('corpusVersion')
      )
        fail('INVALID_QUERY', 400);
      const raw = params.get('limit');
      if (raw !== null && !/^[1-9]\d?$/u.test(raw)) fail('INVALID_QUERY', 400);
      return finish(
        json(
          await readCorpusCatalog(c, childId, params.get('corpusVersion')!, {
            ...(params.has('q') ? { q: params.get('q') } : {}),
            ...(raw !== null ? { limit: Number(raw) } : {}),
            ...(params.has('cursor') ? { cursor: params.get('cursor') } : {}),
          }),
        ),
      );
    }
    if (operation === 'proposal' && request.method === 'POST') {
      if (params.size) fail('INVALID_QUERY', 400);
      return finish(
        json(await proposeCorpus(c, childId, await bodyJson(request, 8000))),
      );
    }
    return finish(
      errorResponse('METHOD_NOT_ALLOWED', 'Method is not allowed.', 405),
    );
  } catch (error) {
    if (error instanceof StoryError || error instanceof PilotDbError)
      return finish(
        errorResponse(
          error.code,
          error.status === 503
            ? 'Story choices are temporarily unavailable.'
            : error.code,
          error.status,
        ),
      );
    return finish(
      errorResponse(
        'STORAGE_UNAVAILABLE',
        'Story choices are temporarily unavailable.',
        503,
      ),
    );
  }
}
