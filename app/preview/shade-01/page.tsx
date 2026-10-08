import { notFound } from 'next/navigation';
import { previewRuntime } from '@/lib/preview/runtime';
import PreviewStory from '@/components/story/PreviewStory';
export default function ShadeStoryPage() {
  if (!previewRuntime().previewMode) notFound();
  return <PreviewStory />;
}
