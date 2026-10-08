import {
  curriculumRuntimeErrorResponse,
  getCurriculumRuntimeProgress,
  requireCurriculumRuntimeConfig,
  runtimeJson,
} from '@/lib/pilot/curriculum-runtime';
import { requirePilotSession, routeParam } from '@/lib/pilot/http';

export async function GET(request: Request, context: { params: unknown }): Promise<Response> {
  const session = await requirePilotSession(request);
  if (session instanceof Response) return session;
  try {
    requireCurriculumRuntimeConfig(session.config);
    const childId = await routeParam(context, 'id');
    const runId = await routeParam(context, 'runId');
    return runtimeJson(await getCurriculumRuntimeProgress(session, childId, runId));
  } catch (caught) {
    return curriculumRuntimeErrorResponse(caught);
  }
}
