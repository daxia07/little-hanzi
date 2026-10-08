import { curriculumRoute } from '@/lib/pilot/curriculum';
import { routeParam } from '@/lib/pilot/http';

export async function GET(request: Request, context: { params: unknown }) {
  return curriculumRoute(
    request,
    'detail',
    await routeParam(context, 'version'),
  );
}
