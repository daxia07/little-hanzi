import { storyRoute } from '@/lib/pilot/story-http';
import { routeParam } from '@/lib/pilot/http';
export async function POST(
  request: Request,
  context: { params: unknown },
): Promise<Response> {
  return storyRoute(request, 'start', await routeParam(context, 'id'));
}
