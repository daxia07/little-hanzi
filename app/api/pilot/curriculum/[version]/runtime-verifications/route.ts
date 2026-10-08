import {
  createCurriculumRuntimeVerification,
  curriculumRuntimeErrorResponse,
  requireCurriculumRuntimeConfig,
  runtimeJson,
} from '@/lib/pilot/curriculum-runtime';
import {
  bodyJson,
  errorResponse,
  requireOrigin,
  requirePilotSession,
  routeParam,
} from '@/lib/pilot/http';

export async function POST(request: Request, context: { params: unknown }): Promise<Response> {
  const session = await requirePilotSession(request);
  if (session instanceof Response) return session;
  try {
    requireCurriculumRuntimeConfig(session.config);
    if (session.user.role !== 'operator') return errorResponse('FORBIDDEN', 'operator access is required', 403);
    const originFailure = requireOrigin(request, session.config);
    if (originFailure) return originFailure;
    const version = await routeParam(context, 'version');
    const value = await bodyJson(request);
    const result = await createCurriculumRuntimeVerification(session, version, value);
    return runtimeJson(result.body, result.created ? 201 : 200);
  } catch (caught) {
    return curriculumRuntimeErrorResponse(caught);
  }
}
