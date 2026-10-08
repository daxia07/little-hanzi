import { listPilotUsers, provisionPilotAccount } from '@/lib/pilot/db';
import { validateIssuedAccountInput } from '@/lib/pilot/policy';
import {
  bodyJson,
  errorResponse,
  handlePilotError,
  json,
  requireAccountManager,
  requireOrigin,
  requirePilotSession,
} from '@/lib/pilot/http';
import { accountMetadata } from './_shared';

export async function GET(request: Request): Promise<Response> {
  const required = await requirePilotSession(request);
  if (required instanceof Response) return required;
  const denied = requireAccountManager(required);
  if (denied) return denied;
  try {
    const accounts = await listPilotUsers(required.db);
    return json({ accounts: accounts.map(accountMetadata) });
  } catch (caught) {
    return handlePilotError(caught);
  }
}

export async function POST(request: Request): Promise<Response> {
  const required = await requirePilotSession(request);
  if (required instanceof Response) return required;
  const denied = requireAccountManager(required);
  if (denied) return denied;
  const originFailure = requireOrigin(request, required.config);
  if (originFailure) return originFailure;
  try {
    const input = validateIssuedAccountInput(await bodyJson(request));
    if (!input) return errorResponse('INVALID_REQUEST', 'account input is invalid', 400);
    const account = await provisionPilotAccount(required.db, { ...input, actorUserId: required.user.id });
    return json({ account: accountMetadata(account) }, 201);
  } catch (caught) {
    return handlePilotError(caught);
  }
}
