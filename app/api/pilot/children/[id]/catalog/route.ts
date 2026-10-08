import { corpusFamilyRoute } from '@/lib/pilot/corpus-family-http';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return corpusFamilyRoute(request, (await context.params).id, 'catalog');
}
