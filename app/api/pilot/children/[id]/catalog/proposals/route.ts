import { corpusFamilyRoute } from '@/lib/pilot/corpus-family-http';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return corpusFamilyRoute(request, (await context.params).id, 'proposal');
}
