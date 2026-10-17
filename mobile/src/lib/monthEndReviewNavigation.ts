type MonthEndReviewNavigation = {
  navigate(name: string, params?: object): void;
  getState(): { index: number };
  goBack(): void;
  popToTop(): void;
  reset(state: { index: number; routes: Array<{ name: string }> }): void;
  setParams(params: { from: undefined }): void;
};

export function openMonthEndReviewFromRecovery(navigation: Pick<MonthEndReviewNavigation, "navigate">) {
  navigation.navigate("More", {
    screen: "MonthEndReview",
    initial: false,
    params: { from: "RecoveryTarget" },
  });
}

export function returnFromMonthEndReview(navigation: MonthEndReviewNavigation, from?: string) {
  navigation.setParams({ from: undefined });
  if (from === "RecoveryTarget") {
    if (navigation.getState().index > 0) navigation.popToTop();
    else navigation.reset({ index: 0, routes: [{ name: "MoreHome" }] });
    navigation.navigate("Insights", { screen: "RecoveryTarget" });
  } else if (navigation.getState().index > 0) navigation.goBack();
  else navigation.reset({ index: 0, routes: [{ name: "MoreHome" }] });
}
