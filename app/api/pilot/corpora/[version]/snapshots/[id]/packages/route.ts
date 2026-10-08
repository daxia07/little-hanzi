import { corpusEntryRoute } from '@/lib/pilot/corpus-entry-http';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ version: string; id: string }> },
) {
  const p = await params;
  return corpusEntryRoute(request, 'snapshot-packages', p.version, p.id);
}
