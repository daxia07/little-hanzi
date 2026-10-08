import {
  assignLesson,
  assignmentsProjection,
  validateLessonVersionInput,
} from '@/lib/pilot/learning';
import {
  bodyJson,
  errorResponse,
  handlePilotError,
  json,
  requireOrigin,
  requireReadableChild,
  routeParam,
} from '@/lib/pilot/http';

export async function GET(request: Request, context: { params: unknown }): Promise<Response> {
  const childId = await routeParam(context, 'id');
  const result = await requireReadableChild(request, childId);
  if (result instanceof Response) return result;
  try {
    return json(await assignmentsProjection(result.context.db, result.context.config, childId));
  } catch (caught) {
    return handlePilotError(caught);
  }
}

export async function POST(request: Request, context: { params: unknown }): Promise<Response> {
  const childId = await routeParam(context, 'id');
  const result = await requireReadableChild(request, childId);
  if (result instanceof Response) return result;
  if (result.context.user.role !== 'parent') return errorResponse('FORBIDDEN', 'linked parent access is required', 403);
  const originFailure = requireOrigin(request, result.context.config);
  if (originFailure) return originFailure;
  try {
    const body = await bodyJson(request);
    if (!validateLessonVersionInput(body)) return errorResponse('INVALID_REQUEST', 'lesson assignment input is invalid', 400);
    const assignment = await assignLesson(result.context.db, result.context.config, result.context.user.id, childId, body.lessonVersion);
    return json({ assignment: assignment.assignment }, assignment.created ? 201 : 200);
  } catch (caught) {
    return handlePilotError(caught);
  }
}
