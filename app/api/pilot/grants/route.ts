import { grantTeacher, revokeTeacher } from '@/lib/pilot/db';
import {
  bodyJson,
  errorResponse,
  handlePilotError,
  json,
  requireOrigin,
  requirePilotSession,
} from '@/lib/pilot/http';

interface GrantBody { childId: string; teacherId: string; }

async function grantBody(request: Request): Promise<GrantBody | null> {
  const body = await bodyJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'childId,teacherId') return null;
  const value = body as Partial<GrantBody>;
  return typeof value.childId === 'string' && typeof value.teacherId === 'string' && value.childId.length > 0 && value.teacherId.length > 0
    ? { childId: value.childId, teacherId: value.teacherId }
    : null;
}

async function mutation(request: Request, remove: boolean): Promise<Response> {
  const required = await requirePilotSession(request);
  if (required instanceof Response) return required;
  if (required.user.role !== 'parent') return errorResponse('FORBIDDEN', 'linked parent access is required', 403);
  const originFailure = requireOrigin(request, required.config);
  if (originFailure) return originFailure;
  try {
    const input = await grantBody(request);
    if (!input) return errorResponse('INVALID_REQUEST', 'grant input is invalid', 400);
    if (remove) {
      const removed = await revokeTeacher(required.db, required.user.id, input.childId, input.teacherId);
      if (!removed) return errorResponse('NOT_FOUND', 'grant was not found', 404);
      return json({ ok: true, childId: input.childId, teacherId: input.teacherId });
    }
    const grant = await grantTeacher(required.db, required.user.id, input.childId, input.teacherId);
    return json({ grant }, 201);
  } catch (caught) {
    return handlePilotError(caught);
  }
}

export function POST(request: Request): Promise<Response> { return mutation(request, false); }
export function DELETE(request: Request): Promise<Response> { return mutation(request, true); }
