import { notFound } from 'next/navigation';
import ForestLesson from '@/components/forest/ForestLesson';
import { previewRuntime } from '@/lib/preview/runtime';

export default function ForestLessonPage() {
  if (!previewRuntime().previewMode) notFound();
  return <ForestLesson />;
}
