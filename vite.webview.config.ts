import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    emptyOutDir: false,
    outDir: 'media',
    sourcemap: false,
    lib: {
      entry: 'webview/src/main.tsx',
      formats: ['es'],
      fileName: () => 'reader-app.js'
    },
    rollupOptions: {
      output: {
        assetFileNames: assetInfo => assetInfo.name?.endsWith('.css') ? 'reader-app.css' : 'reader-app-[name][extname]'
      }
    }
  }
});
