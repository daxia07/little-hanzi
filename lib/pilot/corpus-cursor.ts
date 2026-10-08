/** Encrypted cursor primitive. Successful decryption is never session authorization. */
import { canonicalPackage } from '../curriculum/digest.ts';
import { exact } from '../curriculum/story-package.ts';
import { fail } from './story-policy.ts';
import { safeCorpusJson } from './corpus-policy.ts';
export interface CorpusCursorBinding {
  kind:
    | 'catalog'
    | 'coverage'
    | 'snapshot-members'
    | 'owner-review'
    | 'corpora-list'
    | 'family-corpora'
    | 'owner-entry'
    | 'snapshot-packages'
    | 'owner-decisions';
  actorId: string;
  sessionId: string;
  authRevision: string;
  installationId: string;
  resourceId: string;
  corpusVersion: string;
  corpusDigest: string;
  buildId: string;
  releaseRevision: number;
  evidenceEpoch: number;
  q: string;
  limit: number;
}
export interface CorpusCursorPayload extends CorpusCursorBinding {
  version: 'c1';
  last: string[];
  expiresAt: number;
}
function bytes64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}
async function key(secret: string, installationId: string): Promise<CryptoKey> {
  if (!secret || !installationId) fail('CURSOR_INVALID', 400);
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(installationId),
      info: new TextEncoder().encode('little-hanzi/r6-cursor/v1'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
const aad = (kind: CorpusCursorBinding['kind']) =>
  new TextEncoder().encode(canonicalPackage({ kind, version: 'c1' }));
export async function issueCorpusCursor(
  secret: string,
  binding: CorpusCursorBinding,
  last: string[],
  now: number,
): Promise<string> {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(now + 600000) ||
    !Number.isInteger(binding.limit) ||
    binding.limit < 1 ||
    binding.limit > 50 ||
    last.length > 8 ||
    !last.every((s) => typeof s === 'string' && s.length <= 240)
  )
    fail('CURSOR_INVALID', 400);
  const payload = { ...binding, version: 'c1', last, expiresAt: now + 600000 };
  const plain = new TextEncoder().encode(canonicalPackage(payload));
  if (plain.length > 2048) fail('CURSOR_INVALID', 400);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: aad(binding.kind),
        tagLength: 128,
      },
      await key(secret, binding.installationId),
      plain,
    ),
  );
  const result = new Uint8Array(12 + encrypted.length);
  result.set(nonce);
  result.set(encrypted, 12);
  return 'c1.' + bytes64(result);
}
export async function readCorpusCursor(
  secret: string,
  wire: unknown,
  expected: CorpusCursorBinding,
  now: number,
): Promise<CorpusCursorPayload> {
  if (!Number.isSafeInteger(now) || now < 0) fail('CURSOR_INVALID', 400);
  if (
    typeof wire !== 'string' ||
    wire.length > 4096 ||
    !/^c1\.[A-Za-z0-9_-]+$/u.test(wire)
  )
    fail('CURSOR_INVALID', 400);
  let v: unknown;
  try {
    const raw = wire.slice(3),
      bytes = Uint8Array.from(
        atob(raw.replaceAll('-', '+').replaceAll('_', '/')),
        (c) => c.charCodeAt(0),
      );
    if (bytes.length < 28 || bytes64(bytes) !== raw)
      fail('CURSOR_INVALID', 400);
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes.slice(0, 12),
        additionalData: aad(expected.kind),
        tagLength: 128,
      },
      await key(secret, expected.installationId),
      bytes.slice(12),
    );
    if (plain.byteLength > 2048) fail('CURSOR_INVALID', 400);
    const json = new TextDecoder('utf-8', { fatal: true }).decode(plain);
    v = safeCorpusJson(JSON.parse(json), 2048);
    if (canonicalPackage(v) !== json) fail('CURSOR_INVALID', 400);
  } catch {
    fail('CURSOR_INVALID', 400);
  }
  if (
    !exact(v, [...Object.keys(expected), 'version', 'last', 'expiresAt']) ||
    v.version !== 'c1' ||
    !Array.isArray(v.last) ||
    v.last.length > 8 ||
    !v.last.every((s) => typeof s === 'string' && s.length <= 240) ||
    !Number.isSafeInteger(v.expiresAt)
  )
    fail('CURSOR_INVALID', 400);
  for (const k of [
    'actorId',
    'sessionId',
    'installationId',
    'resourceId',
    'corpusVersion',
  ])
    if (v[k] !== expected[k as keyof CorpusCursorBinding])
      fail('CURSOR_FOREIGN', 404);
  for (const k of Object.keys(expected))
    if (v[k] !== expected[k as keyof CorpusCursorBinding]) fail('CURSOR_STALE');
  if (Number(v.expiresAt) <= now || Number(v.expiresAt) > now + 600000)
    fail('CURSOR_STALE');
  return v as unknown as CorpusCursorPayload;
}
