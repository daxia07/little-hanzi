import { corpusFoundationRoute } from '@/lib/pilot/corpus-http';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ version: string }> },
) {
  return corpusFoundationRoute(request, 'source', (await params).version);
}
