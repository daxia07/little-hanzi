import { opsRoute } from '../../../../../lib/pilot/ops-http.ts';
export async function POST(request: Request): Promise<Response> {
  return opsRoute(request, 'observation');
}
