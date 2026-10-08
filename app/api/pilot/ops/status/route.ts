import { opsRoute } from '../../../../../lib/pilot/ops-http.ts';
export async function GET(request: Request): Promise<Response> {
  return opsRoute(request, 'status');
}
