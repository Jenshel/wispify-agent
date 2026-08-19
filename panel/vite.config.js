// panel/vite.config.js — dev-server proxy so the panel's same-origin
// fetch() calls (panel/src/api/client.js) reach the backend without CORS
// during `npm run dev`. In production the panel is built (`vite build`)
// and served from the same origin as the API, so no proxy is needed there.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.WISPIFY_API_PROXY_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
