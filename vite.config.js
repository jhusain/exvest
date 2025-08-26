import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const isDevBuild = mode === 'development';
  // Work on GitHub Pages under /<repo>/
  const repo = process.env.GITHUB_REPOSITORY?.split('/').pop();
  const base = process.env.GITHUB_ACTIONS ? `/${repo}/` : '/';

  return {
    base,
    plugins: [react()],
    build: {
      sourcemap: isDevBuild,             // dev build => source maps
      outDir: isDevBuild ? 'dist-dev' : 'dist',
      assetsDir: 'assets',
      target: 'es2019',
      rollupOptions: {
        output: {
          manualChunks: undefined // keep it simple (single bundle per type)
        }
      }
    },
    define: {
      __DEV_BUILD__: JSON.stringify(isDevBuild)
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: []
    }
  };
});
