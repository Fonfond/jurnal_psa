import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const sharedSource = new URL(
  '../../packages/shared/src/index.ts',
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export default defineConfig({
  resolve: {
    alias: {
      // The shared package is published as CommonJS; Vite/Rollup cannot see
      // through `__exportStar`, so the web build consumes the TS source.
      '@logbook/shared': sharedSource,
    },
  },
  plugins: [
    react(),
    VitePWA({
      // Custom service worker (SYN-05): background/periodic sync, app shell
      // cache and offline fallback live in src/sw/service-worker.ts.
      strategies: 'injectManifest',
      srcDir: 'src/sw',
      filename: 'service-worker.ts',
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.svg', 'offline.html'],
      manifest: {
        name: 'ЭОЖ Logbook',
        short_name: 'Logbook',
        description: 'Электронный оперативный журнал',
        lang: 'ru',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f1f5f9',
        theme_color: '#0f172a',
        icons: [
          {
            src: 'icons/icon-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // The API is never precached: offline-first state lives in IndexedDB.
        globIgnores: ['**/v1/**'],
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
