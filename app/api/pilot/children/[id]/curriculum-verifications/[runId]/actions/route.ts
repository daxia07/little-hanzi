import {
  applyCurriculumRuntimeAction,
  curriculumRuntimeErrorResponse,
  requireCurriculumRuntimeConfig,
  runtimeJson,
} from '@/lib/pilot/curriculum-runtime';
import {
  bodyJson,
  requireOrigin,
  requirePilotSession,
  routeParam,
} from '@/lib/pilot/http';

export async function POST(request: Request, context: { params: unknown }): Promise<Response> {
  const session = await requirePilotSession(request);
  if (session instanceof Response) return session;
  try {
    requireCurriculumRuntimeConfig(session.config);
    const originFailure = requireOrigin(request, session.config);
    if (originFailure) return originFailure;
    const childId = await routeParam(context, 'id');
    const runId = await routeParam(context, 'runId');
    return runtimeJson(await applyCurriculumRuntimeAction(session, childId, runId, await bodyJson(request)));
  } catch (caught) {
    return curriculumRuntimeErrorResponse(caught);
  }
}
