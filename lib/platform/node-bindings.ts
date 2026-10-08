import { createClient } from '@libsql/client/web';
import { createLibsqlD1 } from './libsql-d1.ts';

/** Runtime-only bindings for the Nitro/Vercel build. No schema creation. */
export function createNodeBindings(
  source: Record<string, string | undefined> = process.env,
) {
  let database: ReturnType<typeof createLibsqlD1> | undefined;
  let opsDatabase: ReturnType<typeof createLibsqlD1> | undefined;
  return new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, key) {
        // Vercel overwrites X-Forwarded-For. CF-Connecting-IP is untrusted here.
        if (key === 'HANZI_AUTH_IP_HEADER') return 'x-forwarded-for';
        if (key !== 'DB' && key !== 'OPS_DB')
          return typeof key === 'string' && key.startsWith('HANZI_')
            ? source[key]
            : undefined;
        const ops = key === 'OPS_DB';
        if (ops ? opsDatabase : database) return ops ? opsDatabase : database;
        const url = ops
          ? source.HANZI_OPS_DATABASE_URL
          : source.HANZI_DATABASE_URL;
        if (!url) return undefined;
        const parsed = new URL(url);
        if (
          ops &&
          source.HANZI_DATABASE_URL &&
          parsed.href === new URL(source.HANZI_DATABASE_URL).href
        )
          throw new Error('A separate operations database is required');
        const local =
          (ops
            ? source.HANZI_OPS_ALLOW_LOCAL_DATABASE
            : source.HANZI_ALLOW_LOCAL_DATABASE) === '1' &&
          source.VERCEL !== '1' &&
          parsed.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
        if (!['libsql:', 'https:'].includes(parsed.protocol) && !local) {
          throw new Error('A persistent remote database URL is required');
        }
        const token = ops
          ? source.HANZI_OPS_DATABASE_AUTH_TOKEN
          : source.HANZI_DATABASE_AUTH_TOKEN;
        if (!local && !token) return undefined;
        const created = createLibsqlD1(
          createClient({
            url,
            authToken: token,
            intMode: 'number',
          }),
        );
        if (ops) opsDatabase = created;
        else database = created;
        return created;
      },
    },
  );
}

export const env = createNodeBindings();
