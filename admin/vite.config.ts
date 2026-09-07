import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build ide u admin/dist, Fastify ga servira na /admin/.
const API = 'http://localhost:' + (process.env.PORT || 4000);

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/media': API,
      '/time': API,
      '/player': API,
      '/kalibracija': API,
    },
  },
});
