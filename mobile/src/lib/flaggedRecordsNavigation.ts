import type { RecordItem } from "./types";

type ReviewNavigation = {
  navigate(name: string, params?: object): void;
  getState(): { index: number };
  goBack(): void;
  reset(state: { index: number; routes: Array<{ name: string }> }): void;
};

/**
 * Expenses → Review: the one place flagged records are reviewed on mobile.
 * Every "records need a check" link (Home, Records, a CSV import, Ask
 * FinSight) lands here.
 */
export function openReviewTab(navigation: Pick<ReviewNavigation, "navigate">) {
  navigation.navigate("Insights", { screen: "ExpenseBehavior", params: { section: "alerts" } });
}

/** One flagged record on its own, from a Review tab row. */
export function openFlagDetail(navigation: Pick<ReviewNavigation, "navigate">, record: RecordItem) {
  navigation.navigate("Records", {
    screen: "FlagDetail",
    initial: false,
    params: { record },
  });
}

/**
 * Leaves a flagged record for the Review tab it was opened from.
 *
 * The record is popped off the Records stack first (or the stack restored to
 * its list), so tapping the Records tab later opens the list rather than a
 * record that has since been decided.
 */
export function returnFromFlagDetail(navigation: ReviewNavigation) {
  if (navigation.getState().index > 0) navigation.goBack();
  else navigation.reset({ index: 0, routes: [{ name: "RecordsList" }] });
  openReviewTab(navigation);
}
