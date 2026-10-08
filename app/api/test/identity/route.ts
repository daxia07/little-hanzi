import { requireTest, testError, testStore } from '../_shared';
import { json } from '@/app/api/preview/_shared';

export async function GET(request: Request): Promise<Response> {
  const config = requireTest(request);
  if (config instanceof Response) return config;
  try {
    await testStore(config).ensureSchema();
    return json({ mode: 'test', testMode: true, testRunId: config.testRunId, candidateId: config.candidateId, isolatedStorage: true, storageMarker: `preview-test:${config.testRunId}` });
  } catch (caught) {
    return testError(caught);
  }
}
