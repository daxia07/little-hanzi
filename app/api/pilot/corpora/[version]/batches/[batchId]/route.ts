import { corpusEntryRoute } from '@/lib/pilot/corpus-entry-http';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ version: string; batchId: string }> },
) {
  const p = await params;
  return corpusEntryRoute(request, 'batch-read', p.version, p.batchId);
}
