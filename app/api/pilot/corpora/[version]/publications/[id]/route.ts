import { corpusEntryRoute } from '@/lib/pilot/corpus-entry-http';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ version: string; id: string }> },
) {
  const p = await params;
  return corpusEntryRoute(request, 'publication-read', p.version, p.id);
}
