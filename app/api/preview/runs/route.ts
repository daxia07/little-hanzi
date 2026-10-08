import { isLessonVersion } from '@/lib/preview/content';
import { makeRunId } from '@/lib/preview/store';
import { randomSeed, nowIso } from '@/lib/preview/runtime';
import {
  bodyJson,
  exactObject,
  handleError,
  json,
  requirePreview,
  storeForPreview,
} from '../_shared';

function runListItem(
  run: Awaited<
    ReturnType<ReturnType<typeof storeForPreview>['listRuns']>
  >[number],
) {
  return {
    runId: run.runId,
    lessonVersion: run.lessonVersion,
    completedAt: run.state.completedAt,
    latestActivity: run.updatedAt,
    phase: run.state.phase,
    stepId: run.state.stepId,
    revision: run.revision,
  };
}

export async function GET(): Promise<Response> {
  const config = requirePreview();
  if (config instanceof Response) return config;
  try {
    const runs = await storeForPreview(config).listRuns();
    return json({ runs: runs.map(runListItem) });
  } catch (caught) {
    return handleError(caught);
  }
}

export async function POST(request: Request): Promise<Response> {
  const config = requirePreview();
  if (config instanceof Response) return config;
  try {
    const body = await bodyJson(request);
    if (
      !exactObject(body, ['lessonId', 'lessonVersion']) ||
      body.lessonId !== 'forest-01' ||
      !isLessonVersion(body.lessonVersion)
    ) {
      return json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'an existing forest lesson version is required',
          },
        },
        400,
      );
    }
    const run = await storeForPreview(config).createRun({
      lessonVersion: body.lessonVersion,
      runId: makeRunId(
        config.testMode ? `synthetic-${config.testRunId}` : 'preview',
      ),
      seed: randomSeed(),
      now: nowIso(),
      synthetic: config.testMode,
      testRunId: config.testMode ? config.testRunId : null,
    });
    return json(
      {
        runId: run.runId,
        lessonId: run.lessonId,
        lessonVersion: run.lessonVersion,
        seed: run.seed,
        state: run.state,
        revision: run.revision,
      },
      201,
    );
  } catch (caught) {
    return handleError(caught);
  }
}
