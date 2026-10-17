type ScheduleNavigation = {
  navigate(name: string, params?: object): void;
  getState(): { index: number };
  goBack(): void;
  popToTop(): void;
  reset(state: { index: number; routes: Array<{ name: string }> }): void;
  setParams(params: { from: undefined }): void;
};

export function openOperatingScheduleFromRecovery(navigation: Pick<ScheduleNavigation, "navigate">) {
  navigation.navigate("More", {
    screen: "OperatingSchedule",
    initial: false,
    params: { from: "RecoveryTarget" },
  });
}

export function returnFromOperatingSchedule(navigation: ScheduleNavigation, from?: string) {
  if (from === "RecoveryTarget") {
    navigation.setParams({ from: undefined });
    if (navigation.getState().index > 0) navigation.popToTop();
    else navigation.reset({ index: 0, routes: [{ name: "MoreHome" }] });
    navigation.navigate("Insights", { screen: "RecoveryTarget" });
  } else if (navigation.getState().index > 0) navigation.goBack();
  else navigation.reset({ index: 0, routes: [{ name: "MoreHome" }] });
}
