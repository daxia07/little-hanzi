import { isLessonVersion } from '@/lib/preview/content';
import {
  bodyJson,
  exactObject,
  handleError,
  json,
  requirePreview,
  routeParams,
  storeForPreview,
} from '../../../_shared';

const validVersion = isLessonVersion;

export async function GET(
  _request: Request,
  context: { params: unknown },
): Promise<Response> {
  const config = requirePreview();
  if (config instanceof Response) return config;
  try {
    const { version } = await routeParams(context);
    if (!validVersion(version))
      return json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'lesson version is unsupported',
          },
        },
        400,
      );
    const view = await storeForPreview(config).getDecision(
      version,
      config.candidateId,
    );
    return json(view);
  } catch (caught) {
    return handleError(caught);
  }
}

export async function POST(
  request: Request,
  context: { params: unknown },
): Promise<Response> {
  const config = requirePreview();
  if (config instanceof Response) return config;
  try {
    const { version } = await routeParams(context);
    if (!validVersion(version))
      return json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'lesson version is unsupported',
          },
        },
        400,
      );
    const body = await bodyJson(request);
    if (
      !exactObject(body, ['status', 'reviewerLabel', 'notes', 'candidateId']) ||
      (body.status !== 'changes-requested' && body.status !== 'approved') ||
      typeof body.reviewerLabel !== 'string' ||
      body.reviewerLabel.trim().length < 1 ||
      body.reviewerLabel.length > 200 ||
      typeof body.notes !== 'string' ||
      body.notes.length > 4000 ||
      typeof body.candidateId !== 'string' ||
      body.candidateId.length < 1 ||
      body.candidateId.length > 200
    ) {
      return json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'review decision is invalid',
          },
        },
        400,
      );
    }
    const current = config;
    if (body.candidateId !== current.candidateId)
      return json(
        {
          error: {
            code: 'EVENT_CONFLICT',
            message: 'decision candidate does not match the running candidate',
          },
        },
        409,
      );
    const store = storeForPreview(config);
    const decision = await store.addDecision(version, {
      status: body.status,
      reviewerLabel: body.reviewerLabel,
      notes: body.notes,
      candidateId: body.candidateId,
      synthetic: config.testMode,
      testRunId: config.testMode ? config.testRunId : null,
    });
    const view = await store.getDecision(version, current.candidateId);
    return json(
      {
        decision,
        lessonVersion: view.lessonVersion,
        candidateId: view.candidateId,
        status: view.status,
        history: view.history,
      },
      201,
    );
  } catch (caught) {
    return handleError(caught);
  }
}
