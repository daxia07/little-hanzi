/** Lazy R6-only configuration. Malformed optional bindings do not affect ordinary learning. */
import {
  corpusId,
  parseCorpusCapability,
  safeCorpusJson,
} from './corpus-policy.ts';
import { exact, text } from '../curriculum/story-package.ts';
import { fail } from './story-policy.ts';
import type { CorpusContext } from './corpus-db.ts';
export function parseCorpusBindings(
  bindings: Record<string, unknown>,
): CorpusContext['corpus'] {
  const owners = bindings.HANZI_CORPUS_OWNER_IDS;
  let ownerIds: string[] = [];
  if (owners !== undefined && owners !== null && owners !== '') {
    let v: unknown;
    try {
      v = safeCorpusJson(
        typeof owners === 'string' ? JSON.parse(owners) : owners,
      );
    } catch {
      fail('STORAGE_UNAVAILABLE', 503);
    }
    if (
      !Array.isArray(v) ||
      v.length > 20 ||
      !v.every(corpusId) ||
      new Set(v).size !== v.length
    )
      fail('STORAGE_UNAVAILABLE', 503);
    ownerIds = v;
  }
  let fixtureBinding: CorpusContext['corpus']['fixtureBinding'] = null;
  const fixture = bindings.HANZI_CORPUS_FIXTURE_BINDING;
  if (fixture !== undefined && fixture !== null && fixture !== '') {
    let v: unknown;
    try {
      v = safeCorpusJson(
        typeof fixture === 'string' ? JSON.parse(fixture) : fixture,
      );
    } catch {
      fail('STORAGE_UNAVAILABLE', 503);
    }
    if (
      !exact(v, ['schemaVersion', 'installationId', 'mode']) ||
      v.schemaVersion !== 'r6-fixture-binding-1' ||
      !text(v.installationId, 240) ||
      !String(v.installationId).isWellFormed() ||
      v.mode !== 'synthetic-only'
    )
      fail('STORAGE_UNAVAILABLE', 503);
    fixtureBinding = v as NonNullable<typeof fixtureBinding>;
  }
  const raw = bindings.HANZI_CORPUS_CAPABILITY,
    capability = parseCorpusCapability(raw);
  if (raw !== undefined && raw !== null && raw !== '' && !capability)
    fail('STORAGE_UNAVAILABLE', 503);
  return { ownerIds, fixtureBinding, capability };
}
