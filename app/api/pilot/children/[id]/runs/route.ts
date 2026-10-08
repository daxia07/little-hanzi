import { createRun, validateLessonVersionInput } from '@/lib/pilot/learning';
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
  const result = await requireReadableChild(request, childId);
  if (result instanceof Response) return result;
  if (result.context.user.role !== 'child' || result.context.user.id !== childId) return errorResponse('FORBIDDEN', 'the child account is required', 403);
  const originFailure = requireOrigin(request, result.context.config);
  if (originFailure) return originFailure;
  try {
    const body = await bodyJson(request);
    if (!validateLessonVersionInput(body)) return errorResponse('INVALID_REQUEST', 'lesson start input is invalid', 400);
    const created = await createRun(result.context.db, result.context.config, childId, body.lessonVersion);
    return json(created.run, created.created ? 201 : 200);
  } catch (caught) {
    return handlePilotError(caught);
  }
}
