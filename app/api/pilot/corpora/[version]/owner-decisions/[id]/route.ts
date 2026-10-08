import { corpusEntryRoute } from '@/lib/pilot/corpus-entry-http';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ version: string; id: string }> },
) {
  const p = await params;
  return corpusEntryRoute(request, 'decision-read', p.version, p.id);
}
