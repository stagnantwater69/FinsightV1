import type { MouseEvent } from "react";
import {
  BookmarkCheck,
  CircleGauge,
  History,
  ListChecks,
  SlidersHorizontal,
  Target,
} from "lucide-react";
import { focusSection } from "./recoveryLabels";
import { SectionNav, type SectionNavItem } from "../../components/SectionNav";
import { EXPAND_SCENARIO_EVENT } from "./RecoveryPlanning";

export function RecoverySectionNav({
  showCheckpoints,
  showDailyPlan,
  showPlanning,
  hasSavedPlan,
}: {
  showCheckpoints: boolean;
  showDailyPlan: boolean;
  showPlanning: boolean;
  hasSavedPlan: boolean;
}) {
  const items: SectionNavItem[] = [
    { href: "#recovery-overview", label: "Overview", icon: CircleGauge },
    ...(showDailyPlan
      ? [
          {
            href: "#remaining-recovery-target",
            label: "Daily plan",
            icon: Target,
          },
        ]
      : []),
    ...(showCheckpoints
      ? [
          {
            href: "#recovery-checkpoints",
            label: "Checkpoints",
            icon: ListChecks,
          },
        ]
      : []),
    ...(showPlanning
      ? [
          // Plans and scenarios change the current monthly baseline, so they
          // stay out of weekly and historical views.
          hasSavedPlan
            ? {
                href: "#recovery-saved-plan",
                label: "Saved plan",
                icon: BookmarkCheck,
              }
            : {
                href: "#recovery-scenario",
                label: "Save a plan",
                icon: BookmarkCheck,
                onClick: (e: MouseEvent) => {
                  e.preventDefault();
                  window.dispatchEvent(new Event(EXPAND_SCENARIO_EVENT));
                  focusSection("recovery-scenario");
                },
              },
          {
            href: "#recovery-scenario",
            label: "Scenario",
            icon: SlidersHorizontal,
          },
        ]
      : []),
    { href: "#daily-coverage", label: "Daily history", icon: History },
  ];

  return <SectionNav ariaLabel="Recovery target sections" items={items} />;
}
