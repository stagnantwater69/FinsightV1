import type { ReductionOpportunity, ReductionOpportunityResponse } from "./types";

/**
 * The Dashboard's gate for its one compact reduction-opportunity card — plan
 * §13.1/§15 Phase 5: "Do not show a top card when confidence is limited or
 * history is insufficient."
 *
 * Pulled out of DashboardScreen.tsx as a pure function so the gate itself is
 * unit-testable without mounting the whole screen — the same reasoning
 * spendingImpactForm.ts and reductionSimulationForm.ts already follow for
 * their own client-side rules.
 */
export function selectTopOpportunity(response: ReductionOpportunityResponse | null): ReductionOpportunity | null {
  if (!response) return null;
  if (response.dataQuality.status === "insufficient") return null;
  const top = response.opportunities[0];
  if (!top) return null;
  if (top.confidence === "limited") return null;
  return top;
}
