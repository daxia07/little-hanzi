import { forbidden, requireTest, testError, testStore } from '../../_shared';
import { json } from '@/app/api/preview/_shared';
import { PreviewDomainError } from '@/lib/preview/domain';

async function params(context: { params: unknown }): Promise<{ runId: string }> { return Promise.resolve(context.params).then((value) => value as { runId: string }); }

export async function DELETE(request: Request, context: { params: unknown }): Promise<Response> {
  const config = requireTest(request);
  if (config instanceof Response) return config;
  try {
    const { runId } = await params(context);
    await testStore(config).deleteSyntheticRun(runId);
    return json({ ok: true, runId });
  } catch (caught) {
    if (caught instanceof PreviewDomainError && caught.code === 'EVENT_CONFLICT') return forbidden(caught.message);
    return testError(caught);
  }
}
