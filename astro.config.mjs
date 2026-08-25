// @ts-check
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'server',
  session: false,
  adapter: node({ mode: 'standalone' }),
  vite: {
    plugins: [tailwindcss()],
    server: { host: '127.0.0.1' },
    resolve: {
      alias: {
        'cloudflare:workers': fileURLToPath(new URL('./src/lib/cloudflare-stub.ts', import.meta.url)),
      },
    },
  },
});