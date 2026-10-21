/*
 * Crash reports to Sentry, only when the build has VITE_SENTRY_DSN. Without
 * it nothing loads and nothing is sent.
 *
 * The SDK lives in its own chunk (lib/sentry.ts), fetched after the app has
 * started, so it adds nothing to first paint or to the bundle budget's
 * entry chunk. An error raised before it arrives is still reported: the call
 * waits for the chunk.
 */

type SentryModule = typeof import("./sentry");

const dsn: string | undefined = import.meta.env.VITE_SENTRY_DSN;
let loading: Promise<SentryModule> | null = null;

function load(): Promise<SentryModule> | null {
  if (!dsn) return null;
  loading ??= import("./sentry").then((module) => {
    module.start(dsn);
    return module;
  });
  return loading;
}

export function startErrorReporting(): void {
  void load()?.catch(() => undefined);
}

export function reportError(error: unknown, tags: Record<string, string> = {}): void {
  void load()
    ?.then((module) => module.capture(error, tags))
    .catch(() => undefined);
}
