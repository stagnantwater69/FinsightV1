/**
 * The feature grid: an illustration panel above a title and one line of copy.
 *
 * WHY THESE ARE DRAWN, NOT PHOTOGRAPHED OR GENERATED. Each panel is a small
 * abstraction of the screen the feature actually produces — a receipt being
 * read, a donut of category spending, the recovery meter. Three reasons that
 * beats dropping in eight raster images:
 *
 *   - it cannot misrepresent the product. A generated illustration of "a
 *     dashboard" invents a dashboard nobody can open. These are schematic
 *     enough to read as diagrams rather than as screenshots, so they promise
 *     a shape, not a specific screen.
 *   - they stay sharp at any size and cost a few hundred bytes each, against
 *     hundreds of kilobytes for eight images on a page aimed at people on
 *     phone data.
 *   - they are drawn in brand tokens, so they move with the palette instead of
 *     being baked at the moment someone exported them.
 *
 * Every panel is the same 200x120 viewBox on the same tinted background, which
 * is what makes eight different drawings read as one set.
 */

/** The shared panel. Fixed aspect so the grid rows line up regardless of art. */
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-paper-200 bg-paper-100/70 p-4">
      <svg viewBox="0 0 200 120" className="h-full w-full" role="presentation" aria-hidden>
        {children}
      </svg>
    </div>
  );
}

// Token hexes, inlined because SVG `fill` cannot read a Tailwind class. Kept
// to the brand ramp so these never drift into colours the palette doesn't own.
const C = {
  card: "#ffffff",
  line: "#e8efed",
  soft: "#c8f7ec",
  mid: "#5adcc4",
  brand: "#0e655c",
  deep: "#0f423f",
  amber: "#f5a524",
  ink: "#9fb0ae",
};

function ArtRecord() {
  return (
    <>
      <rect x="24" y="14" width="152" height="92" rx="8" fill={C.card} stroke={C.line} />
      <rect x="36" y="28" width="60" height="7" rx="3.5" fill={C.brand} />
      {[46, 60, 74, 88].map((y, i) => (
        <g key={y}>
          <rect x="36" y={y} width={72 - i * 8} height="6" rx="3" fill={C.line} />
          <rect x={i % 2 === 0 ? 132 : 138} y={y} width={i % 2 === 0 ? 32 : 26} height="6" rx="3" fill={i === 1 ? C.mid : C.line} />
        </g>
      ))}
    </>
  );
}

function ArtReceipt() {
  return (
    <>
      <path d="M52 12h64a6 6 0 016 6v78l-9-6-9 6-9-6-9 6-9-6-9 6-9-6-9 6V18a6 6 0 016-6z" fill={C.card} stroke={C.line} />
      <rect x="62" y="26" width="44" height="6" rx="3" fill={C.brand} />
      {[40, 52, 64].map((y) => (
        <g key={y}>
          <rect x="62" y={y} width="28" height="5" rx="2.5" fill={C.line} />
          <rect x="98" y={y} width="18" height="5" rx="2.5" fill={C.line} />
        </g>
      ))}
      <rect x="62" y="78" width="54" height="6" rx="3" fill={C.mid} />
      {/* The scan frame: what the phone is doing to it. */}
      <g stroke={C.brand} strokeWidth="3" fill="none" strokeLinecap="round">
        <path d="M36 34V22h12M164 34V22h-12M36 86v12h12M164 86v12h-12" />
      </g>
    </>
  );
}

function ArtImport() {
  return (
    <>
      <rect x="20" y="22" width="76" height="76" rx="8" fill={C.card} stroke={C.line} />
      <rect x="30" y="32" width="56" height="6" rx="3" fill={C.ink} />
      {[46, 58, 70, 82].map((y) => (
        <rect key={y} x="30" y={y} width="56" height="5" rx="2.5" fill={C.line} />
      ))}
      <rect x="104" y="22" width="76" height="76" rx="8" fill={C.card} stroke={C.line} />
      <rect x="114" y="32" width="56" height="6" rx="3" fill={C.brand} />
      {[46, 58, 70, 82].map((y) => (
        <rect key={y} x="114" y={y} width="56" height="5" rx="2.5" fill={C.soft} />
      ))}
      <g stroke={C.brand} strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M92 60h16" />
        <path d="M102 54l6 6-6 6" />
      </g>
    </>
  );
}

function ArtInsights() {
  return (
    <>
      <rect x="16" y="14" width="168" height="92" rx="8" fill={C.card} stroke={C.line} />
      {[
        { x: 32, h: 30 },
        { x: 56, h: 48 },
        { x: 80, h: 38 },
        { x: 104, h: 60 },
        { x: 128, h: 44 },
      ].map((b) => (
        <rect key={b.x} x={b.x} y={92 - b.h} width="14" height={b.h} rx="4" fill={b.h === 60 ? C.brand : C.soft} />
      ))}
      <rect x="152" y="32" width="20" height="60" rx="4" fill={C.mid} />
    </>
  );
}

function ArtRecovery() {
  return (
    <>
      <rect x="20" y="18" width="160" height="84" rx="8" fill={C.card} stroke={C.line} />
      {/* A gauge arc: the recovery meter's signature shape. */}
      <path d="M52 82a48 48 0 0196 0" fill="none" stroke={C.line} strokeWidth="12" strokeLinecap="round" />
      <path d="M52 82a48 48 0 0166-45" fill="none" stroke={C.brand} strokeWidth="12" strokeLinecap="round" />
      <circle cx="100" cy="82" r="6" fill={C.deep} />
      <path d="M100 82l26-20" stroke={C.amber} strokeWidth="5" strokeLinecap="round" />
    </>
  );
}

function ArtAsk() {
  return (
    <>
      <path d="M24 24h100a8 8 0 018 8v34a8 8 0 01-8 8H60l-18 14V74h-18a8 8 0 01-8-8V32a8 8 0 018-8z" fill={C.card} stroke={C.line} />
      {[38, 50].map((y, i) => (
        <rect key={y} x="36" y={y} width={i === 0 ? 76 : 54} height="6" rx="3" fill={C.line} />
      ))}
      <path d="M96 62h72a8 8 0 018 8v26a8 8 0 01-8 8h-52l-12 10V104h-8a8 8 0 01-8-8V70a8 8 0 018-8z" fill={C.brand} />
      {[76, 88].map((y, i) => (
        <rect key={y} x="108" y={y} width={i === 0 ? 52 : 36} height="6" rx="3" fill={C.soft} opacity={i === 0 ? 1 : 0.7} />
      ))}
    </>
  );
}

function ArtFlagged() {
  return (
    <>
      <rect x="24" y="14" width="152" height="92" rx="8" fill={C.card} stroke={C.line} />
      {[28, 46, 64, 82].map((y, i) => (
        <g key={y}>
          <rect x="38" y={y} width="72" height="6" rx="3" fill={C.line} />
          <rect x="126" y={y} width="30" height="6" rx="3" fill={i === 2 ? C.amber : C.line} />
        </g>
      ))}
      {/* The flag on the one that is out of line. */}
      <circle cx="30" cy="67" r="9" fill={C.amber} />
      <rect x="29" y="62" width="2.5" height="6" rx="1.25" fill={C.card} />
      <circle cx="30.25" cy="71" r="1.5" fill={C.card} />
    </>
  );
}

function ArtAnywhere() {
  return (
    <>
      <rect x="18" y="20" width="112" height="70" rx="6" fill={C.card} stroke={C.line} />
      <rect x="28" y="30" width="40" height="6" rx="3" fill={C.brand} />
      {[44, 56].map((y) => (
        <rect key={y} x="28" y={y} width="92" height="5" rx="2.5" fill={C.line} />
      ))}
      <rect x="28" y="68" width="60" height="12" rx="4" fill={C.soft} />
      <rect x="10" y="94" width="128" height="6" rx="3" fill={C.line} />
      <rect x="136" y="34" width="46" height="72" rx="8" fill={C.card} stroke={C.line} />
      <rect x="144" y="44" width="30" height="5" rx="2.5" fill={C.brand} />
      {[56, 66].map((y) => (
        <rect key={y} x="144" y={y} width="30" height="4" rx="2" fill={C.line} />
      ))}
      <rect x="144" y="80" width="30" height="16" rx="4" fill={C.mid} />
    </>
  );
}

const ART = {
  record: <ArtRecord />,
  receipt: <ArtReceipt />,
  import: <ArtImport />,
  insights: <ArtInsights />,
  recovery: <ArtRecovery />,
  ask: <ArtAsk />,
  flagged: <ArtFlagged />,
  anywhere: <ArtAnywhere />,
};

export type FeatureArt = keyof typeof ART;

export interface FeatureTile {
  art: FeatureArt;
  title: string;
  body: string;
}

export const FEATURE_TILES: FeatureTile[] = [
  { art: "record", title: "Record Transactions", body: "Add sales, purchases & expenses" },
  { art: "receipt", title: "Scan Receipts", body: "Photograph it and the details fill in" },
  { art: "import", title: "Import a Spreadsheet", body: "Bring in records you already keep" },
  { art: "insights", title: "Business Insights", body: "See where the money actually went" },
  { art: "recovery", title: "Recovery Target", body: "Know what today needs to look like" },
  { art: "ask", title: "Ask FinSight", body: "Plain answers from your own figures" },
  { art: "flagged", title: "Spot the Unusual", body: "Catch a purchase that is out of line" },
  { art: "anywhere", title: "Phone & Web", body: "The same records on both" },
];

export function FeatureTiles({ tiles = FEATURE_TILES }: { tiles?: FeatureTile[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-5 gap-y-8 lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.title} className="text-center">
          <Panel>{ART[t.art]}</Panel>
          <h3 className="mt-4 font-display text-sm font-bold text-ink-900 sm:text-base">{t.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-500 sm:text-sm">{t.body}</p>
        </div>
      ))}
    </div>
  );
}
