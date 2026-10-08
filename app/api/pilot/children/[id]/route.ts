import { json, requireReadableChild, routeParam } from '@/lib/pilot/http';

export async function GET(request: Request, context: { params: unknown }): Promise<Response> {
  const childId = await routeParam(context, 'id');
  const result = await requireReadableChild(request, childId);
  if (result instanceof Response) return result;
  return json({ child: { id: result.child.id, name: result.child.name } });
}
