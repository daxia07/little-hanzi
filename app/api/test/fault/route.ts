import { bodyJson, exactObject, requireTest, testError, testStore } from '../_shared';
import { json } from '@/app/api/preview/_shared';

export async function POST(request: Request): Promise<Response> {
  const config = requireTest(request);
  if (config instanceof Response) return config;
  try {
    const body = await bodyJson(request);
    if (!exactObject(body, ['operation', 'enabled']) || body.operation !== 'storage' || typeof body.enabled !== 'boolean') return json({ error: { code: 'INVALID_REQUEST', message: 'fault operation is invalid' } }, 400);
    await testStore(config).setStorageFault(body.enabled);
    return json({ operation: 'storage', enabled: body.enabled });
  } catch (caught) {
    return testError(caught);
  }
}
