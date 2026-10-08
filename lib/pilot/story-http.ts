import { inspectCorpusLearningQuery } from './corpus-learning-policy.ts';
import { isCorpusResource } from './corpus-learning-store.ts';
import { parseCorpusBindings } from './corpus-config.ts';
import { pilotBindings } from './runtime.ts';
import {
  corpusLearningContext,
  corpusPlacement,
  corpusPlans,
  corpusPractice,
} from './corpus-learning-store.ts';
import {
  bodyJson,
  errorResponse,
  json,
  requirePilotConfig,
  requirePilotSession,
  requireOrigin,
} from './http.ts';
import { StoryError } from './story-policy.ts';
import { exact } from '../curriculum/story-package.ts';
import {
  submitStoryProof,
  recordStoryOwner,
  publishStory,
  storyLibrary,
  storyPlacement,
  proposeStory,
  approveStory,
  storyPlans,
  storyPractice,
  startStory,
  getStoryRun,
  advanceStory,
  bootstrapStory,
} from './story-store.ts';
import manifest from '../../content/curriculum/forest-01-v4.json' with { type: 'json' };
import positiveFixture from '../../tests/fixtures/curriculum/forest-01-v4-positive-publication.json' with { type: 'json' };
export type StoryOperation =
  | 'proof'
  | 'owner'
  | 'publication'
  | 'library'
  | 'placement'
  | 'proposal'
  | 'approve'
  | 'plan'
  | 'practice'
  | 'start'
  | 'run'
  | 'action'
  | 'bootstrap'
  | 'bootstrap-positive';
export async function storyRoute(
  request: Request,
  operation: StoryOperation,
  resourceId = '',
): Promise<Response> {
  if (operation === 'bootstrap' || operation === 'bootstrap-positive') {
    const config = requirePilotConfig();
    if (config instanceof Response) return config;
    if (
      !config.testMode ||
      !config.testContentAllowed ||
      !config.testToken ||
      !config.testRunId ||
      !config.candidateExplicitlyBound ||
      !config.curriculumTrust ||
      !config.storyCapability
    )
      return errorResponse('NOT_FOUND', 'not found', 404);
    if (request.headers.get('X-Hanzi-Test-Token') !== config.testToken)
      return errorResponse('FORBIDDEN', 'test token is required', 403);
  }
  const session = await requirePilotSession(request);
  let c = session;
  if (c instanceof Response) return c;
  const mutating = request.method !== 'GET';
  if (mutating) {
    const denied = requireOrigin(request, c.config);
    if (denied) return denied;
  }
  try {
    const input = mutating ? await bodyJson(request, 128000) : null;
    let collectionVersion: string | undefined;
    const corpusVersion = inspectCorpusLearningQuery(
      new URL(request.url).searchParams,
      operation,
    );
    if (
      request.method === 'GET' &&
      ['library', 'placement', 'plan', 'practice'].includes(operation)
    ) {
      const params = new URL(request.url).searchParams;
      if (params.has('collectionVersion')) {
        const values = params.getAll('collectionVersion');
        if (
          values.length !== 1 ||
          [...params.keys()].some((k) => k !== 'collectionVersion') ||
          !values[0] ||
          !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(values[0])
        )
          throw new StoryError('INVALID_REQUEST', 400);
        collectionVersion = values[0];
      }
    }
    const kind =
      operation === 'approve'
        ? 'proposal'
        : operation === 'start'
          ? 'assignment'
          : ['run', 'action'].includes(operation)
            ? 'run'
            : null;
    const storedId =
      operation === 'approve' &&
      input &&
      typeof input === 'object' &&
      'proposalId' in input
        ? String(input.proposalId)
        : resourceId;
    if (
      corpusVersion !== undefined ||
      (kind && (await isCorpusResource(c, kind, storedId)))
    )
      c = {
        ...c,
        corpus: parseCorpusBindings(
          pilotBindings() as unknown as Record<string, unknown>,
        ),
      } as typeof c;
    let value: unknown;
    switch (operation) {
      case 'proof':
        value = await submitStoryProof(c, input);
        break;
      case 'owner':
        value = await recordStoryOwner(c, resourceId, input);
        break;
      case 'publication':
        value = await publishStory(c, resourceId, input);
        break;
      case 'library':
        value = await storyLibrary(c, resourceId, collectionVersion);
        break;
      case 'placement':
        value =
          request.method === 'POST'
            ? await proposeStory(c, resourceId, input)
            : corpusVersion !== undefined
              ? await corpusPlacement(
                  corpusLearningContext(c),
                  resourceId,
                  corpusVersion,
                )
              : await storyPlacement(c, resourceId, collectionVersion);
        break;
      case 'proposal':
        value = await proposeStory(c, resourceId, input);
        break;
      case 'approve':
        value = await approveStory(c, resourceId, input);
        break;
      case 'plan':
        value =
          corpusVersion !== undefined
            ? await corpusPlans(
                corpusLearningContext(c),
                resourceId,
                corpusVersion,
              )
            : await storyPlans(c, resourceId, collectionVersion);
        break;
      case 'practice':
        value =
          corpusVersion !== undefined
            ? await corpusPractice(
                corpusLearningContext(c),
                resourceId,
                corpusVersion,
              )
            : await storyPractice(c, resourceId, collectionVersion);
        break;
      case 'start':
        value = await startStory(c, resourceId, input);
        break;
      case 'run':
        value = await getStoryRun(c, resourceId);
        break;
      case 'action':
        value = await advanceStory(c, resourceId, input);
        break;
      case 'bootstrap':
        value = await bootstrapStory(c, input, manifest);
        break;
      case 'bootstrap-positive':
        if (
          !exact(input, ['fixture']) ||
          input.fixture !== 'positive-publication'
        )
          throw new StoryError('INVALID_REQUEST', 400);
        value = await bootstrapStory(
          c,
          { fixture: 'family-story' },
          positiveFixture,
        );
        break;
    }
    return json(value);
  } catch (caught) {
    if (caught instanceof StoryError)
      return errorResponse(
        caught.code,
        caught.code === 'STORAGE_UNAVAILABLE'
          ? 'Learning is temporarily unavailable.'
          : caught.code,
        caught.status,
      );
    if (
      caught instanceof Error &&
      'code' in caught &&
      caught.code === 'INVALID_REQUEST'
    )
      return errorResponse('INVALID_REQUEST', 'The request is invalid.', 400);
    return errorResponse(
      'STORAGE_UNAVAILABLE',
      'Learning is temporarily unavailable.',
      503,
    );
  }
}
