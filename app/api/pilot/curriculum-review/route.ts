import { corpusEntryRoute } from '@/lib/pilot/corpus-entry-http';
export async function GET(request: Request) {
  return corpusEntryRoute(request, 'owner-entry');
}
