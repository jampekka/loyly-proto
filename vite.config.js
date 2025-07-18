import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';


const rollupOptions = {
  input: {
    main: 'index.html',
    sw: 'service-worker.js'
  },
  output: {
    entryFileNames: asset => asset.name === 'sw' ? 'service-worker.js' : '[name].js',
    chunkFileNames: '[name].js',
    assetFileNames: '[name][extname]'
  }
}

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: './docs',
    emptyOutDir: true,
    rollupOptions
  },
  server: {
    open: true,
  },
});
