import { corpusSnapshotRoute } from '@/lib/pilot/corpus-http';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ version: string }> },
) {
  const p = await params;
  return corpusSnapshotRoute(request, 'proof', p.version);
}
