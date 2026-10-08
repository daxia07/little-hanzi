import {
  getOnboarding,
  saveOnboarding,
  validateOnboardingInput,
} from '@/lib/pilot/learning';
import {
  bodyJson,
  errorResponse,
  handlePilotError,
  json,
  requireOrigin,
  requireReadableChild,
  routeParam,
} from '@/lib/pilot/http';

async function parentChild(request: Request, childId: string) {
  const result = await requireReadableChild(request, childId);
  if (result instanceof Response) return result;
  if (result.context.user.role !== 'parent') return errorResponse('FORBIDDEN', 'linked parent access is required', 403);
  return result;
}

export async function GET(request: Request, context: { params: unknown }): Promise<Response> {
  const childId = await routeParam(context, 'id');
  const result = await parentChild(request, childId);
  if (result instanceof Response) return result;
  try {
    return json({ onboarding: await getOnboarding(result.context.db, childId) });
  } catch (caught) {
    return handlePilotError(caught);
  }
}

export async function PUT(request: Request, context: { params: unknown }): Promise<Response> {
  const childId = await routeParam(context, 'id');
  const result = await parentChild(request, childId);
  if (result instanceof Response) return result;
  const originFailure = requireOrigin(request, result.context.config);
  if (originFailure) return originFailure;
  try {
    const body = await bodyJson(request);
    const input = validateOnboardingInput(body);
    if (!input) return errorResponse('INVALID_REQUEST', 'onboarding input is invalid', 400);
    const onboarding = await saveOnboarding(result.context.db, result.context.user.id, childId, input);
    return json({ onboarding });
  } catch (caught) {
    return handlePilotError(caught);
  }
}
