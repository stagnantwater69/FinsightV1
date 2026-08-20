import type { ReactNode } from "react";

/**
 * Empty states as invitations, not dead ends.
 *
 * Every empty state in the app goes through here so they read consistently:
 * a plain-language line about what isn't there yet, then the single next
 * action. Never "No data found." — that tells an owner nothing and offers
 * nothing.
 */
export function EmptyState({
  title,
  children,
  action,
  icon = "＋",
  image,
  imageAlt = "",
  compact = false,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: string;
  /**
   * A mascot pose, which takes over from `icon` when supplied — the same seam
   * mobile's `ui.tsx` EmptyState has, so a state illustrated on one client can
   * be illustrated on the other without a second component.
   *
   * Pass a path under `/mascot/`; look the pose up in
   * `docs/mascot-scenario-library.md` rather than picking one by eye. Ignored
   * by the `compact` variant, which is a line of text inside an existing panel
   * and has no room for art.
   */
  image?: string;
  /**
   * Left empty by default because the art is decorative in this slot: `title`
   * and the body copy already say what the state is, so a screen reader
   * announcing the pose as well would be repeating the same fact twice.
   */
  imageAlt?: string;
  /** Inline variant for inside an existing panel, rather than a full page. */
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="py-6 text-center">
        <p className="text-sm font-medium text-ink-700">{title}</p>
        {children ? <p className="mx-auto mt-1 max-w-sm text-sm text-ink-500">{children}</p> : null}
        {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-paper p-8 text-center border border-paper-200 shadow-sm">
      {image ? (
        <img
          src={image}
          alt={imageAlt}
          width={96}
          height={96}
          aria-hidden={imageAlt === "" ? true : undefined}
          className="mx-auto mb-4 h-24 w-24 select-none"
          draggable={false}
        />
      ) : (
        <span
          aria-hidden
          className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-tint-brand text-xl text-brand-600"
        >
          {icon}
        </span>
      )}
      <h2 className="font-display text-base font-semibold text-ink-900">{title}</h2>
      {children ? <p className="mx-auto mt-2 max-w-md text-sm text-ink-500">{children}</p> : null}
      {action ? <div className="mt-6 flex flex-wrap justify-center gap-3">{action}</div> : null}
    </div>
  );
}

/**
 * Goal-Gradient Effect — a progress nudge for first-run flows.
 *
 * People push harder toward a goal that visibly gets closer, so a brand-new
 * business profile is shown how far along setup it is rather than being handed
 * a series of unrelated empty screens. Showing the step count is the whole
 * point: "2 of 3" implies a reachable end, "add a category" doesn't.
 */
export function SetupProgress({
  steps,
}: {
  steps: { label: string; done: boolean; href?: string }[];
}) {
  const done = steps.filter((s) => s.done).length;
  const total = steps.length;
  const complete = done === total;

  if (complete) return null;

  return (
    <div className="mb-6 rounded-2xl bg-tint-brand p-4 border border-paper-200">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink-900">
          {done} of {total} steps to your first insight
        </p>
        <p className="figure text-xs text-brand-700">
          {done}/{total}
        </p>
      </div>

      <div className="mt-2 flex gap-1.5" role="presentation">
        {steps.map((s, i) => (
          <div
            key={s.label}
            className={`h-1.5 flex-1 rounded-full transition-colors ${i < done ? "bg-brand-500" : "bg-brand-200"}`}
          />
        ))}
      </div>

      <ol className="mt-3 space-y-1.5">
        {steps.map((s) => (
          <li key={s.label} className="flex items-start gap-2 text-sm">
            <span
              aria-hidden
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                s.done ? "bg-brand-600 text-white" : "bg-brand-200 text-brand-700"
              }`}
            >
              {s.done ? "✓" : ""}
            </span>
            <span className={s.done ? "text-ink-400 line-through" : "text-ink-700"}>{s.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
