import { corpusAuthorityRoute } from '@/lib/pilot/corpus-authority-http';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ version: string }> },
) {
  const p = await params;
  return corpusAuthorityRoute(request, 'publication', p.version);
}

import { corpusEntryRoute } from '@/lib/pilot/corpus-entry-http';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ version: string }> },
) {
  return corpusEntryRoute(request, 'publication-head', (await params).version);
}
