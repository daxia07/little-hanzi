import type { PilotDatabase } from './db.ts';
import type {
  OpsJob,
  OpsJobCode,
  OpsJobKind,
  OpsAlertCode,
} from '../pilot-ops-types.ts';
export interface OpsContext {
  db: PilotDatabase;
  environment: string;
  installationId: string;
  opsInstallationId: string;
  buildId: string;
  now: () => number;
  testFault?: 'feedback-final-write' | 'alert-final-write';
}
export type OpsObjects =
  | {
      learning: { archiveId: string; objectId: string };
      operations: { archiveId: string; objectId: string };
    }
  | { subjectJobId: string }
  | { archiveIds: string[]; verifiedPointJobId: string }
  | Record<string, never>;
export interface AcquireJobInput {
  jobId: string;
  kind: OpsJobKind;
  utcSlot: string;
  attemptId: string;
  eventId: string;
  objects: OpsObjects;
  expectedRevision?: number;
}
export interface JobFence {
  jobId: string;
  attemptId: string;
  expectedRevision: number;
  eventId: string;
}
export interface JobAdmission {
  admission: 'dispatch' | 'busy' | 'reconcile' | 'terminal';
  job: OpsJob;
  lease: { attemptId: string; revision: number; leaseUntil: number } | null;
  objects: OpsObjects;
  attemptId: string;
  utcSlot: string;
}
export interface VerifiedArchiveMetadata {
  id: string;
  kind: 'learning' | 'operations';
  format:
    | 'pilot-admin-backup-4'
    | 'pilot-admin-backup-5'
    | 'pilot-admin-backup-6'
    | 'pilot-ops-backup-1'
    | 'pilot-ops-backup-2'
    | 'pilot-ops-backup-3';
  objectRef: string;
  keyId: string;
  plaintextDigest: string;
  ciphertextDigest: string;
  byteSize: number;
  dataAt: number;
  createdAt: number;
  verifiedAt: number;
  dailySlot: string;
  weeklySlot: string | null;
}
export type VerifiedJobResult =
  | {
      kind: 'backup';
      archives: [VerifiedArchiveMetadata, VerifiedArchiveMetadata];
    }
  | {
      kind: 'monitor';
      health: 'healthy' | 'unhealthy';
      checkedAt: number;
      code: OpsAlertCode | null;
    }
  | { kind: 'retention'; deletedArchiveIds: string[] }
  | {
      kind: 'reconcile';
      subjectJobId: string;
      outcome: 'confirmed' | 'not-committed' | 'unconfirmed';
    };
export interface UncertainJobInput extends JobFence {
  code: OpsJobCode;
}
export interface CompleteJobInput extends JobFence {
  result: VerifiedJobResult;
}
export interface FailedJobInput extends JobFence {
  code: OpsJobCode;
  settled: boolean;
}
export interface ReconcileJobInput extends JobFence {
  observation:
    | { outcome: 'unconfirmed' }
    | { outcome: 'not-committed'; settled: true }
    | { outcome: 'confirmed'; result: VerifiedJobResult };
}
export interface OpsArchiveMetadata extends VerifiedArchiveMetadata {
  jobId: string;
  attemptId: string;
  environment: string;
  installationId: string;
  opsInstallationId: string;
  buildId: string;
  deleted: boolean;
}

export interface OpsNotificationInput {
  alertId: string;
  eventId: string;
  outcome: 'delivered' | 'failed';
}
