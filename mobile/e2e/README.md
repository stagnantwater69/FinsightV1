# Mobile E2E smoke path — **AUTHORED, NEVER EXECUTED**

> **Read this before quoting anything in this directory as evidence.**
>
> The flows here have **never been run**. Not once, not partially. They were
> written against the app's source on a Linux CI box with no Android SDK, no
> `adb`, no emulator, no iOS Simulator, and no Maestro binary installed. They
> are a *starting point for someone with a device*, not coverage.
>
> Nothing in this directory may be counted towards the Phase 4 release gate
> until it has been run on a real device and the run recorded below.

## What it covers (ticket §9.13)

`flows/smoke.yaml` walks the journey the plan names:

```
splash → login → onboarding → tabs → Spending Impact → logout
```

## Why it is unrun rather than absent

Maestro drives a real app on a real device or emulator. This environment has
none:

```
$ which adb emulator maestro xcrun java
(nothing)
```

Authoring it anyway is a judgement call with a real downside: **every selector
in an unrun flow is a guess.** Selectors that look right in source can still
fail on device — a label may be rendered inside a component that does not
expose it as text, a tab bar item may match a different node, a screen may need
a scroll before an element is hittable. Expect the first real run to require
edits.

To reduce that risk as far as is honestly possible without a device,
`tests/e2eSelectors.test.ts` asserts that **every text selector used by the
flow exists as a literal string in `mobile/src`**. That is a drift guard, not a
pass: it proves the flow is not referring to copy that no longer exists. It
proves nothing about whether the flow runs.

## Running it, when a device is available

```bash
# Install Maestro (https://maestro.mobile.dev)
curl -Ls "https://get.maestro.mobile.dev" | bash

# Start the app on a connected device/emulator, then:
maestro test mobile/e2e/flows/smoke.yaml \
  -e EMAIL="a-real-test-account@example.com" \
  -e PASSWORD="…"
```

The flow needs a **seeded account that has not completed onboarding**, because
the onboarding leg is part of the path. A fully set-up account will skip
straight to the tabs and the onboarding assertions will fail — correctly.

## Run log

| Date | Device / OS | Maestro version | Result | Notes |
| ---- | ----------- | --------------- | ------ | ----- |
| —    | —           | —               | **never run** | Authored only. |
