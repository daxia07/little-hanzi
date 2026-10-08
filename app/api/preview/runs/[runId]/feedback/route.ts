import { handleError, bodyJson, exactObject, json, requirePreview, routeParams, storeForPreview } from '../../../_shared';
import type { FeedbackCategory, FeedbackSource, PreviewStep } from '@/lib/preview/types';

const categories = new Set<FeedbackCategory>(['clarity', 'pacing', 'difficulty', 'mascot', 'reporting', 'other']);

export async function POST(request: Request, context: { params: unknown }): Promise<Response> {
  const config = requirePreview();
  if (config instanceof Response) return config;
  try {
    const body = await bodyJson(request);
    if (!exactObject(body, ['feedbackId', 'stepId', 'category', 'text', 'source']) || typeof body.feedbackId !== 'string' || !/^[A-Za-z0-9:_-]{1,120}$/.test(body.feedbackId) || (body.stepId !== null && typeof body.stepId !== 'string') || typeof body.category !== 'string' || !categories.has(body.category as FeedbackCategory) || typeof body.text !== 'string' || body.text.trim().length < 1 || body.text.length > 2000 || (body.source !== 'reviewer' && body.source !== 'child')) {
      return json({ error: { code: 'INVALID_REQUEST', message: 'feedback is invalid' } }, 400);
    }
    const { runId } = await routeParams(context);
    const feedback = await storeForPreview(config).addFeedback(runId, {
      feedbackId: body.feedbackId,
      stepId: body.stepId as PreviewStep | null,
      category: body.category as FeedbackCategory,
      text: body.text,
      source: body.source as FeedbackSource,
    });
    return json(feedback, 201);
  } catch (caught) {
    return handleError(caught);
  }
}
