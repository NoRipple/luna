import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'src/renderer/panel-build'),
    emptyOutDir: true,
    assetsDir: '.',
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/renderer/panel-react/index.html'),
      output: {
        entryFileNames: 'panel.js',
        chunkFileNames: 'panel-[name].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.css')) return 'panel.css';
          return 'panel-[name][extname]';
        }
      }
    }
  }
});
