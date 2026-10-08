import { storyRoute } from '@/lib/pilot/story-http';
import { routeParam } from '@/lib/pilot/http';
export async function GET(
  request: Request,
  context: { params: unknown },
): Promise<Response> {
  return storyRoute(request, 'plan', await routeParam(context, 'id'));
}
