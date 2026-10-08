import { getRunView } from '@/lib/pilot/learning';
import {
  handlePilotError,
  json,
  requireReadableChild,
  routeParam,
} from '@/lib/pilot/http';

export async function GET(request: Request, context: { params: unknown }): Promise<Response> {
  const childId = await routeParam(context, 'id');
  const runId = await routeParam(context, 'runId');
  const result = await requireReadableChild(request, childId);
  if (result instanceof Response) return result;
  try {
    return json(await getRunView(result.context.db, childId, runId));
  } catch (caught) {
    return handlePilotError(caught);
  }
}
