import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

export default defineConfig(({ mode }) => {
  const isDevBuild = mode === 'development';
  // Work on GitHub Pages under /<repo>/
  const repo = process.env.GITHUB_REPOSITORY?.split('/').pop() || 'exvest';
  const base = process.env.GITHUB_ACTIONS ? `/${repo}/` : '/';

  // The Electron main/preload build is opt-in via ELECTRON=1 so the plain
  // `vite build` used by the web/GitHub Pages target never bundles Node/IB code.
  const plugins: PluginOption[] = [react()];
  if (process.env.ELECTRON) {
    // package.json has "type": "module", so vite-plugin-electron's default
    // lib-mode build emits ESM for the main entry (`.js`, loaded by Node as
    // a module) — that breaks @stoqey/ib's CommonJS dependency chain (raw
    // __dirname/require references). Force main's lib build to CJS under a
    // `.cjs` extension so Node loads it as CommonJS regardless of
    // "type": "module". Electron's preload loader is unaffected by
    // "type": "module" (it always requires the script as CJS internally),
    // so the plugin's default preload config is left as-is.
    plugins.push(
      electron({
        main: {
          entry: 'electron/main.ts',
          vite: {
            build: {
              lib: { entry: 'electron/main.ts', formats: ['cjs'], fileName: () => '[name].cjs' }
            }
          }
        },
        preload: { input: 'electron/preload.ts' }
      })
    );
  }

  return {
    base,
    plugins,
    build: {
      sourcemap: isDevBuild, // dev build => source maps
      outDir: isDevBuild ? 'dist-dev' : 'dist',
      assetsDir: 'assets',
      target: 'es2019',

      // **Key changes below** — make the dev bundle readable in DevTools
      minify: isDevBuild ? false : 'esbuild', // no minify for dev build
      cssMinify: isDevBuild ? false : true, // readable CSS for dev build
      esbuild: { keepNames: true }, // keep fn/class names for stack traces

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
      setupFiles: ['./tests/setup.ts']
    }
  };
});
