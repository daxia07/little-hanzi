/** Browser-safe R6 entry1 contracts. No runtime, policy, package or grading imports. */
import type {
  CorpusBatchResponse,
  CorpusReceipt,
  CorpusPublicationReceipt,
  CorpusScope,
} from './corpus-types.ts';
export interface CorpusEntryTarget {
  characterId: string;
  hanzi: string;
}
export interface CorpusFamilyEntryResponse {
  schemaVersion: 'r6-family-corpora-1';
  childId: string;
  installationId: string;
  items: Array<{
    corpusId: string;
    corpusVersion: string;
    corpusDigest: string;
    title: string;
    targets: CorpusEntryTarget[];
    available: boolean;
    reasonCode: null | string;
  }>;
  nextCursor: null | string;
}
export interface CorpusOwnerEntryResponse {
  schemaVersion: 'r6-owner-entry-1';
  installationId: string;
  allowed: boolean;
  items: Array<{
    corpusId: string;
    corpusVersion: string;
    corpusDigest: string;
    snapshotId: string;
    planDigest: string;
    candidateId: string;
    buildId: string;
    createdAt: string;
  }>;
  nextCursor: null | string;
}
export interface CorpusBatchValidationResponse {
  schemaVersion: 'r6-batch-validation-1';
  batchId: string;
  batchVersion: string;
  manifestDigest: string;
  checkedAt: string;
  items: CorpusBatchResponse['items'];
}
export interface CorpusSnapshotPackagesResponse {
  schemaVersion: 'r6-snapshot-packages-1';
  snapshotId: string;
  items: Array<{
    lessonVersion: string;
    contentDigest: string;
    title: string;
    targets: CorpusEntryTarget[];
    chunked: boolean;
  }>;
  nextCursor: null | string;
}
export interface CorpusSafeDecision {
  receipt: CorpusReceipt;
  snapshotId: string;
  scope: CorpusScope;
  decision: 'accepted' | 'rejected';
}
export interface CorpusOwnerDecisionsResponse {
  schemaVersion: 'r6-owner-decisions-1';
  snapshotId: string;
  items: CorpusSafeDecision[];
  nextCursor: null | string;
}
export interface CorpusSafePublication {
  receipt: CorpusPublicationReceipt;
  snapshotId: string;
  ownerDecisionId: null | string;
  scope:
    | CorpusScope
    | {
        kind: 'verification';
        members: Array<{ parentId: string; childId: string }>;
      };
  status: 'released' | 'withdrawn';
  predecessorPublicationId: null | string;
}
export interface CorpusPublicationHeadResponse {
  publication: null | CorpusSafePublication;
}
