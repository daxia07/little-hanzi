import type {
  ForestActionResponse,
  ForestActionType,
  ForestPendingAction,
  ForestRun,
} from '@/lib/forest-client';

/**
 * The lesson UI only needs these three operations.  Preview and authenticated
 * pilot transports implement the same boundary, so the lesson cannot fall
 * back to a different API when it is embedded in the pilot.
 */
export interface ForestLessonTransport {
  createRun: () => Promise<ForestRun>;
  getRun: (runId: string) => Promise<ForestRun>;
  sendAction: (
    runId: string,
    expectedRevision: number,
    stepId: string,
    type: ForestActionType,
    payload: Record<string, unknown>,
    eventId: string,
  ) => Promise<ForestActionResponse>;
  ensureSession?: () => Promise<void>;
  sendFeedback?: (
    runId: string,
    value: {
      feedbackId: string;
      stepId: string | null;
      category:
        | 'clarity'
        | 'pacing'
        | 'difficulty'
        | 'mascot'
        | 'reporting'
        | 'other';
      text: string;
      source?: 'reviewer' | 'child';
    },
  ) => Promise<unknown>;
}

export interface ForestRecoveryScope {
  runId: string;
  lessonVersion: string;
}

export interface ForestRecoveryStore {
  available: () => boolean;
  read: (scope: ForestRecoveryScope) => ForestPendingAction[];
  write: (
    scope: ForestRecoveryScope,
    actions: ForestPendingAction[],
  ) => boolean;
  clear: (scope: ForestRecoveryScope) => boolean;
}
