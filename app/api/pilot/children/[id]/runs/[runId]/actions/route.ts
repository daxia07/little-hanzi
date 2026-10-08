import { applyLearningAction } from '@/lib/pilot/learning';
import type { PreviewAction } from '@/lib/preview/types';
import {
  bodyJson,
  errorResponse,
  handlePilotError,
  json,
  requireOrigin,
  requireReadableChild,
  routeParam,
} from '@/lib/pilot/http';

export async function POST(request: Request, context: { params: unknown }): Promise<Response> {
  const childId = await routeParam(context, 'id');
  const runId = await routeParam(context, 'runId');
  const result = await requireReadableChild(request, childId);
  if (result instanceof Response) return result;
  if (result.context.user.role !== 'child' || result.context.user.id !== childId) return errorResponse('FORBIDDEN', 'the child account is required', 403);
  const originFailure = requireOrigin(request, result.context.config);
  if (originFailure) return originFailure;
  try {
    const body = await bodyJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'eventId,expectedRevision,payload,stepId,type') {
      return errorResponse('INVALID_REQUEST', 'action envelope is invalid', 400);
    }
    const ack = await applyLearningAction(result.context.db, result.context.config, childId, runId, body as unknown as PreviewAction);
    return json(ack);
  } catch (caught) {
    return handlePilotError(caught);
  }
}
