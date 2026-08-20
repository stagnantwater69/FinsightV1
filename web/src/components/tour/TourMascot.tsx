import { useEffect, useState } from "react";
import { POSE_FALLBACK, type TourStep } from "./steps";

/**
 * Fin, as the tour guide.
 *
 * Renders the step's base pose with an optional prop badge — a small themed
 * chip carrying one of the app's own icons — composited at the pose's lower
 * corner. The badge is what makes a pose situation-specific (Fin "with" a
 * bell, a camera, a spreadsheet) without generating new character art; see
 * the mapping note in steps.tsx.
 *
 * Failure handling, in order: a pose that 404s swaps to the greeting pose;
 * if even that fails the image hides entirely and the tooltip carries on —
 * the tour must never show a broken-image glyph or stop working over an
 * asset. The image is decorative (the step text carries all information),
 * so it is `alt=""` and hidden from assistive tech, per the a11y guidance
 * for mascots that add no unique information.
 */
export function TourMascot({ mascot, size = "md" }: { mascot: TourStep["mascot"]; size?: "sm" | "md" }) {
  const [src, setSrc] = useState(mascot.pose);
  const [failed, setFailed] = useState(false);

  // A new step reuses this mounted component — reset the fallback chain.
  useEffect(() => {
    setSrc(mascot.pose);
    setFailed(false);
  }, [mascot.pose]);

  if (failed) return null;

  const Prop = mascot.prop;
  const box = size === "sm" ? "h-14 w-14" : "h-20 w-20";

  return (
    <span aria-hidden className={`relative block shrink-0 ${box}`}>
      <img
        src={src}
        alt=""
        width={512}
        height={512}
        draggable={false}
        onError={() => {
          if (src !== POSE_FALLBACK) setSrc(POSE_FALLBACK);
          else setFailed(true);
        }}
        className="h-full w-full select-none object-contain"
      />
      {Prop ? (
        <span
          className={`absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-tint-brand ring-2 ring-paper ${
            size === "sm" ? "h-5 w-5" : "h-7 w-7"
          }`}
        >
          <Prop className={size === "sm" ? "h-3 w-3 text-tone-brand" : "h-4 w-4 text-tone-brand"} />
        </span>
      ) : null}
    </span>
  );
}
