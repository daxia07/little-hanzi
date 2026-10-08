import { curriculumDigest } from '../curriculum/digest.ts';
export type OperationKind = 'owner' | 'publication' | 'start' | 'action';
export function operationRequest(
  kind: OperationKind,
  actorId: string,
  installationId: string,
  resourceId: string,
  request: unknown,
) {
  return {
    schemaVersion: `r3-${kind}-request-1`,
    actorId,
    installationId,
    resourceId,
    request,
  };
}
export async function operationDigest(
  kind: OperationKind,
  actorId: string,
  installationId: string,
  resourceId: string,
  request: unknown,
) {
  return curriculumDigest(
    operationRequest(kind, actorId, installationId, resourceId, request),
  );
}
export interface PlacementSource {
  schemaVersion: 'r3-placement-source-1';
  childId: string;
  installationId: string;
  policyVersion: 'r3-placement-1';
  onboardingDigest: string;
  evidenceDigest: string;
  publicationId: string;
  lessonVersion: 'forest-01-v4';
  contentDigest: string;
  reason: string;
  createdAt: number;
}
export function placementSource(
  input: Omit<
    PlacementSource,
    'schemaVersion' | 'policyVersion' | 'lessonVersion'
  >,
): PlacementSource {
  return {
    schemaVersion: 'r3-placement-source-1',
    policyVersion: 'r3-placement-1',
    lessonVersion: 'forest-01-v4',
    ...input,
  };
}
export function publicationAck(
  publicationId: string,
  generation: number,
  status: string,
) {
  return { publicationId, generation, revision: generation, status };
}
export function startAck(runId: string, assignmentId: string) {
  return {
    runId,
    assignmentId,
    lessonVersion: 'forest-01-v4' as const,
    revision: 0,
  };
}
