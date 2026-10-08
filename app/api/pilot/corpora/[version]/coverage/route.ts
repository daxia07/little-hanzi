import { corpusFoundationRoute } from '@/lib/pilot/corpus-http';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ version: string }> },
) {
  return corpusFoundationRoute(request, 'coverage', (await params).version);
}
