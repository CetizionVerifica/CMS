import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds the component demo gallery (demo/). Playwright runs keyboard and axe checks against it (`pnpm test:e2e`).
export default defineConfig({
  root: 'demo',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist/demo', emptyOutDir: true },
  server: { port: 4310, strictPort: true },
  preview: { port: 4310, strictPort: true },
});
