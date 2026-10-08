/** Import-free browser wire. No server, scoring, archive or content imports. */
export type OpsCategory = 'confusion' | 'sound' | 'saving' | 'access' | 'other';
export type OpsSeverity = 'blocking' | 'high' | 'normal' | 'low';
export type OpsRecordStatus =
  | 'open'
  | 'in-progress'
  | 'awaiting-review'
  | 'resolved'
  | 'expired';
export type OpsAlertCode =
  | 'OPS_BACKUP_FAILED'
  | 'OPS_PROBE_FAILED'
  | 'OPS_BACKUP_STALE'
  | 'OPS_MONITOR_UNKNOWN'
  | 'OPS_NOTIFICATION_FAILED'
  | 'OPS_RETENTION_FAILED';
export type OpsJobCode =
  | OpsAlertCode
  | 'OPS_JOB_FAILED'
  | 'OPS_EFFECT_UNCONFIRMED';
export type OpsJobKind = 'backup' | 'monitor' | 'retention' | 'reconcile';
export interface OpsEnvelope {
  schemaVersion: 'r4-ops-view-1';
  installationId: string;
  opsInstallationId: string | null;
  buildId: string;
  serverAt: number;
}
export interface OpsReceipt {
  requestId: string;
  recordId: string;
  revision: number;
  recordedAt: number;
}
export type OpsMutation = OpsReceipt;
export interface OpsObservation {
  kind: 'actual' | 'synthetic';
  participantLabel: string;
  candidateId: string;
  lessonVersion: string;
  contentDigest: string;
  observedAt: number;
  device: string;
  browser: string;
  parentAgreementRef: string;
  tasks: string[];
  completion: 'not-started' | 'partial' | 'ended';
  savedRecapRef: string | null;
  adultHelp: string;
  interruptions: string;
  observedBehavior: string;
  observerInterpretation: string;
  laterRecall:
    | { status: 'not-run' }
    | {
        status: 'observed';
        observedAt: number;
        evidenceRef: string;
        adultHelp: string;
        observation: string;
      };
}
export interface OpsJob {
  id: string;
  kind: OpsJobKind;
  revision: number;
  status: 'running' | 'uncertain' | 'succeeded' | 'failed';
  startedAt: number;
  endedAt: number | null;
  errorCode: OpsJobCode | null;
  acknowledgedOperationId: string;
  buildId: string;
  historical: boolean;
  archives: Array<{
    id: string;
    kind: 'learning' | 'operations';
    plaintextDigest: string;
    ciphertextDigest: string;
    byteSize: number;
    keyId: string;
    verifiedAt: number;
  }>;
}
export interface OpsAlert {
  id: string;
  revision: number;
  code: OpsAlertCode;
  status: 'open' | 'acknowledged' | 'resolved';
  createdAt: number;
  updatedAt: number;
  jobId: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: number | null;
  notification: 'unconfigured' | 'delivered' | 'failed';
  historical: boolean;
}
export interface OpsSummary {
  id: string;
  kind: 'feedback' | 'observation';
  revision: number;
  createdAt: number;
  updatedAt: number;
  candidateId: string;
  lessonId: string;
  lessonVersion: string;
  contentDigest: string;
  buildId: string;
  submissionBuildId: string;
  category: OpsCategory | null;
  severity: OpsSeverity;
  ownerRef: string | null;
  status: OpsRecordStatus;
  nextReviewAt: number | null;
  detailsRemoved: boolean;
  historical: boolean;
  readOnly: boolean;
}
export interface OpsHistory {
  id: string;
  sequence: number;
  kind: 'submitted' | 'triaged' | 'corrected' | 'redacted';
  recordedAt: number;
  actorUserId: string | null;
  receipt: OpsReceipt;
  public: {
    status: OpsRecordStatus;
    severity: OpsSeverity;
    nextReviewAt: number | null;
    acIds: string[];
    observationKind: 'actual' | 'synthetic' | null;
    observedAt: number | null;
    completion: OpsObservation['completion'] | null;
    laterRecallStatus: 'not-run' | 'observed' | null;
  };
  private: {
    ownerRef: string | null;
    disposition: string;
    retestRef: string | null;
    correctionReason: string | null;
    observation: OpsObservation | null;
  } | null;
  detailsRemoved: boolean;
}
export interface OpsDetail extends OpsSummary {
  childId: string | null;
  runId: string | null;
  runInstallationId: string | null;
  sourceRole: 'parent' | 'operator';
  observationKind: 'actual' | 'synthetic' | null;
  details:
    | { observed: string; expected: string }
    | { observation: OpsObservation }
    | null;
  history: OpsHistory[];
  historyRevision: number;
  nextCursor: string | null;
}
export interface OpsTargets {
  dailyAtUtc: '02:00';
  dailyPoints: 7;
  weeklyPoints: 4;
  freshnessMs: 93600000;
  feedbackRetentionMs: 2592000000;
}
export interface OpsStatus {
  monitorState: 'healthy' | 'unhealthy' | 'unknown';
  targets: OpsTargets;
  lastVerifiedBackupAt: number | null;
  lastBackupDataAt: number | null;
  backupAgeMs: number | null;
  lastMonitorAt: number | null;
  notification: 'unconfigured' | 'delivered' | 'failed';
  jobs: OpsJob[];
  alerts: OpsAlert[];
}
export type OpsStatusResponse = OpsEnvelope & { status: OpsStatus };
export type OpsJobResponse = OpsEnvelope & { job: OpsJob };
export type OpsQueueResponse = OpsEnvelope & {
  items: OpsSummary[];
  queueRevision: number;
  nextCursor: string | null;
};
export type OpsDetailResponse = OpsEnvelope & { record: OpsDetail };
export type OpsHistoryResponse = OpsEnvelope & {
  items: OpsHistory[];
  recordId: string;
  recordRevision: number;
  nextCursor: string | null;
};
export type OpsErrorResponse = Partial<OpsEnvelope> & {
  error: { code: string; message: string };
  currentRevision?: number;
  refreshRequired?: true;
  status?: { monitorState: 'unknown' };
};
export interface OpsFeedbackInput {
  requestId: string;
  runId: string;
  category: OpsCategory;
  observed: string;
  expected: string;
}
export interface OpsTriageInput {
  requestId: string;
  expectedRevision: number;
  severity: OpsSeverity;
  ownerRef: string | null;
  status: Exclude<OpsRecordStatus, 'expired'>;
  acIds: string[];
  disposition: string;
  retestRef: string | null;
  nextReviewAt: number | null;
}
export interface OpsObservationInput {
  requestId: string;
  observation: OpsObservation;
}
export interface OpsCorrectionInput extends OpsObservationInput {
  expectedRevision: number;
  correctionReason: string;
}
export interface OpsAckInput {
  requestId: string;
  expectedRevision: number;
}
export interface OpsQueueOptions {
  status?: 'active' | 'all' | OpsRecordStatus;
  kind?: 'all' | 'feedback' | 'observation';
  cursor?: string;
  limit?: number;
}
export interface OpsHistoryOptions {
  cursor?: string;
  limit?: number;
}
