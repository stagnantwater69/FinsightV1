// Render-harness setup. Vitest equivalent of the globals installed by
// `@react-native/jest-preset/jest/setup.js`, plus the CommonJS hooks that let
// React Native's Flow/JSX source load under Node.
//
// SCOPE: this makes component trees mountable and queryable through
// accessibility APIs. It is not a device and gives no coverage of camera,
// permission, or app-lifecycle behavior.
import { createRequire } from 'node:module';
import { vi } from 'vitest';

const require = createRequire(import.meta.url);

const define = (name: string, value: unknown) => {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
};

// Must be defined before React Native source is evaluated.
define('__DEV__', true);
define('IS_REACT_ACT_ENVIRONMENT', true);
// Suppresses RN's legacy-renderer deprecation warning path, as the Jest preset does.
define('IS_REACT_NATIVE_TEST_ENVIRONMENT', true);
define('nativeFabricUIManager', {});
if (typeof (globalThis as Record<string, unknown>).window === 'undefined') {
  define('window', globalThis);
}
if (typeof globalThis.performance === 'undefined') {
  define('performance', { now: () => Date.now() });
}
define('requestAnimationFrame', (cb: (t: number) => void) =>
  setTimeout(() => cb(Date.now()), 0),
);
define('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) =>
  clearTimeout(id),
);

// Install the Flow/JSX require transform + native-module redirects.
const hook = require('./rnRequireHook.cjs') as {
  install: () => void;
  setMockFnFactory: (
    factory: (impl?: (...args: unknown[]) => unknown) => unknown,
  ) => void;
};

// `@react-native/jest-preset`'s mock modules call `jest.fn()` at module scope.
// Backing them with Vitest spies means assertions like `toHaveBeenCalled()`
// work against React Native's own mocks. The `jest` object is injected into
// the module scope of the preset's files only — nothing global is polluted and
// app code never sees a fake `jest`.
hook.setMockFnFactory((impl) => (impl ? vi.fn(impl) : vi.fn()));
hook.install();

require('@react-native/js-polyfills/error-guard');
