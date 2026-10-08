import { corpusSnapshotRoute } from '@/lib/pilot/corpus-http';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ version: string; id: string }> },
) {
  const p = await params;
  return corpusSnapshotRoute(request, 'snapshot-chunk', p.version, p.id);
}
