import { inspectJson } from './json.ts';

export function canonicalPackage(input: unknown): string {
  const { value, errors: issues } = inspectJson(input);
  if (issues.length) {
    throw new TypeError(
      issues.some((issue) => issue.code === 'CYCLIC_VALUE')
        ? 'Cannot serialize cyclic JSON data'
        : 'Unsupported non-JSON or non-canonical data',
    );
  }
  function encode(value: unknown): string {
    if (value === null || typeof value !== 'object')
      return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(object[key])}`)
      .join(',')}}`;
  }
  return encode(value);
}

export async function curriculumDigest(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalPackage(input));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
