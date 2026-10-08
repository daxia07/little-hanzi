import { corpusSnapshotRoute } from '@/lib/pilot/corpus-http';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ version: string; id: string }> },
) {
  const p = await params;
  return corpusSnapshotRoute(request, 'snapshot-read', p.version, p.id);
}
