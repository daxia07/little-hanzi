import { storyRoute } from '@/lib/pilot/story-http';
export async function POST(request: Request): Promise<Response> {
  return storyRoute(request, 'bootstrap');
}
