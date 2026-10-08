import { corpusProgressForSession } from '@/lib/pilot/corpus-learning-store';
import { collectionProgress } from '@/lib/pilot/collection-store';
import { storyProgress } from '@/lib/pilot/story-store';
import { getExport } from '@/lib/pilot/learning';
import {
  errorResponse,
  handlePilotError,
  json,
  requireReadableChild,
  routeParam,
} from '@/lib/pilot/http';

export async function GET(
  request: Request,
  context: { params: unknown },
): Promise<Response> {
  const childId = await routeParam(context, 'id');
  const result = await requireReadableChild(request, childId);
  if (result instanceof Response) return result;
  if (result.context.user.role !== 'parent')
    return errorResponse('FORBIDDEN', 'linked parent access is required', 403);
  try {
    const filenameId = childId.replace(/[^A-Za-z0-9_-]/g, '_');
    return json(
      {
        ...(await getExport(result.context.db, result.child)),
        curriculum: await storyProgress(result.context, childId),
        collections: await collectionProgress(result.context, childId),
        corpora: await corpusProgressForSession(result.context, childId),
      },
      200,
      {
        'Content-Disposition': `attachment; filename="pilot-learning-${filenameId}.json"`,
      },
    );
  } catch (caught) {
    return handlePilotError(caught);
  }
}
