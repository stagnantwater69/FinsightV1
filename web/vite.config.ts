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
     * Listen on every interface, not just loopback.
     *
     * Auth emails are read on a phone as often as on the dev machine, and a
     * confirmation link pointing at `localhost` resolves to the PHONE when it
     * is opened there — "localhost refused to connect", with nothing wrong on
     * this end. Binding to 0.0.0.0 lets WEB_APP_URL be this machine's LAN
     * address (see backend/.env), so the same link works from both.
     */
    host: true,
    // Approve this shared preview explicitly; a wildcard would trust other
    // users' tunnels too. Vite also accepts extra exact hostnames through the
    // __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS shell environment variable.
    allowedHosts: ['l5v15rgq-5173.asse.devtunnels.ms'],
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
