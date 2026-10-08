import { corpusAuthorityRoute } from '@/lib/pilot/corpus-authority-http';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ version: string; lessonVersion: string }> },
) {
  const p = await params;
  return corpusAuthorityRoute(
    request,
    'owner-item',
    p.version,
    p.lessonVersion,
  );
}
