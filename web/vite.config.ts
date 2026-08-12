// `vitest/config` rather than `vite` — the plain Vite `defineConfig` has no
// `test` key in its type, so the production build (which typechecks this file)
// rejects it even though `vitest` itself reads it happily.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    /*
     * `node` stays the DEFAULT, with jsdom opted into per file via a
     * `@vitest-environment jsdom` docblock at the top of that file.
     *
     * Most tests here are pure logic — money formatting, receipt-review
     * arithmetic — and gain nothing from a simulated DOM while paying for it
     * on every run. A component test declares what it needs instead, so the
     * cost lands only where it buys something.
     */
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
})
