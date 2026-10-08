import { opsRoute } from '../../../../../../lib/pilot/ops-http.ts';
import { routeParam } from '../../../../../../lib/pilot/http.ts';
export async function GET(
  request: Request,
  context: { params: unknown },
): Promise<Response> {
  return opsRoute(request, 'detail', await routeParam(context, 'id'));
}
