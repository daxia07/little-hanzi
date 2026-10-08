import { linkParentChild, unlinkParentChild } from '@/lib/pilot/db';
import {
  bodyJson,
  errorResponse,
  handlePilotError,
  json,
  requireAccountManager,
  requireOrigin,
  requirePilotSession,
} from '@/lib/pilot/http';

interface LinkBody { parentId: string; childId: string; }

async function linkBody(request: Request): Promise<LinkBody | null> {
  const body = await bodyJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'childId,parentId') return null;
  const value = body as Partial<LinkBody>;
  return typeof value.parentId === 'string' && typeof value.childId === 'string' && value.parentId.length > 0 && value.childId.length > 0
    ? { parentId: value.parentId, childId: value.childId }
    : null;
}

async function mutation(request: Request, remove: boolean): Promise<Response> {
  const required = await requirePilotSession(request);
  if (required instanceof Response) return required;
  const denied = requireAccountManager(required);
  if (denied) return denied;
  const originFailure = requireOrigin(request, required.config);
  if (originFailure) return originFailure;
  try {
    const input = await linkBody(request);
    if (!input) return errorResponse('INVALID_REQUEST', 'link input is invalid', 400);
    if (remove) {
      const removed = await unlinkParentChild(required.db, required.user.id, input.parentId, input.childId);
      if (!removed) return errorResponse('NOT_FOUND', 'link was not found', 404);
      return json({ ok: true, parentId: input.parentId, childId: input.childId });
    }
    const link = await linkParentChild(required.db, required.user.id, input.parentId, input.childId);
    return json({ link }, 201);
  } catch (caught) {
    return handlePilotError(caught);
  }
}

export function POST(request: Request): Promise<Response> { return mutation(request, false); }
export function DELETE(request: Request): Promise<Response> { return mutation(request, true); }
