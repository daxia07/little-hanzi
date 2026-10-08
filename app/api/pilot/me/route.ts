import { listChildrenForUser, listGrantsForParent } from '@/lib/pilot/db';
import { getPilotInstallationId, listAssignmentsForChildren } from '@/lib/pilot/learning';
import { handlePilotError, json, requirePilotSession, safeUser } from '@/lib/pilot/http';

export async function GET(request: Request): Promise<Response> {
  const required = await requirePilotSession(request, { allowPasswordChange: true });
  if (required instanceof Response) return required;
  try {
    const children = required.user.mustChangePassword ? [] : await listChildrenForUser(required.db, required.user);
    const [installationId, assignments] = await Promise.all([
      getPilotInstallationId(required.db),
      listAssignmentsForChildren(required.db, children.map((child) => child.id)),
    ]);
    const grants = !required.user.mustChangePassword && required.user.role === 'parent'
      ? await listGrantsForParent(required.db, required.user.id)
      : undefined;
    return json({
      user: safeUser(required.user),
      installationId,
      children: children.map((child) => ({
        id: child.id,
        name: child.name,
        ...(assignments.has(child.id) ? { assignment: assignments.get(child.id) } : {}),
      })),
      capabilities: { manageAccounts: !required.user.mustChangePassword && required.user.role === 'operator' },
      ...(grants ? {
        grants: grants.map((grant) => ({
          childId: grant.childId,
          teacherId: grant.teacherId,
          teacherName: grant.teacherName,
          teacherDisabled: grant.teacherDisabled,
          childName: grant.childName,
          childDisabled: grant.childDisabled,
          createdAt: String(grant.createdAt),
          grantedBy: grant.grantingParentId,
        })),
      } : {}),
    });
  } catch (caught) {
    return handlePilotError(caught);
  }
}
