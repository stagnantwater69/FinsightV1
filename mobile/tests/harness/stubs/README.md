# Render-harness stubs

Plain-JS stand-ins for native-backed modules, loaded by
`tests/harness/rnRequireHook.cjs` through Node's CommonJS loader (so they are
deliberately *not* TypeScript — they are transformed with Sucrase's
`flow`/`jsx` transforms only, not `typescript`).

Each stub keeps the element in the rendered tree along with whatever
accessibility props the call site passed, so assertions like "this icon is
hidden from assistive technology" remain meaningful.

**These stubs are not a device.** They make component trees mountable and
queryable. They give no coverage of camera, permission, or app-lifecycle
behavior — that still requires physical-device verification.
