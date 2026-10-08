import {
  parseCollectionCapability,
  type CollectionCapability,
} from './collection-policy.ts';
import {
  parseTrust,
  parseCapability,
  type CurriculumTrust,
  type StoryCapability,
} from './story-policy.ts';
import { env } from 'cloudflare:workers';

export interface PilotBindings {
  DB?: D1Database;
  HANZI_PILOT_MODE?: string | boolean;
  HANZI_PILOT_TEST_CONTENT?: string | boolean;
  HANZI_TEST_MODE?: string | boolean;
  HANZI_TEST_RUN_ID?: string;
  HANZI_TEST_TOKEN?: string;
  HANZI_AUTH_ORIGIN?: string;
  HANZI_AUTH_SECRET?: string;
  HANZI_AUTH_IP_HEADER?: string;
  HANZI_CANDIDATE_ID?: string;
  HANZI_CURRICULUM_TEST_NOW?: string;
  HANZI_CURRICULUM_TRUST?: string;
  HANZI_STORY_CAPABILITY?: string;
  HANZI_COLLECTION_CAPABILITY?: string;
}

export interface PilotRuntimeConfig {
  pilotMode: boolean;
  testMode: boolean;
  testContentAllowed: boolean;
  testRunId: string | null;
  testToken: string | null;
  origin: string | null;
  secret: string | null;
  candidateId: string;
  candidateExplicitlyBound: boolean;
  curriculumTestNow: string | null;
  database: D1Database | null;
  curriculumTrust?: CurriculumTrust | null;
  storyCapability?: StoryCapability | null;
  collectionCapability?: CollectionCapability | null;
  clientIpHeader?: 'cf-connecting-ip' | 'x-forwarded-for';
}

export function pilotBindings(): PilotBindings {
  return env as unknown as PilotBindings;
}

function enabled(value: string | boolean | undefined): boolean {
  return value === true || value === '1' || value === 'true' || value === 'yes';
}

export function pilotRuntime(): PilotRuntimeConfig {
  const bindings = pilotBindings();
  const origin =
    typeof bindings.HANZI_AUTH_ORIGIN === 'string' &&
    bindings.HANZI_AUTH_ORIGIN.length > 0
      ? bindings.HANZI_AUTH_ORIGIN
      : null;
  const secret =
    typeof bindings.HANZI_AUTH_SECRET === 'string' &&
    bindings.HANZI_AUTH_SECRET.length > 0
      ? bindings.HANZI_AUTH_SECRET
      : null;
  return {
    pilotMode: enabled(bindings.HANZI_PILOT_MODE),
    testMode: enabled(bindings.HANZI_TEST_MODE),
    testContentAllowed: enabled(bindings.HANZI_PILOT_TEST_CONTENT),
    testRunId:
      typeof bindings.HANZI_TEST_RUN_ID === 'string' &&
      bindings.HANZI_TEST_RUN_ID.length > 0
        ? bindings.HANZI_TEST_RUN_ID
        : null,
    testToken:
      typeof bindings.HANZI_TEST_TOKEN === 'string' &&
      bindings.HANZI_TEST_TOKEN.length > 0
        ? bindings.HANZI_TEST_TOKEN
        : null,
    origin,
    secret,
    candidateId:
      typeof bindings.HANZI_CANDIDATE_ID === 'string' &&
      bindings.HANZI_CANDIDATE_ID.length > 0
        ? bindings.HANZI_CANDIDATE_ID
        : 'local-pilot',
    candidateExplicitlyBound:
      typeof bindings.HANZI_CANDIDATE_ID === 'string' &&
      bindings.HANZI_CANDIDATE_ID.trim().length > 0,
    curriculumTestNow:
      typeof bindings.HANZI_CURRICULUM_TEST_NOW === 'string'
        ? bindings.HANZI_CURRICULUM_TEST_NOW
        : null,
    curriculumTrust: parseConfigJson(
      bindings.HANZI_CURRICULUM_TRUST,
      parseTrust,
    ),
    storyCapability: parseConfigJson(
      bindings.HANZI_STORY_CAPABILITY,
      parseCapability,
    ),
    collectionCapability: parseConfigJson(
      bindings.HANZI_COLLECTION_CAPABILITY,
      parseCollectionCapability,
    ),
    database: bindings.DB ?? null,
    clientIpHeader:
      bindings.HANZI_AUTH_IP_HEADER === 'x-forwarded-for'
        ? 'x-forwarded-for'
        : 'cf-connecting-ip',
  };
}

function parseConfigJson<T>(
  value: string | undefined,
  parse: (value: unknown) => T | null,
): T | null {
  try {
    return value ? parse(JSON.parse(value)) : null;
  } catch {
    return null;
  }
}
