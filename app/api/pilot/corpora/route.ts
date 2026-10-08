import { corpusFoundationRoute } from '@/lib/pilot/corpus-http';
export const GET = (request: Request) =>
  corpusFoundationRoute(request, 'corpora');
export const POST = (request: Request) =>
  corpusFoundationRoute(request, 'corpora');
