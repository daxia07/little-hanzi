import { PreviewDomainError } from '@/lib/preview/domain';
import { previewRuntime, previewStore, type PreviewRuntimeConfig } from '@/lib/preview/runtime';
import { json } from '@/app/api/preview/_shared';

export function requireTest(request: Request): PreviewRuntimeConfig | Response {
  const config = previewRuntime();
  if (!config.previewMode || !config.testMode || !config.testRunId) return json({ error: { code: 'NOT_FOUND', message: 'test mode is unavailable' } }, 404);
  if (!config.testToken || request.headers.get('X-Hanzi-Test-Token') !== config.testToken) return json({ error: { code: 'FORBIDDEN', message: 'test token is required' } }, 403);
  return config;
}

export function testStore(config: PreviewRuntimeConfig) {
  return previewStore(config);
}

export function testError(caught: unknown): Response {
  if (caught instanceof PreviewDomainError) return json({ error: { code: caught.code, message: caught.message } }, caught.status);
  console.error('Preview test API failure', caught);
  return json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'test storage is unavailable' } }, 503);
}

export function forbidden(message: string): Response {
  return json({ error: { code: 'FORBIDDEN', message } }, 403);
}

export { bodyJson, exactObject, routeParams } from '@/app/api/preview/_shared';
