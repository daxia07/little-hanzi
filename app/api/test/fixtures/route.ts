import { isLessonVersion } from '@/lib/preview/content';
import {
  bodyJson,
  exactObject,
  requireTest,
  testError,
  testStore,
} from '../_shared';
import { createFixture, FIXTURE_SCENARIOS } from '@/lib/preview/fixtures';
import { json } from '@/app/api/preview/_shared';

export async function POST(request: Request): Promise<Response> {
  const config = requireTest(request);
  if (config instanceof Response) return config;
  try {
    const body = await bodyJson(request);
    const scenario =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).scenario
        : undefined;
    const seed =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).seed
        : undefined;
    const lessonVersion =
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      Object.hasOwn(body, 'lessonVersion')
        ? (body as Record<string, unknown>).lessonVersion
        : 'forest-01-v1';
    if (
      (!exactObject(body, ['scenario', 'seed']) &&
        !exactObject(body, ['scenario', 'seed', 'lessonVersion'])) ||
      !isLessonVersion(lessonVersion) ||
      typeof scenario !== 'string' ||
      !(FIXTURE_SCENARIOS as readonly string[]).includes(scenario) ||
      !Number.isInteger(seed) ||
      (seed as number) < 0 ||
      (seed as number) > 0xffffffff
    )
      return json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'fixture scenario or seed is invalid',
          },
        },
        400,
      );
    const result = await createFixture(
      testStore(config),
      scenario,
      seed as number,
      lessonVersion,
    );
    return json(result, 201);
  } catch (caught) {
    if (caught instanceof Error && !(caught as { code?: unknown }).code)
      return json(
        { error: { code: 'INVALID_REQUEST', message: caught.message } },
        400,
      );
    return testError(caught);
  }
}
