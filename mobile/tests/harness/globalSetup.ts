// Warms the render harness's Babel cache once, before any worker starts.
//
// WHY THIS EXISTS: compiling React Native's published source with
// `babel-preset-expo` is expensive, and every render test file pulls in the
// same large module graph. With a cold cache, several workers compile it
// simultaneously, each paying the full cost — which pushed individual test
// files past their timeout on the first run after a checkout or an
// `npm install`. Doing it once here means the workers all read the same warm
// on-disk cache and the suite's timing stops depending on cache state.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default function setup(): void {
  const define = (name: string, value: unknown) => {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  };

  define('__DEV__', true);
  define('IS_REACT_ACT_ENVIRONMENT', true);
  define('IS_REACT_NATIVE_TEST_ENVIRONMENT', true);
  define('nativeFabricUIManager', {});
  // Some RN modules read `window` at import time (DebuggingOverlayRegistry).
  if (typeof (globalThis as Record<string, unknown>).window === 'undefined') {
    define('window', globalThis);
  }
  if (typeof globalThis.performance === 'undefined') {
    define('performance', { now: () => Date.now() });
  }

  const hook = require('./rnRequireHook.cjs') as { install: () => void };
  hook.install();

  // React Native's entry is a lazy getter per export, so each component has to
  // be touched for its subtree to be compiled and cached.
  const RN = require('react-native') as Record<string, unknown>;
  for (const name of [
    'View',
    'Text',
    'TextInput',
    'Pressable',
    'ScrollView',
    'Image',
    'Modal',
    'ActivityIndicator',
    'StyleSheet',
    'Platform',
    'Appearance',
    'Animated',
    'KeyboardAvoidingView',
    'FlatList',
  ]) {
    void RN[name];
  }

  // Deliberately NOT requiring @testing-library/react-native here: it extends a
  // global `expect`, which does not exist in the global-setup process. It is
  // also published pre-compiled, so there is nothing to warm.
}
