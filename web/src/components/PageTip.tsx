import { useState, type ReactNode } from "react";
import { useAuthOptional } from "../context/AuthContext";
import { dismissTip, isNewAccount, readDismissedTips, type PageTipId } from "../lib/pageTips";
import { Button } from "./Button";
import { TourMascot } from "./tour/TourMascot";
import { POSE_FALLBACK } from "./tour/steps";

/**
 * A one-time tip shown the first time a new owner reaches a page whose purpose
 * is not obvious from the page itself. Inline under the page heading rather
 * than an overlay: the page stays usable, and nothing covers what the tip
 * describes. Dismissed tips stay dismissed for that account on this device;
 * see lib/pageTips.ts for who sees them at all.
 */
export function PageTip({ id, title, children }: { id: PageTipId; title: string; children: ReactNode }) {
  const profile = useAuthOptional()?.profile;
  const userId = profile?.id;
  const [dismissed, setDismissed] = useState(false);

  // Worked out on every render, so a profile that arrives late still counts.
  if (userId == null || dismissed || !isNewAccount(profile?.createdAt) || readDismissedTips(userId).includes(id)) {
    return null;
  }

  const headingId = `page-tip-${id}`;
  return (
    <section
      aria-labelledby={headingId}
      className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl bg-tint-brand p-4 ring-1 ring-paper-200"
    >
      <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
        <TourMascot mascot={{ pose: POSE_FALLBACK }} size="sm" />
        <div className="min-w-0">
          <h2 id={headingId} className="text-[15px] font-semibold text-ink-900">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-ink-700">{children}</p>
        </div>
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          dismissTip(userId, id);
          setDismissed(true);
        }}
      >
        Got it
      </Button>
    </section>
  );
}
