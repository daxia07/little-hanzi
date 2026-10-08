'use client';
import { useMemo, useSyncExternalStore } from 'react';
import {
  createPreviewStoryTransport,
  createStoryRecovery,
} from '@/lib/story-client';
import StoryLesson from './StoryLesson';
const subscribe = () => () => {};
export default function PreviewStory() {
  const ready = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const dependencies = useMemo(() => {
    if (!ready) return null;
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {}
    return {
      transport: createPreviewStoryTransport(),
      recovery: createStoryRecovery(storage),
    };
  }, [ready]);
  return dependencies ? (
    <StoryLesson {...dependencies} />
  ) : (
    <p lang="en">Preparing the story preview…</p>
  );
}
