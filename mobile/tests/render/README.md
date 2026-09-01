# Rendered accessibility tests

These tests **mount** components and query them the way assistive technology
traverses them — `getByRole`, `getByLabelText`, `accessibilityValue`,
`accessibilityState`. They are the counterpart to the source-inspection suites
in `tests/*.test.ts`, which read source text and prove wiring exists but cannot
prove anything renders or is reachable.

Run them with the rest of the suite (`npm test`) or on their own:

```bash
npx vitest run --project render
```

## How the harness works

`mobile/` tests with Vitest, so `@react-native/jest-preset` cannot be used
directly. `tests/harness/rnRequireHook.cjs` does the equivalent with Node's
CommonJS and `module.registerHooks` loaders:

- React Native 0.86 publishes uncompiled Flow/JSX source. It is compiled on
  require with `babel-preset-expo` — the app's own preset, so the harness
  follows RN upgrades instead of drifting from them. Results are cached in
  `node_modules/.cache/finsight-rn-harness`, warmed once by
  `tests/harness/globalSetup.ts`.
- Native-backed RN modules are redirected at **the jest preset's own mock
  files**, so the harness inherits Meta's mock fidelity. The redirect list
  mirrors `@react-native/jest-preset/jest/setup.js` and should be diffed
  against it on any React Native upgrade.
- Expo and third-party native modules are stubbed in `tests/harness/stubs/`.

One deliberate divergence from the preset: **`TextInput` is not mocked.** The
preset replaces `focus()` with a no-op, which would make the auth focus
behaviour untestable.

## House rules for tests in here

- Prefer accessibility queries. `getByTestId` is a last resort, and a source
  regex is never acceptable here — that is what the other suite is for.
- `render()` is **async** in `@testing-library/react-native` 14. So is
  `fireEvent`. Await them.
- Do not import `screen`. It is reassigned by `render()`, and that reassignment
  is invisible across the CommonJS/ESM boundary Vitest uses. Destructure
  queries from the `render()` result instead.
- A `View` is only an accessibility element if it sets `accessible`. If a role
  query cannot find something that clearly sets `accessibilityRole`, that is
  usually a real bug in the component, not in the test.

## What this is not

It is a renderer, not a device. There is no view geometry, no gesture
recognizer, no screen reader, no camera and no OS. It **pins iOS**, matching
the jest preset's default platform.

**Nothing here gives any coverage of camera, permission or app-lifecycle
behaviour.** A render test of camera UI would not be a test of camera
lifecycle, and `receipt-camera/*` has no tests in this directory at all. Those
remain physical-device-only — see `docs/MOBILE-UI-UX-IMPROVEMENT-PLAN.md`
§7 Phase 4.
