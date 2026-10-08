import { storyRoute } from '@/lib/pilot/story-http';
import { routeParam } from '@/lib/pilot/http';
export async function GET(
  request: Request,
  context: { params: unknown },
): Promise<Response> {
  return storyRoute(request, 'placement', await routeParam(context, 'id'));
}
export async function POST(
  request: Request,
  context: { params: unknown },
): Promise<Response> {
  return storyRoute(request, 'placement', await routeParam(context, 'id'));
}
