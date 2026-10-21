import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const gatewayTarget = process.env.ZEROROUTER_DEV_GATEWAY_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // Gateway API (client-facing, needs gateway keys) and admin API (dashboard session)
      '/v1': { target: gatewayTarget, changeOrigin: false },
      '/admin': { target: gatewayTarget, changeOrigin: false },
      '/healthz': { target: gatewayTarget, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
