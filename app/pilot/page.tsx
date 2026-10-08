import { env } from 'cloudflare:workers';
import { notFound } from 'next/navigation';
import PilotApp from '@/components/pilot/PilotApp';

function pilotEnabled(value: unknown) {
  return value === true || value === '1' || value === 'true' || value === 'yes';
}

export default function PilotPage() {
  const bindings = env as unknown as { HANZI_PILOT_MODE?: string | boolean };
  if (!pilotEnabled(bindings.HANZI_PILOT_MODE)) notFound();
  return <PilotApp />;
}
