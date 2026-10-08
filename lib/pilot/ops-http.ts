import { bodyJson, json, requirePilotSession, requireOrigin } from './http.ts';
import { opsContext } from './ops-runtime.ts';
import { OpsError, fail, slug, parseFeedback } from './ops-domain.ts';
import * as store from './ops-store.ts';
import type { OpsQueueOptions } from '../pilot-ops-types.ts';
export type OpsOperation =
  | 'status'
  | 'job'
  | 'ack'
  | 'queue'
  | 'detail'
  | 'history'
  | 'triage'
  | 'observation'
  | 'correction'
  | 'feedback';
export async function opsRoute(
  request: Request,
  operation: OpsOperation,
  id = '',
): Promise<Response> {
  const session = await requirePilotSession(request);
  if (session instanceof Response) return session;
  if (session.user.role !== (operation === 'feedback' ? 'parent' : 'operator'))
    return json(
      { error: { code: 'FORBIDDEN', message: 'access is not permitted' } },
      403,
    );
  if (request.method !== 'GET') {
    const denied = requireOrigin(request, session.config);
    if (denied) return denied;
  }
  let c: Awaited<ReturnType<typeof opsContext>> | undefined;
  try {
    const input =
      request.method === 'GET' ? null : await bodyJson(request, 64000);
    c = await opsContext(session);
    const envelope = {
      schemaVersion: 'r4-ops-view-1',
      installationId: c.installationId,
      opsInstallationId: c.opsInstallationId,
      buildId: c.buildId,
      serverAt: c.now(),
    };
    const actor = { id: session.user.id, role: session.user.role };
    let result: unknown;
    if (
      [
        'job',
        'ack',
        'detail',
        'history',
        'triage',
        'correction',
        'feedback',
      ].includes(operation) &&
      !slug(id)
    )
      fail('INVALID_REQUEST', 400);
    const url = new URL(request.url),
      search = url.searchParams;
    if (operation === 'queue' || operation === 'history') {
      const allowed =
        operation === 'queue'
          ? ['limit', 'cursor', 'status', 'kind']
          : ['limit', 'cursor'];
      if (
        [...search.keys()].some((k) => !allowed.includes(k)) ||
        allowed.some((k) => search.getAll(k).length > 1)
      )
        fail('INVALID_REQUEST', 400);
    }
    switch (operation) {
      case 'status':
        result = { ...envelope, status: await store.readOpsStatus(c) };
        break;
      case 'job':
        result = { ...envelope, job: await store.readOpsJob(c, id) };
        break;
      case 'ack':
        result = await store.acknowledgeAlert(c, actor, id, input);
        break;
      case 'queue': {
        const opts: OpsQueueOptions = {};
        if (search.has('limit')) opts.limit = Number(search.get('limit'));
        if (search.has('cursor')) opts.cursor = search.get('cursor')!;
        if (search.has('status'))
          opts.status = search.get('status') as OpsQueueOptions['status'];
        if (search.has('kind'))
          opts.kind = search.get('kind') as OpsQueueOptions['kind'];
        result = { ...envelope, ...(await store.listFeedback(c, opts)) };
        break;
      }
      case 'detail':
        result = { ...envelope, record: await store.readFeedback(c, id) };
        break;
      case 'history':
        result = {
          ...envelope,
          ...(await store.readFeedbackHistory(c, id, {
            ...(search.has('limit')
              ? { limit: Number(search.get('limit')) }
              : {}),
            ...(search.has('cursor') ? { cursor: search.get('cursor')! } : {}),
          })),
        };
        break;
      case 'triage':
        result = await store.triageFeedback(c, actor, id, input);
        break;
      case 'observation':
        result = await store.createObservation(c, actor, input);
        break;
      case 'correction':
        result = await store.correctObservation(c, actor, id, input);
        break;
      case 'feedback': {
        const v = parseFeedback(input);
        const source = await session.db
          .prepare(
            "SELECT r.*,p.candidate_id FROM pilot_curriculum_learning_run r JOIN pilot_curriculum_publication p ON p.id=r.publication_id JOIN pilot_parent_child l ON l.child_id=r.child_id JOIN pilot_auth_user u ON u.id=l.child_id WHERE r.id=? AND r.child_id=? AND l.parent_id=? AND u.role='child' AND u.disabled=0 AND u.must_change_password=0 AND r.lesson_version='forest-01-v4'",
          )
          .bind(v.runId, id, actor.id)
          .first<Record<string, unknown>>();
        if (!source) fail('NOT_FOUND', 404);
        result = await store.createFeedback(c, actor, v, {
          childId: id,
          runId: v.runId,
          runInstallationId: String(source.installation_id),
          candidateId: String(source.candidate_id),
          lessonId: 'forest-01',
          lessonVersion: String(source.lesson_version),
          contentDigest: String(source.content_digest),
          buildId: String(source.candidate_id),
        });
        break;
      }
    }
    return json(result);
  } catch (error) {
    const known = error instanceof OpsError;
    const code = known ? error.code : 'OPS_UNAVAILABLE',
      status = known ? error.status : 503;
    return json(
      {
        schemaVersion: 'r4-ops-view-1',
        installationId: c?.installationId ?? 'unknown',
        opsInstallationId: c?.opsInstallationId ?? null,
        buildId: session.config.candidateId,
        serverAt: c?.now() ?? Date.now(),
        ...(status === 503 ? { status: { monitorState: 'unknown' } } : {}),
        error: { code, message: code },
        ...(known && error.currentRevision !== undefined
          ? { currentRevision: error.currentRevision }
          : {}),
        ...(code === 'OPS_CURSOR_STALE' ? { refreshRequired: true } : {}),
      },
      status,
    );
  }
}
