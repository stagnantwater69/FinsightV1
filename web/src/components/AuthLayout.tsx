import type { ReactNode } from "react";

/**
 * The signed-in screens: one centred card, form on the left, context panel on
 * the right.
 *
 * WHY THIS REPLACED THE FULL-BLEED SPLIT. The previous version was two
 * viewport-height columns with a dark brand panel at `p-14` and a 38px
 * headline. On a laptop that put a login form — six fields at most — inside
 * something the size of a billboard, and the form itself was the smallest
 * thing on screen. A card bounded at `max-w-5xl` keeps the page feeling like
 * a task rather than a landing page, which is what someone typing a password
 * is actually doing.
 *
 * THE PROP API IS UNCHANGED on purpose. Login, Register and RecoverPassword
 * pass the same title / subtitle / heroTitle / heroBody / points / footnote,
 * so all three keep their exact wording and their exact fields without being
 * touched. This is a re-skin, not a rewrite of the flows.
 *
 * RESPONSIVE RULE: below `lg` the context panel is dropped, not stacked. On a
 * phone the person is here to sign in, and a panel above the fold would push
 * the fields down behind a scroll. The card then collapses to the form alone
 * and its padding steps down with the viewport.
 */

/**
 * The panel illustration — a dashboard on a laptop, drawn rather than
 * imported.
 *
 * Same reasoning as the landing page's feature tiles: it is schematic enough
 * to read as a diagram rather than a screenshot, so it cannot misrepresent a
 * screen that does not exist; it stays sharp at any size; it costs a few
 * hundred bytes instead of a raster image on the critical path of the page
 * people load before they can do anything; and it is drawn in brand tokens so
 * it follows the palette.
 */
function PanelArt() {
  const C = {
    card: "#ffffff",
    line: "#e8efed",
    soft: "#c8f7ec",
    mid: "#5adcc4",
    brand: "#0e655c",
    amber: "#f5a524",
  };
  return (
    <svg viewBox="0 0 240 150" className="h-auto w-full max-w-[15rem]" role="presentation" aria-hidden>
      {/* Laptop body */}
      <rect x="26" y="14" width="188" height="112" rx="8" fill={C.card} stroke={C.line} strokeWidth="2" />
      <rect x="14" y="126" width="212" height="8" rx="4" fill={C.line} />

      {/* Sidebar */}
      <rect x="34" y="22" width="42" height="96" rx="5" fill={C.soft} opacity="0.5" />
      <rect x="40" y="30" width="26" height="5" rx="2.5" fill={C.brand} />
      {[42, 52, 62, 72].map((y) => (
        <rect key={y} x="40" y={y} width="30" height="4" rx="2" fill={C.mid} opacity="0.7" />
      ))}

      {/* Header row */}
      <rect x="84" y="26" width="54" height="6" rx="3" fill={C.brand} />
      <rect x="84" y="38" width="88" height="4" rx="2" fill={C.line} />

      {/* Bars — the dashboard's signature */}
      {[
        { x: 86, h: 26 },
        { x: 106, h: 40 },
        { x: 126, h: 32 },
        { x: 146, h: 52 },
        { x: 166, h: 36 },
        { x: 186, h: 20 },
      ].map((b) => (
        <rect key={b.x} x={b.x} y={112 - b.h} width="12" height={b.h} rx="3" fill={b.h === 52 ? C.brand : C.soft} />
      ))}

      {/* A floating record card, offset so the composition is not a flat rectangle */}
      <g>
        <rect x="150" y="46" width="66" height="34" rx="6" fill={C.card} stroke={C.line} strokeWidth="2" />
        <circle cx="163" cy="58" r="5" fill={C.amber} />
        <rect x="172" y="55" width="34" height="4" rx="2" fill={C.line} />
        <rect x="172" y="63" width="22" height="4" rx="2" fill={C.mid} />
        <rect x="158" y="70" width="48" height="4" rx="2" fill={C.line} />
      </g>
    </svg>
  );
}

function Wordmark({ tone = "ink" }: { tone?: "ink" | "brand" }) {
  return (
    <span className="flex items-center gap-2.5">
      {/* MASCOT SEAM — the owl badge mark replaces this monogram. */}
      <span
        aria-hidden
        className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-700 font-display text-sm font-extrabold text-white"
      >
        F
      </span>
      <span
        className={`font-display text-lg font-extrabold tracking-[-0.02em] ${
          tone === "brand" ? "text-brand-900" : "text-ink-900"
        }`}
      >
        Fin<span className="text-brand-700">Sight</span>
      </span>
    </span>
  );
}

export function AuthLayout({
  title,
  subtitle,
  heroTitle = "From scattered records to clearer decisions.",
  heroBody,
  points,
  footnote = "FinSight supports decision awareness. It is not an accounting, tax, payroll, POS, or banking system.",
  children,
}: {
  title: string;
  subtitle?: string;
  heroTitle?: string;
  heroBody?: ReactNode;
  points?: string[];
  footnote?: string;
  children: ReactNode;
}) {
  return (
    // Pinned to Classic for the same reason the landing page is: these are
    // signed-out pages, and the app theme is a preference about the PRODUCT,
    // not about the way in to it. Scoped to this subtree, so the owner's
    // stored choice survives for the app itself.
    <div
      data-theme="classic"
      className="flex min-h-screen items-center justify-center bg-paper-50 px-4 py-6 sm:px-6 sm:py-10"
    >
      <div className="w-full max-w-5xl overflow-hidden rounded-2xl border border-paper-200 bg-paper shadow-lg">
        {/* `lg:grid-cols-2` with min-w-0 tracks: without the minmax(0,...) a
            long unbroken string in a field could force a column wider than its
            share and push the card into a horizontal scroll. */}
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* ------------------------------ form ------------------------------ */}
          <div className="px-5 py-8 sm:px-9 sm:py-10">
            <Wordmark />

            <div className="mt-7">
              <h1 className="font-display text-2xl font-bold tracking-tight text-ink-900">{title}</h1>
              {subtitle ? <p className="mt-1.5 text-sm text-ink-500">{subtitle}</p> : null}
            </div>

            <div className="mt-6">{children}</div>
          </div>

          {/* --------------------------- context panel --------------------------- */}
          <aside className="hidden flex-col justify-center gap-6 border-l border-paper-200 bg-paper-100/60 p-9 lg:flex">
            <div className="flex justify-center">
              <PanelArt />
            </div>

            <div>
              <h2 className="font-display text-xl font-bold leading-snug text-ink-900">{heroTitle}</h2>
              {heroBody ? <p className="mt-2.5 text-sm leading-relaxed text-ink-600">{heroBody}</p> : null}

              {points?.length ? (
                <ul className="mt-5 flex flex-col gap-2.5">
                  {points.map((p) => (
                    <li key={p} className="flex items-start gap-2.5 text-sm text-ink-700">
                      <span
                        aria-hidden
                        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-700 text-[10px] font-bold text-white"
                      >
                        ✓
                      </span>
                      {p}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <p className="border-t border-paper-200 pt-4 text-xs leading-relaxed text-ink-400">{footnote}</p>
          </aside>
        </div>
      </div>
    </div>
  );
}
