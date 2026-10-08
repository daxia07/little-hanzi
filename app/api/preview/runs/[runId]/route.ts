import { handleError, json, requirePreview, routeParams, storeForPreview } from '../../_shared';

export async function GET(_request: Request, context: { params: unknown }): Promise<Response> {
  const config = requirePreview();
  if (config instanceof Response) return config;
  try {
    const { runId } = await routeParams(context);
    const view = await storeForPreview(config).getView(runId);
    if (!view) return json({ error: { code: 'NOT_FOUND', message: 'preview run was not found' } }, 404);
    return json(view);
  } catch (caught) {
    return handleError(caught);
  }
}
