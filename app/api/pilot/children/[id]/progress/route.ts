import { corpusProgressForSession } from '@/lib/pilot/corpus-learning-store';
import { collectionProgress } from '@/lib/pilot/collection-store';
import { storyProgress } from '@/lib/pilot/story-store';
import { getProgress } from '@/lib/pilot/learning';
import {
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
  try {
    return json({
      ...(await getProgress(result.context.db, result.child)),
      curriculum: await storyProgress(result.context, childId),
      collections: await collectionProgress(result.context, childId),
      corpora: await corpusProgressForSession(result.context, childId),
    });
  } catch (caught) {
    return handlePilotError(caught);
  }
}
