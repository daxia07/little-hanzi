import { handleError, bodyJson, exactObject, json, requirePreview, routeParams, storeForPreview } from '../../../_shared';
import type { PreviewAction } from '@/lib/preview/types';

export async function POST(request: Request, context: { params: unknown }): Promise<Response> {
  const config = requirePreview();
  if (config instanceof Response) return config;
  try {
    const body = await bodyJson(request);
    if (!exactObject(body, ['eventId', 'expectedRevision', 'stepId', 'type', 'payload'])) return json({ error: { code: 'INVALID_REQUEST', message: 'action envelope is invalid' } }, 400);
    const { runId } = await routeParams(context);
    const ack = await storeForPreview(config).applyAction(runId, body as unknown as PreviewAction);
    return json(ack);
  } catch (caught) {
    return handleError(caught);
  }
}
