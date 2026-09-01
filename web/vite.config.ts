// `vitest/config` rather than `vite` — the plain Vite `defineConfig` has no
// `test` key in its type, so the production build (which typechecks this file)
// rejects it even though `vitest` itself reads it happily.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    /*
     * The frontend calls a relative `/api/v1` base (see web/.env) rather
     * than an absolute `http://localhost:4000`, and this proxy is what makes
     * that resolve — forwarded server-side to the backend on this same
     * machine. An absolute localhost URL only works when the browser IS
     * that machine; it breaks the moment the page is opened through a
     * devtunnel/ngrok-style forwarded URL, because "localhost" then means
     * the browser's own machine, which has nothing listening on :4000.
     * Proxying keeps API calls same-origin as the page, so they ride
     * whatever origin actually loaded it.
     */
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
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
    /*
     * `*.types.test.ts` files assert things the runtime can't see — that a
     * union does NOT admit a value the API rejects, for instance. Those live
     * or die on tsc, so vitest runs one over them; without this they'd pass
     * silently while the type they guard drifted.
     */
    typecheck: {
      enabled: true,
      include: ['src/**/*.types.test.ts'],
      tsconfig: './tsconfig.app.json',
    },
    setupFiles: ['./src/test/setup.ts'],
  },
})
