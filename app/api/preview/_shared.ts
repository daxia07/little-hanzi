import { PreviewDomainError } from '@/lib/preview/domain';
import { previewRuntime, previewStore, type PreviewRuntimeConfig } from '@/lib/preview/runtime';

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function previewNotFound(): Response {
  return json({ error: { code: 'NOT_FOUND', message: 'preview mode is unavailable' } }, 404);
}

export function requirePreview(): PreviewRuntimeConfig | Response {
  const config = previewRuntime();
  return config.previewMode ? config : previewNotFound();
}

export function storeForPreview(config: PreviewRuntimeConfig) {
  return previewStore(config);
}

export async function bodyJson(request: Request, limit = 200_000): Promise<unknown> {
  const text = await request.text();
  if (text.length > limit) throw new PreviewDomainError('INVALID_REQUEST', 'request body is too large', 400);
  try { return JSON.parse(text); } catch { throw new PreviewDomainError('INVALID_REQUEST', 'request body must be valid JSON', 400); }
}

export function handleError(caught: unknown): Response {
  if (caught instanceof PreviewDomainError) return json({ error: { code: caught.code, message: caught.message } }, caught.status);
  console.error('Preview API failure', caught);
  return json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'preview storage is unavailable' } }, 503);
}

export function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function routeParams(context: { params: unknown }): Promise<Record<string, string>> {
  return Promise.resolve(context.params).then((params) => params as Record<string, string>);
}
