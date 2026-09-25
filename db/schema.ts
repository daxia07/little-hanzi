import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
export const attempts = sqliteTable('attempts', { profile:text('profile').notNull(), id:text('id').notNull(), createdAt:text('created_at').notNull(), payload:text('payload').notNull() }, t=>[primaryKey({columns:[t.profile,t.id]})]);
export const settings = sqliteTable('settings', { profile:text('profile').primaryKey(), payload:text('payload').notNull() });
export const drafts = sqliteTable('drafts', { profile:text('profile').primaryKey(), updatedAt:integer('updated_at').notNull(), payload:text('payload').notNull() });
