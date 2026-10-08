import { errorResponse } from '@/lib/pilot/http';

// Unknown API paths use the same private, non-cacheable error envelope as the
// implemented routes. Specific application routes still take precedence.
function notFound(): Response {
  return errorResponse('NOT_FOUND', 'API route was not found.', 404);
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
