import { opsRoute } from '../../../../../../lib/pilot/ops-http.ts';
import { routeParam } from '../../../../../../lib/pilot/http.ts';
export async function POST(
  request: Request,
  context: { params: unknown },
): Promise<Response> {
  return opsRoute(request, 'feedback', await routeParam(context, 'id'));
}
