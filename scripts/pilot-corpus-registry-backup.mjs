/** Historical R6 registry facts. No current authority or restore side effects. */
import crypto from 'node:crypto';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
import { compileCorpusRuntime } from '../lib/curriculum/corpus-runtime.ts';
import { text } from '../lib/curriculum/story-package.ts';
import {
  corpusId,
  inspectSourceRequest,
  assertSourceSuccessor,
  inspectCorpusManifest,
  normalizeCoverageIdentity,
  corpusIndexTokens,
} from '../lib/pilot/corpus-policy.ts';
import { inspectCorpusBatch } from '../lib/pilot/corpus-store.ts';

const json = canonicalPackage;
const digest = (v) =>
  'sha256:' + crypto.createHash('sha256').update(json(v)).digest('hex');
const same = (a, b) => json(a) === json(b);
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const key = (...parts) => json(parts);
const exact = (v, fields) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  same(Object.keys(v).sort(order), [...fields].sort(order));
function check(value) {
  if (!value) throw new Error('BACKUP_CORPUS_INVALID');
}
function parsed(value) {
  const v = JSON.parse(value);
  check(json(v) === value);
  return v;
}
function keyed(rows, identify) {
  const map = new Map();
  for (const row of rows) {
    const id = identify(row);
    check(!map.has(id));
    map.set(id, row);
  }
  return map;
}
function originalRequest(row, operation) {
  const v = parsed(row.request_json);
  check(
    exact(v, [
      'schemaVersion',
      'actorId',
      'installationId',
      'resourceId',
      'request',
    ]) &&
      v.schemaVersion === `r6-${operation}-request-1` &&
      v.actorId === row.actor_id &&
      v.installationId === row.installation_id &&
      corpusId(v.resourceId) &&
      v.request?.requestId === row.request_id &&
      digest(v) === row.request_digest,
  );
  return v;
}
function originalReceipt(row) {
  check(
    same(parsed(row.ack_json), {
      requestId: row.request_id,
      recordId: row.id,
      recordedAt: new Date(row.created_at).toISOString(),
    }),
  );
}

/** Called only after safe V6 shape and exhaustive shared registry validation. */
export async function validateCorpusRegistryFacts(payload) {
  const t = payload.tables;
  const users = keyed(t.pilot_auth_user, (r) => r.id);
  const packages = keyed(t.pilot_curriculum_package, (r) => r.lesson_version);
  const documents = new Map();
  const compiled = new Map();
  async function pkg(version, expectedDigest) {
    const row = packages.get(version);
    check(row?.content_digest === expectedDigest);
    if (!compiled.has(version)) {
      const document = parsed(row.manifest_json);
      const lesson = await compileCorpusRuntime(document);
      check(
        lesson.identity.lessonVersion === version &&
          lesson.identity.contentDigest === expectedDigest,
      );
      documents.set(version, document);
      compiled.set(version, lesson);
    }
    return { row, document: documents.get(version) };
  }
  const sources = keyed(t.pilot_corpus_source_evidence, (r) => r.id);
  const sourceRequests = new Set(),
    sourceDigests = new Set(),
    predecessorIds = new Set(),
    roots = new Set();
  const lineages = new Map();
  for (const row of sources.values()) {
    check(
      corpusId(row.id) &&
        corpusId(row.lineage_id) &&
        corpusId(row.actor_id) &&
        users.has(row.actor_id) &&
        text(row.installation_id, 240),
    );
    const list = lineages.get(row.lineage_id) ?? [];
    list.push(row);
    lineages.set(row.lineage_id, list);
  }
  for (const [lineage, unsorted] of lineages) {
    const chain = [...unsorted].sort(
      (a, b) => a.source_ordinal - b.source_ordinal,
    );
    let previous = null;
    for (const [index, row] of chain.entries()) {
      check(
        row.source_ordinal === index + 1 &&
          row.lineage_id === lineage &&
          (index
            ? row.supersedes_id === previous.id
            : row.supersedes_id === null && row.id === lineage),
      );
      const { row: packageRow, document } = await pkg(
        row.lesson_version,
        row.content_digest,
      );
      const envelope = originalRequest(row, 'source-evidence');
      const scope = key(
        row.actor_id,
        row.installation_id,
        envelope.resourceId,
        row.request_id,
      );
      check(!sourceRequests.has(scope));
      sourceRequests.add(scope);
      const usableReviews = t.pilot_curriculum_review
        .filter(
          (r) =>
            r.lesson_version === row.lesson_version &&
            r.content_digest === row.content_digest &&
            r.decision === 'approved' &&
            r.recorded_at <= row.created_at,
        )
        .map((r) => r.review_id);
      const request = inspectSourceRequest(
        envelope.request,
        document.characters.map((c) => ({
          characterId: c.characterId,
          hanzi: c.hanzi,
        })),
        usableReviews,
      );
      check(
        request.lessonVersion === row.lesson_version &&
          request.contentDigest === row.content_digest,
      );
      const attribution = parsed(row.attribution_json);
      check(
        exact(attribution, [
          'schemaVersion',
          'actorId',
          'installationId',
          'fixtureOrigin',
        ]) &&
          attribution.schemaVersion === 'r6-source-attribution-1' &&
          attribution.actorId === row.actor_id &&
          attribution.installationId === row.installation_id &&
          typeof attribution.fixtureOrigin === 'boolean',
      );
      const next = assertSourceSuccessor(
        request,
        previous
          ? {
              id: previous.id,
              lineageId: previous.lineage_id,
              ordinal: previous.source_ordinal,
              digest: previous.evidence_digest,
              classification: previous.classification,
              lessonVersion: previous.lesson_version,
              contentDigest: previous.content_digest,
            }
          : null,
        packageRow.test_run_id !== null || attribution.fixtureOrigin,
      );
      check(
        row.classification === next.classification &&
          next.ordinal === row.source_ordinal &&
          (next.lineageId ?? row.id) === lineage &&
          attribution.fixtureOrigin ===
            (row.classification === 'verification-fixture'),
      );
      const evidence = {
        schemaVersion: 'r6-source-evidence-1',
        lessonVersion: row.lesson_version,
        contentDigest: row.content_digest,
        classification: row.classification,
        lineageId: lineage,
        sourceOrdinal: row.source_ordinal,
        predecessorEvidenceId: row.supersedes_id,
        sourceRefs: request.sourceRefs,
        licenseRefs: request.licenseRefs,
        reviewRefs: request.reviewRefs,
        identityReviews: request.identityReviews,
      };
      check(
        same(parsed(row.evidence_json), evidence) &&
          digest(evidence) === row.evidence_digest &&
          digest({
            schemaVersion: 'r6-source-refs-1',
            sourceRefs: request.sourceRefs,
            licenseRefs: request.licenseRefs,
          }) === row.source_digest,
      );
      const identity = key(
        row.lesson_version,
        row.content_digest,
        row.evidence_digest,
      );
      check(!sourceDigests.has(identity));
      sourceDigests.add(identity);
      if (previous) {
        check(!predecessorIds.has(previous.id));
        predecessorIds.add(previous.id);
      } else {
        const rootKey = key(row.lesson_version, row.installation_id);
        check(!roots.has(rootKey));
        roots.add(rootKey);
      }
      originalReceipt(row);
      previous = row;
    }
  }
  const batches = keyed(t.pilot_corpus_batch, (r) => r.id),
    batchVersions = new Set(),
    batchRequests = new Set();
  for (const row of batches.values()) {
    check(users.has(row.actor_id) && text(row.installation_id, 240));
    const b = inspectCorpusBatch(parsed(row.manifest_json));
    check(
      b.batchId === row.id &&
        b.batchVersion === row.batch_version &&
        digest(b) === row.manifest_digest &&
        !batchVersions.has(row.batch_version),
    );
    batchVersions.add(row.batch_version);
    const envelope = originalRequest(row, 'batch');
    check(
      exact(envelope.request, ['requestId', 'batch']) &&
        same(envelope.request.batch, b),
    );
    const scope = key(
      row.actor_id,
      row.installation_id,
      envelope.resourceId,
      row.request_id,
    );
    check(!batchRequests.has(scope));
    batchRequests.add(scope);
    for (const item of b.items) {
      const { document } = await pkg(item.lessonVersion, item.contentDigest);
      check(
        same(
          item.characters,
          document.characters.map((c) => ({
            characterId: c.characterId,
            coverageIdentity: c.hanzi,
          })),
        ) &&
          same(document.placement, {
            trackId: item.trackId,
            sequence: item.sequence,
          }),
      );
    }
    check(
      same(parsed(row.result_json), {
        schemaVersion: 'r6-batch-1',
        batchId: b.batchId,
        batchVersion: b.batchVersion,
        manifestDigest: row.manifest_digest,
        recordedAt: new Date(row.created_at).toISOString(),
        items: b.items.map((i) => ({
          lessonVersion: i.lessonVersion,
          contentDigest: i.contentDigest,
          state: 'accepted',
          errors: [],
        })),
      }),
    );
    originalReceipt(row);
  }
  const corpora = keyed(t.pilot_corpus, (r) => r.corpus_version);
  const corpusDigests = new Set();
  const items = keyed(t.pilot_corpus_item, (r) =>
    key(r.corpus_version, r.ordinal),
  );
  const chars = keyed(t.pilot_corpus_character, (r) =>
    key(r.corpus_version, r.lesson_version, r.target_index),
  );
  const terms = keyed(t.pilot_corpus_search_term, (r) =>
    key(r.corpus_version, r.lesson_version, r.term, r.kind),
  );
  const consumedItems = new Set(),
    consumedCharacters = new Set(),
    consumedTerms = new Set();
  for (const row of corpora.values()) {
    const manifest = inspectCorpusManifest(parsed(row.manifest_json));
    check(
      manifest.corpusVersion === row.corpus_version &&
        manifest.corpusId === row.corpus_id &&
        manifest.policyVersion === row.policy_version &&
        digest(manifest) === row.corpus_digest &&
        !corpusDigests.has(row.corpus_digest) &&
        users.has(row.imported_by),
    );
    corpusDigests.add(row.corpus_digest);
    for (const [ordinal, expected] of manifest.items.entries()) {
      const itemKey = key(row.corpus_version, ordinal),
        item = items.get(itemKey);
      check(
        item &&
          item.lesson_version === expected.lessonVersion &&
          item.content_digest === expected.contentDigest &&
          item.batch_id === expected.batchId &&
          item.track_id === expected.trackId &&
          item.sequence === expected.sequence &&
          item.adapter_id === 'corpus-paired' &&
          item.adapter_version === 'corpus-paired-v1',
      );
      consumedItems.add(itemKey);
      const batch = batches.get(item.batch_id);
      check(
        batch &&
          parsed(batch.manifest_json).items.some(
            (i) =>
              i.lessonVersion === item.lesson_version &&
              i.contentDigest === item.content_digest &&
              i.trackId === item.track_id &&
              i.sequence === item.sequence,
          ),
      );
      const { document } = await pkg(item.lesson_version, item.content_digest);
      const display = {
        title: document.title,
        targets: document.characters.map((c) => ({
          characterId: c.characterId,
          hanzi: c.hanzi,
        })),
        words: document.characters
          .flatMap((c) =>
            c.wordAssociations.map((w) => ({
              text: w.text,
              english: w.english,
            })),
          )
          .slice(0, 4),
      };
      check(
        item.title === document.title &&
          same(parsed(item.display_json), display) &&
          digest(display) === item.search_digest,
      );
      for (const [targetIndex, target] of document.characters.entries()) {
        const targetKey = key(
            row.corpus_version,
            item.lesson_version,
            targetIndex,
          ),
          member = chars.get(targetKey);
        check(
          member &&
            member.character_id === target.characterId &&
            member.coverage_identity ===
              normalizeCoverageIdentity(target.hanzi) &&
            member.content_digest === item.content_digest &&
            member.identity_version === 'r6-coverage-identity-1',
        );
        const root = sources.get(member.source_evidence_id);
        check(
          root &&
            root.source_ordinal === 1 &&
            root.lesson_version === item.lesson_version &&
            root.content_digest === item.content_digest,
        );
        const requirements = {
          schemaVersion: 'r6-target-requirements-1',
          characterId: target.characterId,
          readingIds: target.readings.map((r) => r.readingId),
          wordIds: target.wordAssociations.map((w) => w.wordId),
          assets: target.assets,
        };
        check(
          same(parsed(member.requirements_json), requirements) &&
            digest(requirements) === member.requirements_digest,
        );
        consumedCharacters.add(targetKey);
      }
      const expectedTerms = new Map();
      for (const [kind, text] of [
        ['title-english', document.title],
        ...display.targets.map((c) => ['hanzi', c.hanzi]),
        ...display.words.flatMap((w) => [
          ['word-hanzi', w.text],
          ['word-english', w.english],
        ]),
      ])
        for (const term of corpusIndexTokens(
          text,
          kind === 'title-english' ? 120 : 240,
        ))
          expectedTerms.set(
            key(row.corpus_version, item.lesson_version, term, kind),
            { term, kind },
          );
      for (const termKey of expectedTerms.keys()) {
        const term = terms.get(termKey);
        check(term?.content_digest === item.content_digest);
        consumedTerms.add(termKey);
      }
    }
  }
  check(
    consumedItems.size === items.size &&
      consumedCharacters.size === chars.size &&
      consumedTerms.size === terms.size,
  );
  return { corpora, sources, batches, packages, documents };
}
