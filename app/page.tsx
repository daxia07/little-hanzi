import { env } from 'cloudflare:workers';
import { redirect } from 'next/navigation';
import LegacyHomePage from '@/components/legacy/HomePage';
import { homeRouteForPilotMode } from '@/lib/pilot-entry';

/**
 * Keep the local lesson at the root by default. A hosted deployment opts into
 * the authenticated pilot explicitly through its Cloudflare binding.
 */
export default function HomePage() {
  const bindings = env as unknown as { HANZI_PILOT_MODE?: unknown };
  if (homeRouteForPilotMode(bindings.HANZI_PILOT_MODE) === '/pilot') {
    redirect('/pilot');
  }
  return <LegacyHomePage />;
}
