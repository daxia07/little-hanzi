import { corpusAuthorityRoute } from '@/lib/pilot/corpus-authority-http';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ version: string }> },
) {
  const p = await params;
  return corpusAuthorityRoute(request, 'owner-review', p.version);
}
