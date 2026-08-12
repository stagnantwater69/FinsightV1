import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches a render-time error and shows it, instead of a blank page.
 *
 * React unmounts the whole tree when a render throws. Without a boundary that
 * leaves an EMPTY `<div id="root">` — a white screen carrying no message, no
 * stack and no hint about which component failed, on every route at once. The
 * error is only in the browser console, which an owner will never open, and
 * which a developer only finds after ruling out the server, the build and the
 * network first.
 *
 * So this exists to make a failure legible rather than to recover from it. It
 * deliberately does NOT retry or swallow: the error text stays on screen, and
 * `console.error` still runs so the stack survives for whoever is debugging.
 *
 * A class component because that is the only form React supports for this —
 * there is no hook equivalent of componentDidCatch.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept alongside React's own logging: the component stack is the part that
    // actually identifies WHERE it broke, and it is not in error.stack.
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-paper-50 p-6">
        <div className="w-full max-w-lg rounded-2xl border border-paper-200 bg-paper p-6">
          <h1 className="text-lg font-semibold text-ink-900">Something broke on this page</h1>
          <p className="mt-2 text-sm text-ink-600">
            This is a bug in FinSight, not something you did. Reloading usually gets you moving again — the
            details below are what a developer needs to fix it.
          </p>
          <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl bg-paper-100 p-3 text-xs text-ink-700">
            {error.message}
            {error.stack ? `\n\n${error.stack}` : null}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-800"
          >
            Reload the page
          </button>
        </div>
      </div>
    );
  }
}
