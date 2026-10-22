import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { CompositeScreenProps, NavigationProp, NavigatorScreenParams, ParamListBase } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { BusinessProfile, RecordItem } from "../lib/types";

/**
 * Every route the signed-in app registers in App.tsx, with the params it is
 * opened with.
 *
 * A screen typed with these props gets its `route.params` checked against
 * what callers actually send, and a `navigate()` to a screen in another tab
 * goes through `{ screen, params }` checked against that tab's stack. Before
 * this, every screen took `any`, so a renamed param or a missing record only
 * surfaced as a crash on a phone.
 *
 * Kept in step with App.tsx by hand; tests/navigationTargets.test.ts checks that every
 * navigate() target is registered there.
 */
export type DashboardStackParamList = {
  DashboardHome: undefined;
  Notifications: undefined;
  MoneyFlow: undefined;
  Onboarding: undefined;
};

export type RecordsStackParamList = {
  RecordsList: { type?: "expense" | "sales"; categoryId?: number; importBatchId?: number } | undefined;
  AddExpense: undefined;
  AddSales: undefined;
  EditRecord: { record: RecordItem };
  ScanReceipt: undefined;
  ImportCsv: undefined;
  /** `from` says where to return; cleared once used. */
  FlaggedRecords: { from?: "ExpenseBehavior" | "Dashboard" } | undefined;
  Categories: undefined;
};

export type InsightsStackParamList = {
  ExpenseBehavior: undefined;
  /** Prefilled from an Ask FinSight answer; validated by the screen, so typed loosely. */
  SpendingImpact: { plannedAmount?: unknown } | undefined;
  RecoveryTarget: undefined;
  RecurringSchedule: { scheduleId?: number } | undefined;
};

export type MoreStackParamList = {
  MoreHome: undefined;
  Profile: undefined;
  EditProfile: undefined;
  ChangePassword: undefined;
  DeleteAccount: undefined;
  Settings: undefined;
  BusinessProfiles: undefined;
  /** No profile: create one. */
  BusinessProfileForm: { profile?: BusinessProfile } | undefined;
  OperatingSchedule: { businessProfileId?: number; from?: "RecoveryTarget" } | undefined;
  RecoveryNotificationPreferences: undefined;
  MonthEndReview: { from?: "RecoveryTarget" } | undefined;
  Notifications: undefined;
  Faqs: undefined;
  Tutorials: undefined;
  Contact: undefined;
  Privacy: undefined;
  Terms: undefined;
};

export type RootTabParamList = {
  Dashboard: NavigatorScreenParams<DashboardStackParamList> | undefined;
  Records: NavigatorScreenParams<RecordsStackParamList> | undefined;
  Scan: undefined;
  Insights: NavigatorScreenParams<InsightsStackParamList> | undefined;
  More: NavigatorScreenParams<MoreStackParamList> | undefined;
};

type TabStacks = {
  Dashboard: DashboardStackParamList;
  Records: RecordsStackParamList;
  Insights: InsightsStackParamList;
  More: MoreStackParamList;
};

/** A tab and a screen that really is in that tab's stack: the `navigate(tab, { screen })` pair. */
export type TabScreenTarget = { [Tab in keyof TabStacks]: { tab: Tab; screen: keyof TabStacks[Tab] & string } }[keyof TabStacks];

/** For components outside a screen's props that move between tabs (`useNavigation`). */
export type TabNavigation = NavigationProp<RootTabParamList>;

/**
 * Opens a screen in another tab from a table of targets.
 *
 * TypeScript cannot pair a union of tabs with the matching union of screens in
 * a single navigate() call, so the call is widened here, once. The pairing is
 * still checked: `target` can only be a screen that exists in its tab.
 */
export function navigateToTabScreen(navigation: TabNavigation, target: TabScreenTarget, params?: object): void {
  const navigate = navigation.navigate as (tab: string, nested: { screen: string; params?: object }) => void;
  navigate(target.tab, { screen: target.screen, ...(params ? { params } : {}) });
}

type InTab<Stack extends ParamListBase, Route extends keyof Stack & string> = CompositeScreenProps<
  NativeStackScreenProps<Stack, Route>,
  BottomTabScreenProps<RootTabParamList>
>;

export type DashboardScreenProps<Route extends keyof DashboardStackParamList & string> = InTab<DashboardStackParamList, Route>;
export type RecordsScreenProps<Route extends keyof RecordsStackParamList & string> = InTab<RecordsStackParamList, Route>;
export type InsightsScreenProps<Route extends keyof InsightsStackParamList & string> = InTab<InsightsStackParamList, Route>;
export type MoreScreenProps<Route extends keyof MoreStackParamList & string> = InTab<MoreStackParamList, Route>;

/**
 * Notifications is registered in both the Home and More stacks. It only goes
 * back or moves between tabs, which works the same from either, so it is
 * typed against Home.
 */
export type NotificationsScreenProps = DashboardScreenProps<"Notifications">;
