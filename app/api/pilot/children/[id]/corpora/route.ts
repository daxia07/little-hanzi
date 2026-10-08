import { corpusEntryRoute } from '@/lib/pilot/corpus-entry-http';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const p = await params;
  return corpusEntryRoute(request, 'family-entry', '', p.id);
}
