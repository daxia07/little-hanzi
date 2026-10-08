import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { validateIssuedAccountInput } from '../lib/pilot/policy.ts';
import { loadManifest } from './qa-helpers.mjs';
import { localD1, sqlValue as q } from './pilot-local-db.mjs';

/** Used before a fresh candidate starts, and for the first local operator. */
export async function accountInsert(input, { id = crypto.randomUUID(), mustChangePassword = true, requireEmpty = false } = {}) {
  const account = validateIssuedAccountInput(input);
  if (!account) throw new Error('Invalid account input');
  const now = Date.now();
  const passwordHash = await hashPassword(account.password);
  const values = `${q(id)},${q(account.name)},${q(`${id}@accounts.invalid`)},0,${now},${now},${q(account.username)},${q(account.username)},${q(account.role)},${q(mustChangePassword)},0`;
  return {
    account: { id, username: account.username, password: account.password },
    sql: `INSERT INTO pilot_auth_user(id,name,email,email_verified,created_at,updated_at,username,display_username,role,must_change_password,disabled)
${requireEmpty ? `SELECT ${values} WHERE NOT EXISTS(SELECT 1 FROM pilot_auth_user)` : `VALUES(${values})`};
INSERT INTO pilot_auth_account(id,account_id,provider_id,user_id,password,created_at,updated_at)
VALUES(${q(crypto.randomUUID())},${q(id)},'credential',${q(id)},${q(passwordHash)},${now},${now});
INSERT INTO pilot_account_audit(id,action,actor_user_id,target_user_id,metadata,created_at)
VALUES(${q(crypto.randomUUID())},'local-provision',NULL,${q(id)},${q(JSON.stringify({ role: account.role }))},${now});`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
    if (!['--manifest', '--config', '--state'].every(flag => process.argv.includes(flag))) {
      throw new Error('Pass --manifest, --config and --state for an owned local candidate; provide account JSON on stdin');
    }
    const manifest = loadManifest(value('--manifest'));
    const db = localD1(manifest, { configPath: value('--config'), state: value('--state') });
    db.migrate();
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (input.role !== 'operator') throw new Error('Initial provisioning requires the operator role');
    const count = db.query('SELECT COUNT(*) AS count FROM pilot_auth_user;')[0].results[0].count;
    if (count !== 0) throw new Error('Initial operator already provisioned; use the authenticated operator screen');
    const created = await accountInsert(input, { requireEmpty: true });
    db.query(created.sql);
    console.log(JSON.stringify({ id: created.account.id, username: created.account.username, mustChangePassword: true }));
  } catch (error) {
    // Do not echo user JSON, passwords, hashes or SQL when provisioning fails.
    console.error(error instanceof SyntaxError ? 'Invalid JSON input' : error.message);
    process.exitCode = 1;
  }
}
