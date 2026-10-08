import { corpusEntryRoute } from '@/lib/pilot/corpus-entry-http';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ version: string }> },
) {
  const p = await params;
  return corpusEntryRoute(request, 'batch-validate', p.version);
}
