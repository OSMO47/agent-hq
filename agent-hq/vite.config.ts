import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const target = `http://127.0.0.1:${process.env.HQ_PORT ?? 4317}`;
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target, changeOrigin: true }, '/ws': { target: target.replace('http', 'ws'), ws: true, changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
