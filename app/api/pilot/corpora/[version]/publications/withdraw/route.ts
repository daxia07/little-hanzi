import { corpusAuthorityRoute } from '@/lib/pilot/corpus-authority-http';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ version: string }> },
) {
  const p = await params;
  return corpusAuthorityRoute(request, 'withdrawal', p.version);
}
