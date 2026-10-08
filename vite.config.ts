import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { assertOwnedState } from './scripts/qa-helpers.mjs';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

// Deployment identity is external configuration, not a TypeScript source input.
// Keep the Worker fail-closed when this record is absent or invalid; the Node
// build and source typecheck do not need a copied production hosting identity.
const { d1, r2 } = JSON.parse(
  readFileSync(new URL('./.openai/hosting.json', import.meta.url), 'utf8'),
) as { d1: string | null; r2: string | null };

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const localBindingConfig = {
  main: 'vinext/server/fetch-handler',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
};

export default defineConfig(async () => {
  const preview = process.env.HANZI_PREVIEW_MODE === '1';
  const testing = process.env.HANZI_TEST_MODE === '1';
  if (testing && (!preview || !process.env.HANZI_TEST_RUN_ID || !process.env.HANZI_TEST_TOKEN)) {
    throw new Error('Test mode requires preview mode, a test-run ID and a private harness token');
  }
  const statePath = preview ? assertOwnedState(testing ? process.env.HANZI_TEST_STATE_DIR : process.env.HANZI_PREVIEW_STATE_DIR) : undefined;
  const previewVars: Record<string, string> = preview ? {
    HANZI_PREVIEW_MODE: '1', HANZI_TEST_MODE: testing ? '1' : '0',
    HANZI_TEST_RUN_ID: process.env.HANZI_TEST_RUN_ID || '',
    HANZI_TEST_TOKEN: process.env.HANZI_TEST_TOKEN || '',
    HANZI_CANDIDATE_ID: process.env.HANZI_CANDIDATE_ID || 'local-preview',
  } : {};
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: { ...localBindingConfig, vars: previewVars },
        ...(preview ? { persistState: { path: statePath! }, remoteBindings: false, inspectorPort: false as const } : {}),
      }),
    ],
  };
});
