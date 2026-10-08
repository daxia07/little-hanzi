import { headers } from 'next/headers';
import { forbidden, notFound } from 'next/navigation';
import TestDesk from '@/components/forest/TestDesk';
import { previewRuntime } from '@/lib/preview/runtime';

export default async function PreviewTestPage() {
  const config = previewRuntime();
  if (!config.previewMode || !config.testMode) notFound();
  const requestHeaders = await headers();
  if (!config.testToken || requestHeaders.get('X-Hanzi-Test-Token') !== config.testToken) forbidden();
  return <TestDesk />;
}
