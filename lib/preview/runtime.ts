import { env } from 'cloudflare:workers';
import { error } from './domain.ts';
import { createPreviewStore, type D1PreviewStore, type PreviewNamespace } from './store.ts';

export interface PreviewBindings {
  DB?: D1Database;
  HANZI_PREVIEW_MODE?: string | boolean;
  HANZI_TEST_MODE?: string | boolean;
  HANZI_TEST_RUN_ID?: string;
  HANZI_TEST_TOKEN?: string;
  HANZI_CANDIDATE_ID?: string;
  HANZI_PILOT_MODE?: string | boolean;
}

export interface PreviewRuntimeConfig {
  previewMode: boolean;
  testMode: boolean;
  testRunId: string | null;
  testToken: string | null;
  candidateId: string;
}

export function previewBindings(): PreviewBindings {
  return env as unknown as PreviewBindings;
}

function enabled(value: string | boolean | undefined): boolean {
  return value === true || value === '1' || value === 'true' || value === 'yes';
}

export function previewRuntime(): PreviewRuntimeConfig {
  const bindings = previewBindings();
  return {
    previewMode: enabled(bindings.HANZI_PREVIEW_MODE) && !enabled(bindings.HANZI_PILOT_MODE),
    testMode: enabled(bindings.HANZI_TEST_MODE),
    testRunId: typeof bindings.HANZI_TEST_RUN_ID === 'string' && bindings.HANZI_TEST_RUN_ID.length > 0 ? bindings.HANZI_TEST_RUN_ID : null,
    testToken: typeof bindings.HANZI_TEST_TOKEN === 'string' && bindings.HANZI_TEST_TOKEN.length > 0 ? bindings.HANZI_TEST_TOKEN : null,
    candidateId: typeof bindings.HANZI_CANDIDATE_ID === 'string' && bindings.HANZI_CANDIDATE_ID.length > 0 ? bindings.HANZI_CANDIDATE_ID : 'local-preview',
  };
}

export function previewNamespace(config = previewRuntime()): PreviewNamespace {
  return { synthetic: config.testMode, testRunId: config.testMode ? config.testRunId : null };
}

export function previewStore(config = previewRuntime()): D1PreviewStore {
  const database = previewBindings().DB;
  if (!database) throw error('STORAGE_UNAVAILABLE', 'preview database binding is unavailable');
  return createPreviewStore(database, previewNamespace(config));
}

export function randomSeed(): number {
  const values = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(values);
    return values[0] >>> 0;
  }
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

export function nowIso(): string {
  return new Date().toISOString();
}
