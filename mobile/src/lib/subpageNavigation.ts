export function isFullscreenSubpage(tabName: string | undefined, screenName: string | undefined): boolean {
  if (!screenName) return false;
  return (tabName === "More" && screenName !== "MoreHome")
    || (tabName === "Dashboard" && screenName === "Notifications");
}
