'use client';
import { useEffect, useRef, useState } from 'react';
import { registerPilotStoryController } from '@/lib/pilot-story-client';
import { STORY_ASSET_ROOT } from '@/lib/story-presentation';
import styles from '@/components/story/story.module.css';
type Controller = {
  perform: (name: string) => void;
  setMode: (mode: string) => void;
  setReducedMotion: (value: boolean) => void;
  destroy: () => void;
};
export default function StoryCompanion({
  performance = 'welcome',
  reducedMotion = false,
}: {
  performance?:
    | 'welcome'
    | 'hint'
    | 'encourage'
    | 'focused'
    | 'aha'
    | 'delighted';
  reducedMotion?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    controller = useRef<Controller | null>(null);
  const [status, setStatus] = useState('loading');
  const played = useRef<string | null>(null),
    currentReduced = useRef(reducedMotion);
  useEffect(() => {
    let disposed = false;
    let current: Controller | null = null;
    const unregister = registerPilotStoryController(() => {
      disposed = true;
      current?.destroy();
      controller.current = null;
    });
    const initialImage = host.current?.querySelector('img');
    const initialText = host.current?.querySelector('p');
    const fallbackError = () => {
      if (initialImage) initialImage.hidden = true;
      if (initialText) initialText.hidden = false;
    };
    initialImage?.addEventListener('error', fallbackError);
    const url = `${STORY_ASSET_ROOT}/mascot.mjs`;
    void import(/* @vite-ignore */ url)
      .then((module) => {
        if (disposed || !host.current) return;
        current = module.mountMascot(host.current, {
          reducedMotion: currentReduced.current,
          onStatus: (s: string) => {
            if (!disposed) setStatus(s);
          },
        });
        controller.current = current;
        current?.setMode('teaching');
      })
      .catch(() => {
        if (!disposed) setStatus('fallback');
      });
    return () => {
      disposed = true;
      unregister();
      initialImage?.removeEventListener('error', fallbackError);
      current?.destroy();
      controller.current = null;
    };
    // Reduced motion is applied live separately; the mount retains its own OS listener.
  }, []);
  useEffect(() => {
    currentReduced.current = reducedMotion;
    controller.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);
  useEffect(() => {
    if (
      (status === 'rest' || status === 'playing') &&
      played.current !== performance
    ) {
      played.current = performance;
      controller.current?.perform(performance);
    }
  }, [performance, status]);
  return (
    <aside className={styles.companion} aria-label="Teaching companion">
      <div
        ref={host}
        data-motion={status}
        dangerouslySetInnerHTML={{
          __html: `<img src="${STORY_ASSET_ROOT}/capybara-welcome-v6.png" alt="Friendly school capybara"><p hidden>Your guide is here. Follow the activity instructions.</p>`,
        }}
      />
      <span className={styles.companionLabel}>Your story guide</span>
      <button
        type="button"
        data-control="companion-performance"
        onClick={() => controller.current?.perform(performance)}
      >
        Show guide gesture
      </button>
    </aside>
  );
}
