import { useRevealed } from "./grid";

/**
 * The FinSight "Financial Trail" — the page's one branded background system.
 *
 * A thin mint cash-flow line carrying three kinds of node:
 *   - filled mint circle    a recorded transaction
 *   - outlined mint circle  an AI-reviewed transaction
 *   - small gold circle     an alert / important insight
 *
 * plus supporting motifs (receipt silhouettes with OCR corners, chart-grid
 * geometry, a simplified "F" watermark, a shield-and-receipt mark for the
 * privacy section). Every variant is a single inline SVG — no raster assets,
 * no per-node DOM — and every instance is decorative: `aria-hidden`, never
 * focusable, and kept between 0.03 and 0.10 opacity by its caller.
 *
 * The `flow` variant draws itself when it first enters the viewport, using
 * `pathLength=1` + the shared `trail-draw` keyframe. It ends at the natural
 * state, so the global reduced-motion collapse simply shows it fully drawn.
 */

type Variant = "flow" | "grid" | "receipt" | "watermark" | "shield" | "dots" | "peso";

const STROKE = "#A9DEC9"; // landing mint — literal because SVG attrs can't read Tailwind classes
const GOLD = "#F5AD19";

function FlowTrail({ animate }: { animate: boolean }) {
  return (
    <>
      <path
        d="M0 90 C 90 90, 120 34, 210 40 S 360 96, 460 66 S 620 10, 720 30"
        fill="none"
        stroke={STROKE}
        strokeWidth="1.5"
        pathLength={1}
        strokeDasharray={1}
        className={animate ? "animate-trail-draw" : undefined}
        style={animate ? undefined : { strokeDashoffset: 0 }}
      />
      {/* recorded (filled), AI-reviewed (outlined), alert (gold) */}
      <circle cx="210" cy="40" r="4" fill={STROKE} />
      <circle cx="460" cy="66" r="4" fill="none" stroke={STROKE} strokeWidth="1.5" />
      <circle cx="620" cy="24" r="3" fill={GOLD} />
      <circle cx="90" cy="76" r="4" fill="none" stroke={STROKE} strokeWidth="1.5" />
    </>
  );
}

function GridMotif() {
  return (
    <>
      {[0, 30, 60, 90, 120].map((y) => (
        <line key={`h${y}`} x1="0" y1={y} x2="720" y2={y} stroke={STROKE} strokeWidth="1" />
      ))}
      {[0, 90, 180, 270, 360, 450, 540, 630, 720].map((x) => (
        <line key={`v${x}`} x1={x} y1="0" x2={x} y2="120" stroke={STROKE} strokeWidth="1" />
      ))}
    </>
  );
}

function ReceiptMotif() {
  return (
    <>
      {/* receipt silhouette with a zig-zag foot */}
      <path
        d="M20 8 h80 v96 l-10 -8 l-10 8 l-10 -8 l-10 8 l-10 -8 l-10 8 l-10 -8 l-10 8 Z"
        fill="none"
        stroke={STROKE}
        strokeWidth="1.5"
      />
      {/* thermal-print dotted lines */}
      {[28, 44, 60, 76].map((y) => (
        <line
          key={y}
          x1="32"
          y1={y}
          x2="88"
          y2={y}
          stroke={STROKE}
          strokeWidth="1.5"
          strokeDasharray="2 5"
        />
      ))}
      {/* OCR scanning corners */}
      <path d="M8 24 v-20 h20" fill="none" stroke={STROKE} strokeWidth="2" />
      <path d="M112 24 v-20 h-20" fill="none" stroke={STROKE} strokeWidth="2" />
      <path d="M8 92 v20 h20" fill="none" stroke={STROKE} strokeWidth="2" />
      <path d="M112 92 v20 h-20" fill="none" stroke={STROKE} strokeWidth="2" />
    </>
  );
}

function WatermarkF() {
  // The simplified FinSight "F": two horizontal strokes off one stem.
  return (
    <>
      <path d="M30 110 V14 h64" fill="none" stroke={STROKE} strokeWidth="10" strokeLinecap="round" />
      <path d="M30 58 h46" fill="none" stroke={STROKE} strokeWidth="10" strokeLinecap="round" />
    </>
  );
}

function ShieldMotif() {
  return (
    <>
      <path
        d="M60 6 l44 16 v34 c0 28 -20 48 -44 58 c-24 -10 -44 -30 -44 -58 v-34 Z"
        fill="none"
        stroke={STROKE}
        strokeWidth="2.5"
      />
      {/* the receipt inside the shield */}
      <path
        d="M44 34 h32 v42 l-8 -6 l-8 6 l-8 -6 l-8 6 Z"
        fill="none"
        stroke={STROKE}
        strokeWidth="2"
      />
      <line x1="50" y1="46" x2="70" y2="46" stroke={STROKE} strokeWidth="2" strokeDasharray="2 4" />
      <line x1="50" y1="56" x2="70" y2="56" stroke={STROKE} strokeWidth="2" strokeDasharray="2 4" />
    </>
  );
}

function PesoMotif() {
  // A circled peso mark — the coin the reference scatters near section edges.
  return (
    <>
      <circle cx="60" cy="60" r="50" fill="none" stroke={STROKE} strokeWidth="4" />
      <circle cx="60" cy="60" r="38" fill="none" stroke={STROKE} strokeWidth="2" strokeDasharray="3 6" />
      <text
        x="60"
        y="76"
        textAnchor="middle"
        fontSize="46"
        fontWeight="700"
        fill={STROKE}
        fontFamily="'IBM Plex Mono', monospace"
      >
        ₱
      </text>
    </>
  );
}

function DotsMotif() {
  const dots: React.ReactNode[] = [];
  for (let x = 6; x <= 114; x += 18) {
    for (let y = 6; y <= 114; y += 18) {
      dots.push(<circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" fill={STROKE} />);
    }
  }
  return <>{dots}</>;
}

const VIEWBOX: Record<Variant, string> = {
  flow: "0 0 720 120",
  grid: "0 0 720 120",
  receipt: "0 0 120 120",
  watermark: "0 0 120 120",
  shield: "0 0 120 120",
  dots: "0 0 120 120",
  peso: "0 0 120 120",
};

/**
 * One decorative trail element. Size and opacity are the caller's job via
 * `className` (keep opacity within 0.03–0.10; never behind important text).
 */
export function FinancialTrail({ variant, className = "" }: { variant: Variant; className?: string }) {
  const { ref, revealed } = useRevealed<SVGSVGElement>();
  return (
    <svg
      ref={ref}
      aria-hidden
      focusable="false"
      viewBox={VIEWBOX[variant]}
      preserveAspectRatio={variant === "flow" || variant === "grid" ? "none" : "xMidYMid meet"}
      className={`pointer-events-none select-none ${className}`}
    >
      {variant === "flow" ? <FlowTrail animate={revealed} /> : null}
      {variant === "grid" ? <GridMotif /> : null}
      {variant === "receipt" ? <ReceiptMotif /> : null}
      {variant === "watermark" ? <WatermarkF /> : null}
      {variant === "shield" ? <ShieldMotif /> : null}
      {variant === "dots" ? <DotsMotif /> : null}
      {variant === "peso" ? <PesoMotif /> : null}
    </svg>
  );
}

/** A soft mint radial glow to sit behind hero/workflow/feature visuals. */
export function MintGlow({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute rounded-full bg-landing-mint-light blur-3xl ${className}`}
    />
  );
}

/**
 * A shallow curved transition between two light sections. Rendered as the
 * FIRST child of the lower section: the fill is the color of the section
 * ABOVE, arcing down into the new background so consecutive bands read as
 * one continuous surface instead of hard-cut blocks.
 *
 * `from` names a landing CSS variable rather than a literal hex, so the arc
 * keeps matching its neighbour when the landing dark theme swaps that
 * variable's value (see index.css `[data-landing-theme="dark"]`).
 */
const CURVE_FILL: Record<"cream" | "surface" | "mint-pale", string> = {
  cream: "var(--landing-cream)",
  surface: "var(--landing-surface)",
  "mint-pale": "var(--landing-mint-pale)",
};

export function CurveDivider({
  from,
  className = "",
}: {
  from: "cream" | "surface" | "mint-pale";
  className?: string;
}) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 1440 48"
      preserveAspectRatio="none"
      className={`pointer-events-none block h-6 w-full select-none sm:h-10 ${className}`}
    >
      <path d="M0 0 H1440 V10 C 1050 48, 390 48, 0 10 Z" fill={`rgb(${CURVE_FILL[from]})`} />
    </svg>
  );
}
