import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies the API to the local cluster, so the browser still sees one origin (localhost:5173) and the
// cookie works. The gateway accepts only the exact Origin of the real dashboard (docs/architecture.md, decision 35), so the
// proxy sets it. This exists in "npm run dev" only: the production image is served by nginx behind the same Ingress host
// as the API (no proxy, no CORS).
const GATEWAY = 'http://gateway.urumi.test';

export default defineConfig({
  plugins: [react()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: GATEWAY,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('origin', GATEWAY));
        },
      },
    },
  },
  build: {
    // No data: URIs: every asset is a file of the same origin (the CSP of the image has no inline sources).
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
