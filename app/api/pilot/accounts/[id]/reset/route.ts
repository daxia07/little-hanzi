import { resetPilotPassword } from '@/lib/pilot/db';
import {
  bodyJson,
  errorResponse,
  handlePilotError,
  json,
  requireAccountManager,
  requireOrigin,
  requirePilotSession,
  routeParam,
} from '@/lib/pilot/http';
import { validatePasswordInput } from '@/lib/pilot/policy';
import { accountMetadata } from '../../_shared';

export async function POST(request: Request, context: { params: unknown }): Promise<Response> {
  const required = await requirePilotSession(request);
  if (required instanceof Response) return required;
  const denied = requireAccountManager(required);
  if (denied) return denied;
  const originFailure = requireOrigin(request, required.config);
  if (originFailure) return originFailure;
  try {
    const body = await bodyJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'password')) return errorResponse('INVALID_REQUEST', 'password input is invalid', 400);
    const password = validatePasswordInput((body as { password?: unknown }).password);
    if (!password) return errorResponse('INVALID_REQUEST', 'password input is invalid', 400);
    const account = await resetPilotPassword(required.db, await routeParam(context, 'id'), password, required.user.id);
    return json({ account: accountMetadata(account) });
  } catch (caught) {
    return handlePilotError(caught);
  }
}
