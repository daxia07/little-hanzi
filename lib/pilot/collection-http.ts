import {
  bodyJson,
  errorResponse,
  json,
  requireOrigin,
  requirePilotSession,
} from './http.ts';
import { importCollection, listCollections } from './collection-store.ts';
import { StoryError } from './story-policy.ts';
export async function collectionsRoute(request: Request): Promise<Response> {
  const c = await requirePilotSession(request);
  if (c instanceof Response) return c;
  if (request.method === 'POST') {
    const denied = requireOrigin(request, c.config);
    if (denied) return denied;
  }
  try {
    if (request.method === 'GET') return json(await listCollections(c));
    if (request.method === 'POST')
      return json(await importCollection(c, await bodyJson(request, 128000)));
    return errorResponse(
      'METHOD_NOT_ALLOWED',
      'The method is not allowed.',
      405,
    );
  } catch (e) {
    if (e instanceof StoryError)
      return errorResponse(
        e.code,
        e.code === 'STORAGE_UNAVAILABLE'
          ? 'Learning is temporarily unavailable.'
          : e.code,
        e.status,
      );
    return errorResponse(
      'STORAGE_UNAVAILABLE',
      'Learning is temporarily unavailable.',
      503,
    );
  }
}
