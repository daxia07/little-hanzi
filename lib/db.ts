import { env } from 'cloudflare:workers';
export async function database() {
  const db=(env as unknown as { DB:D1Database }).DB;
  if(!db) throw new Error('Database binding is unavailable');
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS attempts (profile TEXT NOT NULL, id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(profile,id))'),
    db.prepare('CREATE TABLE IF NOT EXISTS settings (profile TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS drafts (profile TEXT PRIMARY KEY NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL)'),
  ]);
  return db;
}
