import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  expect,
  request as requestFactory,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';

export type F1Account = {
  id: string;
  label: string;
  name: string;
  username: string;
  role: 'operator' | 'parent' | 'child' | 'teacher';
  password: string;
};

export type F1Handoff = {
  candidateId: string;
  baseURL: string;
  ordinaryBaseURL: string;
  controlURL: string;
  credentialsFile: string;
  profile: string;
  namespace: string;
  contentDigest: string;
  evidenceInstallationId: string;
  targetInstallationId: string;
  lessonVersion: string;
};

type PrivateCredentials = { token: string; accounts: F1Account[] };
type JsonObject = Record<string, unknown>;

export type F1Session = {
  request: APIRequestContext;
  origin: string;
  account: F1Account;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for onboarding F1 QA`);
  return value;
}

function safeHandoff(value: unknown): F1Handoff {
  if (!record(value)) throw new Error('F1 handoff is not an object');
  const required = [
    'candidateId',
    'baseURL',
    'ordinaryBaseURL',
    'controlURL',
    'credentialsFile',
    'profile',
    'namespace',
    'contentDigest',
    'evidenceInstallationId',
    'targetInstallationId',
    'lessonVersion',
  ];
  if (!required.every((key) => text(value[key])))
    throw new Error('F1 handoff is missing required candidate metadata');
  if (value.profile !== 'family-story')
    throw new Error('F1 QA requires the isolated family-story profile');
  if (!/^sha256:[a-f0-9]{64}$/.test(String(value.contentDigest)))
    throw new Error('F1 handoff content digest is invalid');
  if (value.evidenceInstallationId !== value.targetInstallationId)
    throw new Error('F1 family-story evidence must use one installation');
  for (const key of ['baseURL', 'ordinaryBaseURL', 'controlURL']) {
    const parsed = new URL(String(value[key]));
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1')
      throw new Error('F1 candidate endpoints must be owned loopback URLs');
  }
  return value as F1Handoff;
}

/** Read only the public candidate metadata. Private credentials are loaded separately. */
export function loadHandoff(): F1Handoff {
  const handoffPath = resolve(requiredEnv('HANZI_F1_HANDOFF'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(handoffPath, 'utf8'));
  } catch {
    throw new Error('F1 handoff could not be read');
  }
  return safeHandoff(parsed);
}

function loadCredentials(handoff: F1Handoff): PrivateCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(handoff.credentialsFile), 'utf8'));
  } catch {
    throw new Error('F1 private credentials file could not be read');
  }
  if (
    !record(parsed) ||
    !text(parsed.token) ||
    !Array.isArray(parsed.accounts) ||
    parsed.accounts.length < 5
  )
    throw new Error('F1 private credentials envelope is invalid');
  const accounts = parsed.accounts.map((value) => {
    if (
      !record(value) ||
      !text(value.id) ||
      !text(value.label) ||
      !text(value.name) ||
      !text(value.username) ||
      !text(value.password) ||
      !['operator', 'parent', 'child', 'teacher'].includes(String(value.role))
    )
      throw new Error('F1 private account entry is invalid');
    return value as unknown as F1Account;
  });
  return { token: parsed.token, accounts };
}

export function account(handoff: F1Handoff, label: string): F1Account {
  const found = loadCredentials(handoff).accounts.find(
    (candidate) => candidate.label === label,
  );
  if (!found) throw new Error(`F1 synthetic account ${label} is unavailable`);
  return found;
}

export function accountByRole(
  handoff: F1Handoff,
  role: F1Account['role'],
): F1Account {
  const found = loadCredentials(handoff).accounts.find(
    (candidate) => candidate.role === role,
  );
  if (!found) throw new Error(`F1 synthetic ${role} account is unavailable`);
  return found;
}

export async function signIn(
  handoff: F1Handoff,
  selected: F1Account,
  label: string = selected.role,
): Promise<F1Session> {
  const origin = new URL(handoff.baseURL).origin;
  const request = await requestFactory.newContext({
    baseURL: handoff.baseURL,
    extraHTTPHeaders: { Accept: 'application/json' },
  });
  const response = await request.post('/api/auth/sign-in/username', {
    data: { username: selected.username, password: selected.password },
    headers: { Origin: origin },
  });
  expect(response.status(), `${label} synthetic sign-in`).toBe(200);
  return { request, origin, account: selected };
}

export async function close(session: F1Session): Promise<void> {
  await session.request.dispose();
}

export async function getJson(
  session: F1Session,
  path: string,
): Promise<{ response: APIResponse; body: JsonObject }> {
  const response = await session.request.get(path, {
    headers: { Accept: 'application/json' },
  });
  const parsed: unknown = await response.json().catch(() => null);
  const body = record(parsed) ? parsed : {};
  return { response, body };
}

export async function sendJson(
  session: F1Session,
  method: 'POST' | 'PUT',
  path: string,
  data: unknown,
): Promise<{ response: APIResponse; body: JsonObject }> {
  const options = {
    data,
    headers: { Origin: session.origin, Accept: 'application/json' },
  };
  const response =
    method === 'POST'
      ? await session.request.post(path, options)
      : await session.request.put(path, options);
  const parsed: unknown = await response.json().catch(() => null);
  const body = record(parsed) ? parsed : {};
  return { response, body };
}

export function noStore(response: APIResponse): void {
  expect(response.headers()['cache-control']).toContain('no-store');
}

export async function control(
  handoff: F1Handoff,
  body: Record<string, unknown>,
): Promise<JsonObject> {
  const credentials = loadCredentials(handoff);
  const response = await fetch(`${handoff.controlURL}/inspect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hanzi-Test-Token': credentials.token,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('F1 private candidate inspection failed');
  const parsed: unknown = await response.json();
  if (!record(parsed)) throw new Error('F1 private candidate inspection was invalid');
  return parsed;
}

export async function resetSyntheticRun(
  handoff: F1Handoff,
  runId: string,
): Promise<void> {
  const credentials = loadCredentials(handoff);
  const response = await fetch(
    `${handoff.baseURL}/api/test/runs/${encodeURIComponent(runId)}`,
    {
      method: 'DELETE',
      headers: { 'X-Hanzi-Test-Token': credentials.token },
    },
  );
  if (!response.ok) throw new Error('F1 synthetic run cleanup failed');
}

export type SpeechBoundaryMode = 'started' | 'failed' | 'no-voice';

/**
 * Browser-only speech fixture. It records the real browser boundary and calls
 * `onstart` before `onend`; it never touches candidate data or computes a
 * learning result.
 */
export async function installSpeechBoundary(
  page: Page,
  mode: SpeechBoundaryMode = 'started',
): Promise<void> {
  await page.addInitScript((selectedMode: SpeechBoundaryMode) => {
    const calls: Array<{ text: string; lang: string }> = [];
    const voices =
      selectedMode === 'no-voice'
        ? []
        : [
            {
              lang: 'zh-CN',
              name: 'Synthetic Mandarin',
              localService: true,
              voiceURI: 'synthetic-zh',
            },
          ];
    class SyntheticUtterance {
      text: string;
      lang = '';
      voice: unknown = null;
      onstart: ((event: Event) => void) | null = null;
      onend: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(value = '') {
        this.text = value;
      }
    }
    const fakeSpeech = {
      speaking: false,
      paused: false,
      pending: false,
      getVoices: () => voices,
      cancel: () => {
        fakeSpeech.speaking = false;
      },
      pause: () => {
        fakeSpeech.paused = true;
      },
      resume: () => {
        fakeSpeech.paused = false;
      },
      speak: (utterance: SyntheticUtterance) => {
        calls.push({ text: utterance.text, lang: utterance.lang });
        if (selectedMode === 'no-voice') return;
        fakeSpeech.speaking = true;
        utterance.onstart?.(new Event('start'));
        queueMicrotask(() => {
          fakeSpeech.speaking = false;
          if (selectedMode === 'failed')
            utterance.onerror?.(new Event('error'));
          else utterance.onend?.(new Event('end'));
        });
      },
    };
    Object.defineProperty(window, '__f1SpeechCalls', {
      configurable: true,
      value: calls,
    });
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: fakeSpeech as unknown as SpeechSynthesis,
    });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: SyntheticUtterance,
    });
  }, mode);
}

export async function speechCalls(
  page: Page,
): Promise<Array<{ text: string; lang: string }>> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __f1SpeechCalls?: Array<{ text: string; lang: string }>;
        }
      ).__f1SpeechCalls ?? [],
  );
}
