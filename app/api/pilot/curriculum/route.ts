import { curriculumRoute } from '@/lib/pilot/curriculum';

export const GET = (request: Request) => curriculumRoute(request, 'coverage');
export const POST = (request: Request) => curriculumRoute(request, 'import');
