import { drizzle } from 'drizzle-orm/d1';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { username } from 'better-auth/plugins';
import { pilotAuthSchema } from '../../db/pilot-schema.ts';

export interface PilotAuthDatabase {
  prepare(query: string): D1PreparedStatement;
  batch<T extends D1PreparedStatement>(statements: T[]): Promise<D1Result<T>[]>;
}

export interface PilotAuthConfig {
  origin: string;
  secret: string;
  secureCookies?: boolean;
  basePath?: string;
  ipAddressHeader?: 'cf-connecting-ip' | 'x-forwarded-for';
}

function databaseOf(value: D1Database | PilotAuthDatabase): PilotAuthDatabase {
  if (!value || typeof value.prepare !== 'function' || typeof value.batch !== 'function') throw new TypeError('pilot auth requires a D1-compatible database');
  return value as PilotAuthDatabase;
}

/**
 * Creates the stateful Better Auth instance used by pilot routes.
 * Schema creation is deliberately absent: callers must apply the versioned
 * pilot migrations before constructing or serving this auth instance.
 */
export function createPilotAuth(db: D1Database | PilotAuthDatabase, config: PilotAuthConfig) {
  if (!config.origin || !/^https?:\/\//.test(config.origin)) throw new TypeError('pilot auth origin must be an absolute HTTP origin');
  if (!config.secret || config.secret.length < 32) throw new TypeError('pilot auth secret is too short');
  const rawDb = databaseOf(db);
  const drizzleDb = drizzle(rawDb as D1Database, { schema: pilotAuthSchema });

  return betterAuth({
    appName: 'Little Hanzi Pilot',
    baseURL: config.origin,
    basePath: config.basePath ?? '/api/auth',
    secret: config.secret,
    logger: { disabled: true },
    database: drizzleAdapter(drizzleDb, {
      provider: 'sqlite',
      schema: pilotAuthSchema,
      transaction: false,
    }),
    plugins: [username({
      displayUsername: true,
      immutableUsername: true,
      minUsernameLength: 3,
      maxUsernameLength: 30,
    })],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    user: {
      additionalFields: {
        role: { type: 'string', required: true, input: false, defaultValue: 'child' },
        mustChangePassword: { type: 'boolean', required: true, input: false, defaultValue: true },
        disabled: { type: 'boolean', required: true, input: false, returned: false, defaultValue: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    account: {},
    verification: {},
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 12,
      customRules: {
        '/sign-in/username': { window: 60, max: 8 },
        '/change-password': { window: 60, max: 6 },
      },
    },
    trustedOrigins: [config.origin],
    advanced: {
      ipAddress: { ipAddressHeaders: [config.ipAddressHeader ?? 'cf-connecting-ip'] },
      useSecureCookies: config.secureCookies ?? config.origin.startsWith('https://'),
      defaultCookieAttributes: {
        sameSite: 'lax',
        httpOnly: true,
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const user = await rawDb.prepare('SELECT disabled FROM pilot_auth_user WHERE id=?').bind(session.userId).first<{ disabled: number }>();
            if (user?.disabled === 1) return false;
          },
        },
      },
      account: {
        update: {
          after: async (account, context) => {
            if (context?.path !== '/change-password' || account.providerId !== 'credential') return;
            await rawDb.prepare('UPDATE pilot_auth_user SET must_change_password=0, updated_at=? WHERE id=?').bind(Date.now(), account.userId).run();
          },
        },
      },
    },
  });
}

export type PilotAuth = ReturnType<typeof createPilotAuth>;
