import { useTourOptional } from "../../context/TourContext";
import { Button } from "../Button";
import { POSE_FALLBACK } from "./steps";
import { TourMascot } from "./TourMascot";

/**
 * The dashboard's "take the tour?" card, shown to an account that has never
 * toured instead of opening the overlay over it unasked. TourProvider decides
 * when it is offered (same gate the old auto-start used); this only renders
 * the choice. Inline rather than floating, so it never covers the dashboard
 * or the Ask FinSight button.
 */
export function TourInvite() {
  const tour = useTourOptional();
  if (!tour?.offered) return null;

  return (
    <section
      aria-labelledby="tour-invite-title"
      className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-paper-200 bg-paper p-4 shadow-sm"
    >
      <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
        <TourMascot mascot={{ pose: POSE_FALLBACK }} size="sm" />
        <div className="min-w-0">
          <h2 id="tour-invite-title" className="text-[15px] font-semibold text-ink-900">
            New here? Take a quick look around
          </h2>
          <p className="mt-0.5 text-sm text-ink-600">
            Fin points out where to record sales and expenses and where your numbers show up. You can leave at any
            point.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="secondary" onClick={tour.decline}>
          Not now
        </Button>
        <Button size="sm" variant="brand" onClick={tour.accept}>
          Show me around
        </Button>
      </div>
    </section>
  );
}
