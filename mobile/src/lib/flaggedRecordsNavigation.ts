type ReviewNavigation = {
  navigate(name: string, params?: object): void;
  getState(): { index: number };
  goBack(): void;
  reset(state: { index: number; routes: Array<{ name: string }> }): void;
  setParams(params: { from: undefined }): void;
};

export function openFlaggedRecords(navigation: Pick<ReviewNavigation, "navigate">, from: "ExpenseBehavior" | "Dashboard") {
  navigation.navigate("Records", {
    screen: "FlaggedRecords",
    initial: false,
    params: { from },
  });
}

export function returnFromFlaggedRecords(navigation: ReviewNavigation, from?: string) {
  navigation.setParams({ from: undefined });
  if (navigation.getState().index > 0) navigation.goBack();
  else navigation.reset({ index: 0, routes: [{ name: "RecordsList" }] });
  if (from === "ExpenseBehavior") navigation.navigate("Insights", { screen: "ExpenseBehavior" });
  else if (from === "Dashboard") navigation.navigate("Dashboard");
}
