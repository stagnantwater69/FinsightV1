import path from 'node:path';
import { defineConfig } from 'vitest/config';

const here = (p: string) => path.resolve(__dirname, p);

/**
 * Two test projects live side by side.
 *
 * - `source` — the pre-existing source-inspection suites (`tests/*.test.ts`).
 *   These read source text off disk and assert on it; they prove wiring exists,
 *   not that anything renders.
 *
 * - `render` — the render/accessibility harness (`tests/render/*.test.tsx`).
 *   These actually mount components with @testing-library/react-native and
 *   query them through accessibility roles, labels and values.
 *
 * Getting React Native to load under Vitest needs Node-level CommonJS hooks
 * (Flow/JSX transform on require + the native-module redirects that
 * `@react-native/jest-preset` performs under Jest). That lives in
 * `tests/harness/rnRequireHook.cjs` and is installed by
 * `tests/harness/setup.ts` before any React Native module is imported. It is
 * deliberately *not* a Vite plugin: Vite 8's module runner only handles ESM,
 * and React Native's published source is CommonJS.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'source',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/render/**'],
          environment: 'node',
        },
      },
      {
        resolve: {
          // React Native ships its runtime entry behind the "react-native"
          // export condition; without this Vitest picks the type-only entry.
          conditions: ['react-native', 'require', 'node', 'default'],
          // App source is transformed by Vite, so its imports are resolved by
          // Vite and never reach the Node-level hooks in
          // `tests/harness/rnRequireHook.cjs`. The same native-module stubs are
          // therefore aliased here as well, so both halves of the module graph
          // agree on which implementation is in use.
          alias: [
            {
              find: /^@expo\/vector-icons(\/.*)?$/,
              replacement: here('tests/harness/stubs/vector-icons.js'),
            },
            {
              find: /^react-native-svg$/,
              replacement: here('tests/harness/stubs/react-native-svg.js'),
            },
            {
              find: /^react-native-safe-area-context$/,
              replacement: here('tests/harness/stubs/safe-area-context.js'),
            },
            {
              find: /^expo-haptics$/,
              replacement: here('tests/harness/stubs/expo-haptics.js'),
            },
            {
              find: /^expo-secure-store$/,
              replacement: here('tests/harness/stubs/expo-secure-store.js'),
            },
            {
              find: /^expo-constants$/,
              replacement: here('tests/harness/stubs/expo-constants.js'),
            },
            {
              find: /^expo-linking$/,
              replacement: here('tests/harness/stubs/expo-linking.js'),
            },
            {
              find: /^expo-font$/,
              replacement: here('tests/harness/stubs/expo-font.js'),
            },
            {
              find: /^expo-splash-screen$/,
              replacement: here('tests/harness/stubs/expo-splash-screen.js'),
            },
            {
              find: /^expo-status-bar$/,
              replacement: here('tests/harness/stubs/expo-status-bar.js'),
            },
            {
              find: /^expo-image-picker$/,
              replacement: here('tests/harness/stubs/expo-image-picker.js'),
            },
            {
              find: /^expo-document-picker$/,
              replacement: here('tests/harness/stubs/expo-document-picker.js'),
            },
          ],
        },
        test: {
          name: 'render',
          include: ['tests/render/**/*.test.tsx'],
          environment: 'node',
          // @testing-library/react-native's matchers extend a global `expect`.
          globals: true,
          setupFiles: [here('tests/harness/setup.ts')],
          // Compiles React Native once, before the workers start, so no single
          // test file pays for a cold Babel cache.
          globalSetup: [here('tests/harness/globalSetup.ts')],
          // The RN module graph is large and loads lazily on first render.
          testTimeout: 30000,
          hookTimeout: 30000,
          server: {
            deps: {
              // Keep RN and friends OUT of Vite's transform pipeline so they
              // are required through Node, where the harness hooks apply.
              external: [
                /node_modules[\\/]react-native[\\/]/,
                /node_modules[\\/]@react-native[\\/]/,
                /node_modules[\\/]@testing-library[\\/]react-native[\\/]/,
              ],
            },
          },
        },
      },
    ],
  },
});
