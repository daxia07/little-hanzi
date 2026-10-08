import { bodyJson, exactObject, forbidden, requireTest, testError, testStore } from '../../../_shared';
import { json } from '@/app/api/preview/_shared';
import { PreviewDomainError } from '@/lib/preview/domain';

async function params(context: { params: unknown }): Promise<{ runId: string }> { return Promise.resolve(context.params).then((value) => value as { runId: string }); }

export async function POST(request: Request, context: { params: unknown }): Promise<Response> {
  const config = requireTest(request);
  if (config instanceof Response) return config;
  try {
    const body = await bodyJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || (!exactObject(body, ['at']) && !exactObject(body, ['effectiveTime'])) || typeof ((body as Record<string, unknown>).at ?? (body as Record<string, unknown>).effectiveTime) !== 'string') return json({ error: { code: 'INVALID_REQUEST', message: 'clock time is invalid' } }, 400);
    const { runId } = await params(context);
    const at = ((body as Record<string, unknown>).at ?? (body as Record<string, unknown>).effectiveTime) as string;
    const selectedTime = await testStore(config).setClock(runId, at);
    return json({ runId, effectiveTime: selectedTime });
  } catch (caught) {
    if (caught instanceof PreviewDomainError && caught.code === 'EVENT_CONFLICT') return forbidden(caught.message);
    return testError(caught);
  }
}
