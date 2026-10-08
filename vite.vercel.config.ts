import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { nitro } from 'nitro/vite';
import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^cloudflare:workers$/,
        replacement: path.resolve(
          import.meta.dirname,
          'lib/platform/node-bindings.ts',
        ),
      },
    ],
  },
  plugins: [
    tailwindcss(),
    vinext(),
    nitro({
      preset: process.env.NITRO_PRESET || 'vercel',
      vercel: { functions: { runtime: 'nodejs22.x', regions: ['hnd1'] } },
    }),
  ],
});
