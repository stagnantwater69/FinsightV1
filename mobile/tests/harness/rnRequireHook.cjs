/* eslint-disable */
/**
 * Makes React Native loadable inside a plain Node process, which is what the
 * Vitest render harness needs.
 *
 * Two problems have to be solved, and Jest solves both with its own module
 * system + `@react-native/jest-preset`. This repo tests with Vitest, so we do
 * the equivalent with Node's CommonJS hooks:
 *
 *  1. React Native 0.86 publishes *uncompiled* source — `.js` files carrying
 *     Flow type annotations and JSX. Node cannot parse either. Every file under
 *     the RN-family packages is therefore transformed on require with Sucrase
 *     (`flow` + `jsx` + `imports`), which is synchronous and so usable from a
 *     require hook.
 *
 *  2. A lot of RN's public surface is backed by native modules that do not
 *     exist off-device. `Module._resolveFilename` is patched to redirect those
 *     specifiers at the exact same mocks `@react-native/jest-preset` installs
 *     under Jest, so the harness inherits Meta's own mock fidelity rather than
 *     an ad-hoc set of ours.
 *
 * IMPORTANT SCOPE NOTE: these are *renderer* mocks. They let component trees
 * mount and be queried through accessibility APIs. They are NOT a device, and
 * nothing here gives coverage of camera, permission, or app-lifecycle behavior.
 */
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const babel = require('@babel/core');

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const NM = path.join(MOBILE_ROOT, 'node_modules');

// Packages that ship Flow-annotated / JSX-bearing source rather than compiled JS.
const FLOW_SOURCE_DIRS = [
  path.join(NM, 'react-native') + path.sep,
  path.join(NM, '@react-native') + path.sep,
];

const jestPresetMock = (name) =>
  path.join(NM, '@react-native', 'jest-preset', 'jest', 'mocks', `${name}.js`);

const harnessStub = (name) => path.join(__dirname, 'stubs', name);

/**
 * Mirrors the `mock(...)` list in
 * `@react-native/jest-preset/jest/setup.js`. Kept in the same order so it can
 * be diffed against the upstream file when React Native is upgraded.
 */
const MODULE_REDIRECTS = new Map(
  Object.entries({
    'react-native/Libraries/AppState/AppState': jestPresetMock('AppState'),
    'react-native/Libraries/BatchedBridge/NativeModules':
      jestPresetMock('NativeModules'),
    'react-native/Libraries/Components/AccessibilityInfo/AccessibilityInfo':
      jestPresetMock('AccessibilityInfo'),
    'react-native/Libraries/Components/ActivityIndicator/ActivityIndicator':
      jestPresetMock('ActivityIndicator'),
    'react-native/Libraries/Components/Clipboard/Clipboard':
      jestPresetMock('Clipboard'),
    'react-native/Libraries/Components/RefreshControl/RefreshControl':
      jestPresetMock('RefreshControl'),
    'react-native/Libraries/Components/ScrollView/ScrollView':
      jestPresetMock('ScrollView'),
    // DELIBERATE DIVERGENCE from the Jest preset: TextInput is NOT mocked.
    // The preset's mock replaces `focus()` with a no-op, which would make the
    // "a failed submit moves focus to the first invalid field" behavior
    // untestable off-device, and it would also cost the label-association
    // queries their real component. React Native's real TextInput mounts fine
    // here. Note no test currently reads `TextInputState`: whether focus
    // PHYSICALLY moves stays a device check (see auth.test.tsx), so the reason
    // to keep the real component is fidelity, not an assertion that exists
    // today. Don't "restore" the mock on that basis.
    'react-native/Libraries/Components/View/View': jestPresetMock('View'),
    'react-native/Libraries/Components/View/ViewNativeComponent':
      jestPresetMock('ViewNativeComponent'),
    'react-native/Libraries/Core/InitializeCore':
      jestPresetMock('InitializeCore'),
    'react-native/Libraries/Image/Image': jestPresetMock('Image'),
    'react-native/Libraries/Linking/Linking': jestPresetMock('Linking'),
    'react-native/Libraries/Modal/Modal': jestPresetMock('Modal'),
    'react-native/Libraries/NativeComponent/NativeComponentRegistry':
      jestPresetMock('NativeComponentRegistry'),
    'react-native/Libraries/ReactNative/RendererProxy':
      jestPresetMock('RendererProxy'),
    'react-native/Libraries/ReactNative/requireNativeComponent':
      jestPresetMock('requireNativeComponent'),
    'react-native/Libraries/ReactNative/UIManager': jestPresetMock('UIManager'),
    'react-native/Libraries/Text/Text': jestPresetMock('Text'),
    'react-native/Libraries/Utilities/useColorScheme':
      jestPresetMock('useColorScheme'),
    'react-native/Libraries/Vibration/Vibration': jestPresetMock('Vibration'),

    // Expo + third-party native modules the screens under test import.
    'expo-haptics': harnessStub('expo-haptics.js'),
    'expo-secure-store': harnessStub('expo-secure-store.js'),
    'expo-constants': harnessStub('expo-constants.js'),
    'expo-linking': harnessStub('expo-linking.js'),
    'expo-font': harnessStub('expo-font.js'),
    'expo-splash-screen': harnessStub('expo-splash-screen.js'),
    'expo-status-bar': harnessStub('expo-status-bar.js'),
    'expo-image-picker': harnessStub('expo-image-picker.js'),
    'expo-document-picker': harnessStub('expo-document-picker.js'),
    'react-native-svg': harnessStub('react-native-svg.js'),
    'react-native-safe-area-context': harnessStub('safe-area-context.js'),
  }),
);

// Absolute-path redirects resolved lazily (the file may not exist until first
// use of a specifier that maps to it).
const ABSOLUTE_REDIRECTS = new Map();
for (const [request, target] of MODULE_REDIRECTS) {
  if (request.startsWith('react-native/')) {
    ABSOLUTE_REDIRECTS.set(path.join(NM, request) + '.js', target);
    ABSOLUTE_REDIRECTS.set(path.join(NM, request), target);
  }
}

const isFlowSource = (filename) =>
  FLOW_SOURCE_DIRS.some((dir) => filename.startsWith(dir));

const isHarnessStub = (filename) =>
  filename.startsWith(path.join(__dirname, 'stubs') + path.sep);

/**
 * Compile React Native's published source to something Node can run.
 *
 * Babel with `babel-preset-expo` is used rather than a lighter/faster stripper
 * because RN 0.86 uses Flow dialect features that only Meta's own toolchain
 * desugars — notably `component Foo(...)` declarations (see
 * `Libraries/Components/View/View.js`), which a plain type-stripper leaves
 * behind as a syntax error. Using the app's real preset also means the harness
 * follows React Native upgrades instead of drifting from them.
 */
function compileFlowSource(source, filename) {
  const cached = readCache(filename, source);
  if (cached != null) return cached;

  const preset = babel.transformSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    compact: false,
    presets: [
      [require.resolve('babel-preset-expo'), { jsxRuntime: 'automatic' }],
    ],
  });

  // A SECOND pass, deliberately. `@react-native/babel-plugin-codegen` (inside
  // babel-preset-expo) synthesises new `export` statements for native component
  // specs, and it does so after a modules transform running in the same pass
  // has already finished. Running the CommonJS transform on the preset's output
  // instead catches those, otherwise files like
  // `AndroidHorizontalScrollContentViewNativeComponent.js` come out half ESM
  // and Node's syntax detection then loads them as modules, where `require` is
  // not defined.
  const { code } = babel.transformSync(preset.code, {
    filename,
    babelrc: false,
    configFile: false,
    compact: false,
    sourceType: 'module',
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
  });

  const finalCode = needsJestShim(filename)
    ? `${JEST_SHIM_PREAMBLE}\n${code}`
    : code;
  writeCache(filename, source, finalCode);
  return finalCode;
}

// Babel over the whole React Native module graph is slow enough to notice on
// every run, so results are cached on disk keyed by the exact source bytes.
const CACHE_DIR = path.join(NM, '.cache', 'finsight-rn-harness');
let cacheReady = false;

function cachePathFor(filename, source) {
  const key = crypto
    .createHash('sha1')
    .update(BABEL_CACHE_VERSION)
    .update(filename)
    .update(source)
    .digest('hex');
  return path.join(CACHE_DIR, `${key}.js`);
}

// Bump when the transform options above change.
const BABEL_CACHE_VERSION = 'v2';

function readCache(filename, source) {
  try {
    return fs.readFileSync(cachePathFor(filename, source), 'utf8');
  } catch {
    return null;
  }
}

function writeCache(filename, source, code) {
  try {
    if (!cacheReady) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      cacheReady = true;
    }
    fs.writeFileSync(cachePathFor(filename, source), code);
  } catch {
    // A read-only or racing filesystem just means no caching; not fatal.
  }
}

// The preset's mock modules are written for Jest and call `jest.fn()` /
// `jest.requireActual()` at module scope. Rather than install a global `jest`
// (which would leak into app code and change behavior), the shim is injected
// into the module scope of the preset's own files only. `requireActual` is
// bound to that module's `require`, so relative specifiers still resolve.
const JEST_SHIM_PREAMBLE =
  'const jest = globalThis.__finsightHarnessJest__(require);';

const JEST_PRESET_DIR = path.join(NM, '@react-native', 'jest-preset') + path.sep;
const needsJestShim = (filename) => filename.startsWith(JEST_PRESET_DIR);

/**
 * `jest.requireActual(...)` must reach the *real* module, not the mock we
 * redirect to — otherwise `mocks/View.js` asking for the real View gets handed
 * itself, half-initialised. Redirects are suspended for the duration of the
 * call, mirroring what Jest's module registry does.
 */
// Deliberately one-shot and specifier-scoped: only the module named in the
// `requireActual` call escapes redirection. Its own dependencies keep seeing
// the mocks, which is what Jest does and what keeps `mocks/View.js` from
// dragging in the real native-module bridge.
let bypassSpecifier = null;

function requireActual(moduleRequire, specifier) {
  const previous = bypassSpecifier;
  bypassSpecifier = specifier;
  try {
    return moduleRequire(specifier);
  } finally {
    bypassSpecifier = previous;
  }
}

function shouldBypass(request) {
  return bypassSpecifier != null && request === bypassSpecifier;
}

/**
 * Builds the module-scoped `jest` object injected into the preset's own files.
 * `mockFn` is supplied by the Vitest setup file so the mocks are real spies.
 */
let mockFnFactory = (impl) => impl || (() => {});

function setMockFnFactory(factory) {
  mockFnFactory = factory;
}

function createJestShim(moduleRequire) {
  return {
    fn: (impl) => mockFnFactory(impl),
    requireActual: (specifier) => requireActual(moduleRequire, specifier),
    requireMock: (specifier) => moduleRequire(specifier),
    mock: () => {},
    now: () => Date.now(),
  };
}

/**
 * React Native ships platform-specific implementations as sibling files
 * (`Platform.ios.js`, `Platform.android.js`) that Metro/Jest pick via platform
 * extensions. Node knows nothing about that and would load the platform-neutral
 * shim — which is how you end up with `Platform.OS === undefined`.
 *
 * The harness pins iOS, matching `@react-native/jest-preset`'s
 * `haste.defaultPlatform`. Anything whose behavior differs by platform is
 * therefore only exercised on the iOS branch here, and Android-specific
 * rendering still needs a device or an Android-configured run.
 */
const PLATFORM_EXTENSIONS = ['.ios.js', '.native.js'];

function applyPlatformExtension(resolvedPath) {
  if (!isFlowSource(resolvedPath) || !resolvedPath.endsWith('.js')) {
    return resolvedPath;
  }
  const base = resolvedPath.slice(0, -'.js'.length);
  for (const ext of PLATFORM_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return resolvedPath;
}

/** Resolve a bare specifier to one of our redirect targets, or null. */
function redirectFor(request) {
  if (shouldBypass(request)) return null;
  const direct = MODULE_REDIRECTS.get(request);
  if (direct) return direct;
  // @expo/vector-icons has many sub-entrypoints (`/Ionicons`, `/Feather`…);
  // one stub answers for all of them.
  if (request === '@expo/vector-icons' || request.startsWith('@expo/vector-icons/')) {
    return harnessStub('vector-icons.js');
  }
  return null;
}

let installed = false;

function install() {
  if (installed) return;
  installed = true;

  installEsmHooks();

  globalThis.__finsightHarnessJest__ = createJestShim;

  // ---- 1. Module redirects -------------------------------------------------
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function patchedResolve(request, parent, ...rest) {
    const direct = redirectFor(request);
    if (direct) return direct;
    const resolved = originalResolve.call(this, request, parent, ...rest);
    if (shouldBypass(request)) return applyPlatformExtension(resolved);
    return (
      ABSOLUTE_REDIRECTS.get(resolved) || applyPlatformExtension(resolved)
    );
  };

  // ---- 2. Flow/JSX transform on require ------------------------------------
  const originalJs = Module._extensions['.js'];
  Module._extensions['.js'] = function loadJs(module, filename) {
    if (!isFlowSource(filename) && !isHarnessStub(filename)) {
      return originalJs(module, filename);
    }
    const source = fs.readFileSync(filename, 'utf8');
    return module._compile(compileFlowSource(source, filename), filename);
  };

  // ---- 3. Image/font assets ------------------------------------------------
  // Metro turns `require('…/fin.png')` into an asset reference. Node has no
  // idea what a PNG is, and without this it falls through to the JavaScript
  // loader and dies on the first byte.
  for (const ext of ASSET_EXTENSIONS) {
    Module._extensions[ext] = function loadAsset(module, filename) {
      module.exports = assetModuleFor(filename);
    };
  }
}

const ASSET_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.mp4',
];

const isAsset = (filename) =>
  ASSET_EXTENSIONS.some((ext) => filename.toLowerCase().endsWith(ext));

/**
 * Stands in for Metro's asset reference. Shaped like what `Image.resolveAssets`
 * hands back so a `source={require('…')}` prop still renders, and carrying the
 * path so a test can assert WHICH asset a component chose.
 */
const assetRegistry = new Map();
function assetModuleFor(filename) {
  if (!assetRegistry.has(filename)) {
    assetRegistry.set(filename, {
      __harnessAsset: true,
      uri: pathToFileURL(filename).href,
      testUri: path.relative(MOBILE_ROOT, filename),
      width: 1,
      height: 1,
      scale: 1,
    });
  }
  return assetRegistry.get(filename);
}

/**
 * Vitest loads externalized dependencies with dynamic `import()`, which goes
 * through Node's ESM loader and never touches `Module._extensions`. Node 24's
 * synchronous `module.registerHooks` covers both loaders, so the same redirect
 * and transform rules apply however React Native happens to be reached.
 */
function installEsmHooks() {
  const { registerHooks } = Module;
  if (typeof registerHooks !== 'function') {
    throw new Error(
      'The React Native render harness needs Node >= 22.15 for module.registerHooks(). ' +
        `Running on ${process.version}.`,
    );
  }

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const direct = redirectFor(specifier);
      if (direct) {
        return { url: pathToFileURL(direct).href, shortCircuit: true };
      }
      const result = nextResolve(specifier, context);
      if (!result?.url?.startsWith('file:')) return result;

      const resolvedPath = fileURLToPath(result.url);
      if (!shouldBypass(specifier)) {
        const target = ABSOLUTE_REDIRECTS.get(resolvedPath);
        if (target) {
          return { ...result, url: pathToFileURL(target).href, shortCircuit: true };
        }
      }
      const platformPath = applyPlatformExtension(resolvedPath);
      if (platformPath !== resolvedPath) {
        return { ...result, url: pathToFileURL(platformPath).href, shortCircuit: true };
      }
      return result;
    },

    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      const filename = fileURLToPath(url);
      if (isAsset(filename)) {
        return {
          format: 'commonjs',
          source: `module.exports = ${JSON.stringify(assetModuleFor(filename))};`,
          shortCircuit: true,
        };
      }
      if (!isFlowSource(filename) && !isHarnessStub(filename)) {
        return nextLoad(url, context);
      }
      const source = fs.readFileSync(filename, 'utf8');
      return {
        format: 'commonjs',
        source: compileFlowSource(source, filename),
        shortCircuit: true,
      };
    },
  });
}

module.exports = { install, setMockFnFactory, MODULE_REDIRECTS };
