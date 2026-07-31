import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev only. In production Fastify serves these built assets itself.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Built straight into the server's static root so the Docker runtime stage
    // only has to copy one tree.
    outDir: '../server/public',
    emptyOutDir: true,
  },
});
