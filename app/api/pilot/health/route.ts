import { json, requirePilotConfig } from '@/lib/pilot/http';

export function GET(): Response {
  const required = requirePilotConfig();
  if (required instanceof Response) return required;
  return json({ status: 'ok', candidateId: required.candidateId });
}
