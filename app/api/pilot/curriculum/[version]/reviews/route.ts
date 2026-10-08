import { curriculumRoute } from '@/lib/pilot/curriculum';
import { routeParam } from '@/lib/pilot/http';

export async function POST(request: Request, context: { params: unknown }) {
  return curriculumRoute(
    request,
    'review',
    await routeParam(context, 'version'),
  );
}
