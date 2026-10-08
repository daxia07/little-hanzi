import { notFound } from 'next/navigation';
import ForestReview from '@/components/forest/ForestReview';
import { previewRuntime } from '@/lib/preview/runtime';

export default function ForestReviewPage() {
  const config = previewRuntime();
  if (!config.previewMode) notFound();
  return <ForestReview testMode={config.testMode} />;
}
