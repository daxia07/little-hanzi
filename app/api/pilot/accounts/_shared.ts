import type { PilotUserRecord } from '@/lib/pilot/db';

export function accountMetadata(account: PilotUserRecord) {
  return {
    id: account.id,
    name: account.name,
    username: account.username,
    role: account.role,
    mustChangePassword: account.mustChangePassword,
    disabled: account.disabled,
  };
}
