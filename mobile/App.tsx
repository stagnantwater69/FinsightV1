import { HeaderBackButton } from "./src/components/HeaderBackButton";
import { ChangePasswordScreen, DeleteAccountScreen, EditProfileScreen } from "./src/screens/AccountScreens";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StatusBar, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import {
  NavigationContainer,
  CommonActions,
  DefaultTheme,
  createNavigationContainerRef,
  getFocusedRouteNameFromRoute,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import type { DashboardStackParamList, InsightsStackParamList, MoreStackParamList, RecordsStackParamList, RootTabParamList } from "./src/navigation/types";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as Font from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { IBMPlexSans_400Regular } from "@expo-google-fonts/ibm-plex-sans/400Regular";
import { IBMPlexSans_500Medium } from "@expo-google-fonts/ibm-plex-sans/500Medium";
import { IBMPlexSans_600SemiBold } from "@expo-google-fonts/ibm-plex-sans/600SemiBold";
import { IBMPlexSans_700Bold } from "@expo-google-fonts/ibm-plex-sans/700Bold";
import { IBMPlexMono_400Regular } from "@expo-google-fonts/ibm-plex-mono/400Regular";
import { IBMPlexMono_500Medium } from "@expo-google-fonts/ibm-plex-mono/500Medium";
import { IBMPlexMono_600SemiBold } from "@expo-google-fonts/ibm-plex-mono/600SemiBold";

import { AuthProvider, useAuth } from "./src/context/AuthContext";
import { LaunchScreen } from "./src/components/LaunchScreen";
import { BusinessProfileProvider, useBusinessProfiles } from "./src/context/BusinessProfileContext";
import { TourProvider, useTourOptional } from "./src/context/TourContext";
import { AiChatProvider } from "./src/context/AiChatContext";
import { ReportingPeriodProvider } from "./src/context/ReportingPeriodContext";
import { useTourTarget } from "./src/components/tour/targets";
import { QUICK_ADD_STEP_IDS, type TourTargetKey } from "./src/components/tour/steps";
import {
  ONBOARDING_NEXT_SCREENS,
  OnboardingResumeScreen,
  OnboardingScreen,
  type OnboardingNext,
} from "./src/screens/OnboardingScreens";
import { readOnboarding, shouldShowOnboarding } from "./src/lib/onboardingDraft";
import {
  LoginScreen,
  RegisterScreen,
  RecoverPasswordScreen,
  ResetPasswordScreen,
  ConfirmEmailScreen,
  SessionHandoffScreen,
} from "./src/screens/AuthScreens";
import { parseAuthDeepLink, type AuthLinkResult } from "./src/lib/authLinkTokens";
import { DashboardScreen } from "./src/screens/DashboardScreen";
import { NotificationsScreen } from "./src/screens/NotificationsScreen";
import { MoreScreen } from "./src/screens/MoreScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import {
  AddExpenseScreen,
  AddSalesScreen,
  EditRecordScreen,
  FlaggedRecordsScreen,
  ImportCsvScreen,
  RecordsScreen,
  ScanReceiptScreen,
} from "./src/screens/records";
import { CategoriesScreen } from "./src/screens/CategoriesScreen";
import {
  ContactScreen,
  FaqsScreen,
  PrivacyScreen,
  TermsScreen,
  TutorialsScreen,
} from "./src/screens/HelpScreens";
import {
  ExpenseBehaviorScreen,
  RecoveryTargetScreen,
  SpendingImpactScreen,
} from "./src/screens/InsightsScreens";
import { RecurringScheduleScreen } from "./src/screens/RecurringScheduleScreen";
import {
  BusinessProfileFormScreen,
  BusinessProfilesScreen,
  ProfileScreen,
} from "./src/screens/BusinessScreens";
import { OperatingScheduleScreen } from "./src/screens/OperatingScheduleScreen";
import { RecoveryNotificationPreferencesScreen } from "./src/screens/RecoveryNotificationPreferencesScreen";
import { MonthEndReviewScreen } from "./src/screens/MonthEndReviewScreen";
import { font } from "./src/theme/tokens";
import { shadowStyle } from "./src/theme/shadow";
import type { Palette } from "./src/theme/palette";
import { ThemeProvider, useTheme, useThemeControl } from "./src/context/ThemeContext";
import { recordsTabPressAction, RECORDS_LIST_SCREEN } from "./src/lib/tabSelection";
import { isFullscreenSubpage } from "./src/lib/subpageNavigation";
import { returnFromOperatingSchedule } from "./src/lib/operatingScheduleNavigation";
import { returnFromMonthEndReview } from "./src/lib/monthEndReviewNavigation";
import { returnFromFlaggedRecords } from "./src/lib/flaggedRecordsNavigation";
import { QuickActionMenu, type RadialAction } from "./src/components/QuickActionMenu";
import { FloatingTabBar } from "./src/components/FloatingTabBar";
import { MoneyFlowScreen } from "./src/screens/MoneyFlowScreen";
import { BAR_HEIGHT } from "./src/components/floatingTabBarLayout";
import { BusinessNavigationBoundary } from "./src/components/BusinessNavigationBoundary";
import { AppErrorBoundary } from "./src/components/AppErrorBoundary";

/**
 * Used to reach the navigator from the tab bar's camera modal, which sits
 * outside every navigator and so has no `useNavigation` to call. The
 * documented approach for exactly this.
 */
const navigationRef = createNavigationContainerRef();

/*
 * Hold the native splash until the app actually has something to show.
 *
 * The splash was configured in app.config.ts but never held: it hid itself the
 * moment the JS bundle loaded, and the owner then watched a bare spinner while
 * the fonts loaded and a second one while the session was restored. Holding it
 * to the end of both makes the cold start read as splash → app.
 *
 * Called in global scope and not awaited, per the module's own guidance — from
 * inside a component or an effect this can run after the splash is already
 * gone. Its rejection is swallowed because a splash that will not stay up is
 * a cosmetic problem, not a reason to fail to start.
 */
SplashScreen.preventAutoHideAsync().catch(() => undefined);

const Tab = createBottomTabNavigator<RootTabParamList>();
/** Signed-out screens. Not yet given a param list. */
const Stack = createNativeStackNavigator();
const DashboardNav = createNativeStackNavigator<DashboardStackParamList>();
const RecordsNav = createNativeStackNavigator<RecordsStackParamList>();
const InsightsNav = createNativeStackNavigator<InsightsStackParamList>();
const MoreNav = createNativeStackNavigator<MoreStackParamList>();

/**
 * React Navigation's own colours, built from the palette.
 *
 * These are the surfaces the library paints itself — the card behind a
 * screen during a push transition, the hairline under a native header, the
 * default text colour. Left on `DefaultTheme` they stay white in Dark, which
 * shows up as a white flash on every navigation and a white sliver under
 * every header: the exact "dark mode is only skin-deep" tell.
 */
const navThemeFor = (t: Palette) => ({
  ...DefaultTheme,
  dark: t.mode === "dark",
  fonts: {
    regular: { fontFamily: font.sans, fontWeight: "normal" as const },
    medium: { fontFamily: font.sansMedium, fontWeight: "normal" as const },
    bold: { fontFamily: font.sansSemibold, fontWeight: "normal" as const },
    heavy: { fontFamily: font.displayBold, fontWeight: "normal" as const },
  },
  colors: {
    ...DefaultTheme.colors,
    primary: t.brand[600],
    background: t.surfaceSunken,
    card: t.surface,
    text: t.textPrimary,
    border: t.brandBorder,
  },
});

/**
 * A hook rather than a constant, for the same reason: four stack navigators
 * share these header options, and a module-level object would freeze the
 * header in whichever theme was loaded first.
 */
function useScreenOptions() {
  const t = useTheme();
  return {
    headerStyle: { backgroundColor: t.surface },
    headerTitleStyle: { fontFamily: font.display, color: t.brandHeading },
    headerTintColor: t.brandText,
    headerBackButtonDisplayMode: "minimal",
    statusBarStyle: t.statusBarStyle,
    statusBarBackgroundColor: t.surface,
  } as const;
}

/**
 * The Dashboard needs a stack of its own so it can push the alerts list —
 * web reaches the same screen from the bell in its header.
 */
function DashboardStack() {
  const screenOptions = useScreenOptions();
  return (
    <DashboardNav.Navigator screenOptions={screenOptions}>
      {/*
        headerShown: false — DashboardScreen (now Home) builds its own header
        with an avatar, a business switcher and a bell, which replaces both
        this native title bar and the eyebrow/title ScreenHeader every other
        screen uses. Same pattern MoreStack already uses for MoreHome.
      */}
      <DashboardNav.Screen name="DashboardHome" component={DashboardScreen} options={{ headerShown: false }} />
      <DashboardNav.Screen name="Notifications" component={NotificationsScreen} options={{ headerShown: false }} />
      <DashboardNav.Screen name="MoneyFlow" component={MoneyFlowScreen} options={{ title: "Money in and out" }} />
      {/* How someone who chose "Skip for now" gets back into setup — the
          wizard draws its own header, so this one is hidden. */}
      <DashboardNav.Screen name="Onboarding" component={OnboardingResumeScreen} options={{ headerShown: false }} />
    </DashboardNav.Navigator>
  );
}

/*
 * A back arrow that is drawn even when the stack has nothing under the
 * current route, for screens that can be reached as a stack's first route.
 */
function goBackOr(navigation: { canGoBack(): boolean; goBack(): void; navigate(name: string): void }, fallback: string) {
  if (navigation.canGoBack()) navigation.goBack();
  else navigation.navigate(fallback);
}

function RecordsStack() {
  const screenOptions = useScreenOptions();
  return (
    <RecordsNav.Navigator screenOptions={screenOptions}>
      {/*
        headerShown: false, like Home, Insights and More.

        The native header printed "Records" directly above the screen's own
        "Records" heading — the same word twice, one under the other, with
        nothing between them. The list is the tab's root, so the header also
        had no back arrow to justify itself. Every screen PUSHED from here
        keeps its header, because those do have somewhere to go back to.
      */}
      <RecordsNav.Screen name="RecordsList" component={RecordsScreen} options={{ headerShown: false }} />
      <RecordsNav.Screen name="AddExpense" component={AddExpenseScreen} options={{ title: "Add expense" }} />
      <RecordsNav.Screen name="AddSales" component={AddSalesScreen} options={{ title: "Add sales" }} />
      {/*
        Tapping a record on the list navigates here. This was missing: the
        list has always called navigate("EditRecord"), so every tap resolved
        to nothing and a saved record could not be corrected on mobile at all.
      */}
      <RecordsNav.Screen name="EditRecord" component={EditRecordScreen} options={{ title: "Edit record" }} />
      {/*
        Quick-add opens this as the FIRST route on the Records stack when the
        owner hasn't visited Records yet, and the native header only draws a
        back arrow when there is a route under it — so the screen had no way
        out but the hardware button. Always draw one; with nothing to pop it
        lands on the Records list.
      */}
      <RecordsNav.Screen
        name="ScanReceipt"
        component={ScanReceiptScreen}
        options={({ navigation }) => ({
          title: "Scan receipt",
          headerBackVisible: false,
          headerLeft: ({ tintColor }) => (
            <HeaderBackButton tintColor={tintColor} onPress={() => goBackOr(navigation, "RecordsList")} />
          ),
        })}
      />
      <RecordsNav.Screen name="ImportCsv" component={ImportCsvScreen} options={({ navigation }) => ({
        title: "Import CSV",
        headerBackVisible: false,
        headerLeft: ({ tintColor }) => <HeaderBackButton tintColor={tintColor} onPress={() => {
          if (navigation.canGoBack()) navigation.goBack();
          else navigation.replace("RecordsList");
        }} />,
      })} />
      <RecordsNav.Screen
        name="FlaggedRecords"
        component={FlaggedRecordsScreen}
        options={({ navigation, route }: any) => ({
          title: "Review records",
          headerBackVisible: false,
          headerLeft: ({ tintColor }) => (
            <HeaderBackButton tintColor={tintColor} onPress={() => returnFromFlaggedRecords(navigation, route.params?.from)} />
          ),
        })}
      />
      {/*
        In the Records stack rather than under More, because a category is a
        records concept — the screen's own "view records" route goes straight
        back to RecordsList, which only works without a stack hop from here.
      */}
      <RecordsNav.Screen name="Categories" component={CategoriesScreen} options={{ title: "Categories" }} />
    </RecordsNav.Navigator>
  );
}

function InsightsStack() {
  const screenOptions = useScreenOptions();
  return (
    /*
      headerShown: false across the whole stack.

      The three insight screens are not a stack an owner walks down — they
      move between each other through the segmented control, and none of them
      has a parent to go back to. The native header was therefore a back arrow
      that returned to whichever insight was looked at last, under a title
      ("Insights") that the tab bar was already showing. Each screen draws its
      own heading instead, the same way Home and More do.
    */
    <InsightsNav.Navigator screenOptions={{ ...screenOptions, headerShown: false }}>
      <InsightsNav.Screen name="ExpenseBehavior" component={ExpenseBehaviorScreen} />
      <InsightsNav.Screen name="SpendingImpact" component={SpendingImpactScreen} />
      <InsightsNav.Screen name="RecoveryTarget" component={RecoveryTargetScreen} />
      {/*
        The one screen in this stack that IS pushed onto something, so it is
        the one that keeps a header: it has a parent to go back to (the
        Recurring tab of Expense insight), and without the native header the
        only way out would be the hardware back button.
      */}
      <InsightsNav.Screen
        name="RecurringSchedule"
        component={RecurringScheduleScreen}
        options={{ headerShown: true, title: "Repeating payment" }}
      />
    </InsightsNav.Navigator>
  );
}

/**
 * Everything that is not a daily task, behind one tab.
 *
 * "Business" previously held a whole bottom-bar slot, putting profile
 * settings — a once-a-month errand — at the same level as recording an
 * expense. Alerts lives here too, so it is reachable without going via the
 * Dashboard.
 */
function MoreStack() {
  const screenOptions = useScreenOptions();
  return (
    <MoreNav.Navigator screenOptions={screenOptions}>
      <MoreNav.Screen name="MoreHome" component={MoreScreen} options={{ headerShown: false }} />
      <MoreNav.Screen name="Profile" component={ProfileScreen} options={{ headerShown: false }} />
      <MoreNav.Screen name="EditProfile" component={EditProfileScreen} options={{ headerShown: false }} />
      <MoreNav.Screen name="ChangePassword" component={ChangePasswordScreen} options={{ headerShown: false }} />
      <MoreNav.Screen name="DeleteAccount" component={DeleteAccountScreen} options={{ headerShown: false }} />
      {/*
        How the app behaves for this owner: the guided tour, Fin's daily
        message on Home, and light or dark. It replaces the "Preferences" card
        that used to sit on the More screen itself — see SettingsScreen.tsx.
      */}
      <MoreNav.Screen name="Settings" component={SettingsScreen} options={{ headerShown: false }} />
      <MoreNav.Screen name="BusinessProfiles" component={BusinessProfilesScreen} options={{ headerShown: false }} />
      <MoreNav.Screen name="BusinessProfileForm" component={BusinessProfileFormScreen} options={{ title: "Business profile" }} />
      <MoreNav.Screen
        name="OperatingSchedule"
        component={OperatingScheduleScreen}
        options={({ navigation, route }: any) => ({
          title: "Operating schedule",
          headerBackVisible: false,
          headerLeft: ({ tintColor }) => (
            <HeaderBackButton
              tintColor={tintColor}
              onPress={() => returnFromOperatingSchedule(navigation, route.params?.from)}
            />
          ),
        })}
      />
      <MoreNav.Screen
        name="RecoveryNotificationPreferences"
        component={RecoveryNotificationPreferencesScreen}
        options={({ navigation }) => ({
          title: "Notification settings",
          headerBackVisible: false,
          headerLeft: ({ tintColor }) => (
            <HeaderBackButton tintColor={tintColor} onPress={() => goBackOr(navigation, "MoreHome")} />
          ),
        })}
      />
      <MoreNav.Screen
        name="MonthEndReview"
        component={MonthEndReviewScreen}
        options={({ navigation, route }: any) => ({
          title: "Month-end review",
          headerBackVisible: false,
          headerLeft: ({ tintColor }) => (
            <HeaderBackButton
              tintColor={tintColor}
              onPress={() => returnFromMonthEndReview(navigation, route.params?.from)}
            />
          ),
        })}
      />
      <MoreNav.Screen name="Notifications" component={NotificationsScreen} options={{ headerShown: false }} />
      {/*
        Help and legal live IN the app, not behind a link to the website.
        Most owners have a phone and no computer, so for them this is the only
        place these documents will ever be read — and Privacy and Terms are
        not optional reading to route someone off-device for.
      */}
      <MoreNav.Screen name="Faqs" component={FaqsScreen} options={{ headerShown: false }} />
      <MoreNav.Screen name="Tutorials" component={TutorialsScreen} options={{ headerShown: false }} />
      <MoreNav.Screen name="Contact" component={ContactScreen} options={{ headerShown: false }} />
      <MoreNav.Screen name="Privacy" component={PrivacyScreen} options={{ headerShown: false }} />
      <MoreNav.Screen name="Terms" component={TermsScreen} options={{ headerShown: false }} />
    </MoreNav.Navigator>
  );
}

/**
 * Bottom tabs.
 *
 * Three places work happens, then everything else. The icons are a real icon
 * set rather than the Unicode geometric shapes (◧ ☰ ◔ ▣) that stood in
 * before — those rendered differently on every device and read as
 * placeholders, because that is what they were.
 *
 * Outline when inactive, filled when active: the selected tab is the only one
 * carrying weight, which is a second signal beyond the tint for anyone who
 * cannot separate the two colours.
 */
const TAB_ICONS: Record<string, [keyof typeof Ionicons.glyphMap, keyof typeof Ionicons.glyphMap]> = {
  Dashboard: ["home-outline", "home"],
  Records: ["receipt-outline", "receipt"],
  Insights: ["bar-chart-outline", "bar-chart"],
  More: ["ellipsis-horizontal-circle-outline", "ellipsis-horizontal-circle"],
};

/**
 * The two tabs the product tour points at.
 *
 * REGISTERED ON THE ICON, not on the tab button. bottom-tabs renders its own
 * button and gives no ref to it, and replacing `tabBarButton` wholesale to get
 * one would mean re-implementing the label, the press feedback and the
 * accessibility state that the library already gets right. The icon is inside
 * the button, so a spotlight around it (plus the overlay's own padding) lands
 * on the tab — see components/tour/targets.ts.
 */
const TAB_TOUR_TARGETS: Record<string, TourTargetKey | undefined> = {
  Records: "tab-records",
  Insights: "tab-insights",
};

/**
 * The Records-stack screens reached only through the plus button's menu.
 * While one of these is focused, the plus button glows instead of Records —
 * see the `onQuickAddScreen` comment in MainTabs.
 */
const QUICK_ADD_DESTINATION_SCREENS = ["AddExpense", "AddSales", "ScanReceipt", "ImportCsv", "Categories"];

/** A tab icon that the tour can measure. Its own component for the hook. */
function TabIcon({
  routeName,
  color,
  focused,
}: {
  routeName: string;
  color: string;
  focused: boolean;
}) {
  /*
   * The spotlight is padded down and out to take in the LABEL as well as the
   * glyph. What is registered here is the 22pt icon, because bottom-tabs hands
   * out no ref to the button around it; a ring drawn tight to the icon points
   * at half a control and reads as a misaligned overlay rather than as "this
   * tab". The numbers are the tab item's own metrics: the icon-to-label gap
   * plus the label's line box, and enough width for the widest of the four.
   */
  const tourTarget = useTourTarget(TAB_TOUR_TARGETS[routeName], {
    pad: { top: 8, bottom: 26, left: 26, right: 26 },
  });
  const pair = TAB_ICONS[routeName];
  return (
    <View {...tourTarget}>
      <Ionicons name={pair ? pair[focused ? 1 : 0] : "ellipse-outline"} size={24} color={color} />
    </View>
  );
}

/**
 * Adding something: the circle beside the floating tab bar.
 *
 * Recording what was spent and earned is what this app is FOR and the reason
 * someone opens it standing at a counter, so it gets its own large target
 * under the right thumb rather than a slot among the tabs. It opens five
 * actions (see QuickActionMenu), so the glyph is a plus — a camera on it would
 * promise which of the five happens, to someone who has not pressed it yet.
 */
function ScanTabButton({
  onPress,
  active,
  glow,
}: {
  onPress: () => void;
  active: boolean;
  // Distinct from `active`: the ring turns on for a quick-add destination
  // screen too (AddExpense, AddSales, ScanReceipt, ImportCsv, Categories),
  // where the menu is already closed and the glyph must stay a plus, not
  // turn into the X that means "the menu is open".
  glow?: boolean;
}) {
  const t = useTheme();
  const lit = active || glow;
  // The tour's "Receipt scanner" step points here: on a phone this button IS
  // the quick-add menu web spotlights.
  const tourTarget = useTourTarget("quick-add", { pad: { top: 8, bottom: 8, left: 8, right: 8 }, radius: 999 });

  return (
    <Pressable
      {...tourTarget}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={active ? "Close the actions menu" : "Add a record"}
      // Announced as selected, so a screen reader says the same thing the
      // ring does rather than leaving the state visual-only.
      accessibilityState={{ selected: lit }}
      style={({ pressed }) => ({
        width: BAR_HEIGHT,
        height: BAR_HEIGHT,
        borderRadius: BAR_HEIGHT / 2,
        alignItems: "center",
        justifyContent: "center",
        // `brandSolid`, not the brand ramp: this disc is dark teal in BOTH
        // themes. The ramp's 700 step lightens in Dark so brand TEXT stays
        // legible on a dark card, which would turn this into a pale mint
        // circle carrying white glyphs.
        backgroundColor: pressed || lit ? t.brandSolidPressed : t.brandSolid,
        // The "you are here" signal for a quick-add screen: a ring in the
        // brand border colour, where the tabs use a tinted pill.
        borderWidth: lit ? 3 : 0,
        borderColor: t.brandBorder,
        ...shadowStyle({ color: t.shadow, offsetY: 8, opacity: 0.22 * t.shadowStrength, blurRadius: 16, elevation: 8 }),
      })}
    >
      <Ionicons name={active ? "close" : "add"} size={30} color={t.onBrandSolid} />
    </Pressable>
  );
}


function MainTabs() {
  const t = useTheme();
  const { ACCENT, categorical, categoricalOnColor } = t;
  /**
   * The five actions the "+" offers instead of going straight to the camera.
   * See components/QuickActionMenu for why they rise as a labelled stack.
   */
  const [menuOpen, setMenuOpen] = useState(false);

  /*
   * The product tour's two Quick-add steps spotlight items inside that menu,
   * so while one of them is the active step the menu is held open by the tour
   * rather than by the owner. `activeStepId` is the whole of the coupling —
   * the tab bar knows nothing else about the tour.
   */
  const tour = useTourOptional();
  const tourHoldsMenu = QUICK_ADD_STEP_IDS.includes(tour?.activeStepId ?? "");

  /*
   * AddExpense/AddSales/ScanReceipt/ImportCsv/Categories are screens on the
   * Records stack (see `openInRecords` below), so React Navigation's own
   * focus tracking genuinely and correctly marks the Records tab as focused
   * once one of them is pushed. But the owner didn't get there by pressing
   * Records — they pressed the plus button and picked one of its five
   * actions, so that's the button that should read as "where you are."
   *
   * Read off `navigationRef` rather than `useNavigationState`: that hook only
   * works in a component nested INSIDE a navigator (a screen), not in the
   * component that renders the navigator itself — MainTabs renders
   * Tab.Navigator below, so calling the hook here throws "Couldn't get the
   * navigation state. Is your component inside a navigator?". The ref has no
   * such restriction; a `state` listener keeps this in sync instead.
   */
  const [recordsFocusedScreen, setRecordsFocusedScreen] = useState<string | undefined>();
  const [subpageFocused, setSubpageFocused] = useState(false);
  useEffect(() => {
    const sync = () => {
      if (!navigationRef.isReady()) return;
      const recordsRoute = navigationRef.getRootState()?.routes.find((r) => r.name === "Records");
      setRecordsFocusedScreen(recordsRoute ? getFocusedRouteNameFromRoute(recordsRoute) : undefined);
      const rootState = navigationRef.getRootState();
      const activeRoute = rootState?.routes[rootState.index];
      const fullscreen = isFullscreenSubpage(activeRoute?.name, activeRoute ? getFocusedRouteNameFromRoute(activeRoute) : undefined);
      setSubpageFocused(fullscreen);
      if (fullscreen) setMenuOpen(false);
    };
    sync();
    return navigationRef.addListener("state", sync);
  }, []);
  const onQuickAddScreen = recordsFocusedScreen
    ? QUICK_ADD_DESTINATION_SCREENS.includes(recordsFocusedScreen)
    : false;

  /*
   * The nested-params form, because it is the only one that crosses tabs.
   *
   * A bare `dispatch(push(screen))` after switching tabs looks cleaner and
   * does nothing: `useOnAction` forwards an action into a CHILD navigator
   * only when it carries a `target`, so a targetless one bubbles up past the
   * tab navigator and is dropped on the floor.
   *
   * The residue — `{ screen }` left on the Records tab route, which
   * bottom-tabs replays on every later press — is handled once in
   * `recordsTabPressAction` rather than here.
   */
  const openInRecords = (screen: string) => {
    if (!navigationRef.isReady()) return;
    navigationRef.dispatch(CommonActions.navigate("Records", { screen }));
  };

  const quickActions: RadialAction[] = [
    {
      key: "expense",
      label: "Add expense",
      icon: "receipt-outline",
      // The tour's "Record an expense by hand" step.
      tourTarget: "quick-add-expense",
      color: ACCENT.fill,
      // Amber takes DARK ink, never white — measured, and the same rule the
      // primary button follows.
      onColor: ACCENT.onFill,
      onPress: () => openInRecords("AddExpense"),
    },
    {
      key: "sales",
      label: "Add sale",
      icon: "cash-outline",
      // And "Add a sales reference" — the two ways money is recorded without
      // a receipt or a spreadsheet, which is why the phone teaches them and
      // web does not have to.
      tourTarget: "quick-add-sales",
      color: categorical[2],
      onColor: categoricalOnColor[2],
      onPress: () => openInRecords("AddSales"),
    },
    {
      key: "scan",
      label: "Scan a receipt",
      icon: "camera-outline",
      // The tour's "Receipt scanner" step spotlights this circle, with the
      // menu held open around it — see components/tour/steps.ts.
      tourTarget: "quick-add-scan",
      // The middle of the arc, in FinSight's own green: still the action the
      // button is for, just no longer the only one it can reach.
      color: t.brandSolid,
      onColor: t.onBrandSolid,
      // ScanReceiptScreen owns its own camera and opens it on arrival — see
      // that screen's `cameraOpen` comment for why backing out of an
      // unsupported/failed scanner needs to land on a screen rather than a
      // bare modal (that's where "Choose from gallery" lives).
      onPress: () => openInRecords("ScanReceipt"),
    },
    {
      key: "csv",
      label: "Import a CSV file",
      icon: "cloud-upload-outline",
      // Likewise "Import a spreadsheet", which used to point at Home's own
      // Import CSV tile — a shortcut on one screen rather than the control the
      // owner will find on every screen.
      tourTarget: "quick-add-csv",
      color: categorical[0],
      onColor: categoricalOnColor[0],
      onPress: () => openInRecords("ImportCsv"),
    },
    {
      key: "categories",
      label: "Manage categories",
      icon: "grid-outline",
      color: categorical[6],
      onColor: categoricalOnColor[6],
      onPress: () => openInRecords("Categories"),
    },
  ];

  return (
    <>
    <Tab.Navigator
      /*
       * Records still gets special-cased, just not for the reason the old
       * comment here used to give.
       *
       * AddExpense/AddSales/ScanReceipt/ImportCsv/Categories are ordinary
       * screens on the Records stack, so React Navigation's real focus
       * tracking correctly marks Records as focused for all five. But the
       * owner reached them through the plus button's menu, not by pressing
       * Records, so both the tint (via the Records Tab.Screen's own
       * `options` below) and the glyph here are forced back to their
       * unfocused look while `onQuickAddScreen` is true — the plus button
       * glows instead, see `glow` on ScanTabButton.
       */
      tabBar={(props) => {
        const activeTab = props.state.routes[props.state.index];
        const focusedScreen = activeTab ? getFocusedRouteNameFromRoute(activeTab) : undefined;
        if (isFullscreenSubpage(activeTab?.name, focusedScreen)) return null;
        return <FloatingTabBar
          {...props}
          hiddenRoutes={["Scan"]}
          mutedRoute={onQuickAddScreen ? "Records" : undefined}
          addButton={<ScanTabButton onPress={() => setMenuOpen(true)} active={menuOpen} glow={onQuickAddScreen} />}
        />;
      }}
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: ({ color, focused }) => (
          <TabIcon
            routeName={route.name}
            color={color}
            focused={route.name === "Records" && onQuickAddScreen ? false : focused}
          />
        ),
      })}
    >
      {/*
        Route name stays "Dashboard" — nothing navigates to it by name, and
        renaming it would be pure churn — but the visible label is "Home",
        which is what the tab actually is now.
      */}
      <Tab.Screen name="Dashboard" component={DashboardStack} options={{ tabBarLabel: "Home" }} />
      {/*
        Records intercepts its own tab press — see recordsTabPressAction for
        the two ways the default handler gets this wrong once Scan starts
        pushing the scanner onto this stack. Short version: pressing an
        already-focused tab does nothing at all, and the nested-navigation
        params Scan leaves behind get replayed on every later press.
      */}
      <Tab.Screen
        name="Records"
        component={RecordsStack}
        listeners={({ navigation, route }) => ({
          tabPress: (e) => {
            const sticky = (route.params as { screen?: string } | undefined)?.screen;
            if (recordsTabPressAction(navigation.isFocused(), sticky) === "default") return;

            // preventDefault stops the stale-params navigate; this replaces it
            // with the one thing pressing "Records" should always mean.
            e.preventDefault();
            navigation.navigate("Records", { screen: RECORDS_LIST_SCREEN });
          },
        })}
      />
      {/*
        A tab in position only, and it navigates nowhere.

        It used to push `ScanReceipt` onto the Records stack to get a camera
        up, and every bug that followed came from that: Records lit up instead
        of Scan, pressing Records did nothing because Records was already the
        focused tab, the nested-navigation params stuck to the Records route
        and replayed on later presses, and backing out of the camera stranded
        the owner on a screen they never asked for.

        Now the press opens a camera modal in place. Navigation state does not
        move, so cancelling returns the owner to exactly where they were —
        their dashboard, their records, wherever. Only FINISHING a capture
        navigates, and it navigates to the review screen because that is where
        the receipt actually gets read.
      */}
      <Tab.Screen
        name="Scan"
        component={ScanPlaceholder}
        // Never shown as a tab: the floating bar draws "+" as its own circle
        // (hiddenRoutes above), and the route stays only so nothing that
        // already names it breaks.
        listeners={() => ({
          tabPress: (e) => {
            e.preventDefault();
            setMenuOpen(true);
          },
        })}
      />
      <Tab.Screen name="Insights" component={InsightsStack} />
      <Tab.Screen name="More" component={MoreStack} />
    </Tab.Navigator>

    {/*
      The two tour steps that point INSIDE this menu hold it open themselves.
      Held open by the tour it is not the owner's menu: it ignores taps outside
      and the back button, both of which belong to the tour while a step is up.
      When the step moves on it closes again, restoring exactly the state the
      owner had. Web's AppShell does the same for the same two steps.
    */}
    <QuickActionMenu
      visible={!subpageFocused && (menuOpen || tourHoldsMenu)}
      heldOpen={tourHoldsMenu}
      actions={quickActions}
      onClose={() => setMenuOpen(false)}
    />
    </>
  );
}

/** Never rendered — the Scan tab's press is intercepted before it mounts. */
function ScanPlaceholder() {
  return null;
}

function AuthStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Register" component={RegisterScreen} />
      <Stack.Screen name="RecoverPassword" component={RecoverPasswordScreen} />
      {/*
        A STACK SCREEN NOW, not a deep-link destination.

        The reset email used to carry a button pointing at
        `finsight://auth/reset-password`, and this screen was rendered above the
        navigator when that link fired. The template no longer has the button —
        it carries GoTrue's recovery code alone — so the link will never fire
        again, and the code has to be typed somewhere. That somewhere is here,
        reached from RecoverPassword with the address it was sent to, so the
        whole reset happens without leaving the app.

        Email CONFIRMATION is untouched: it still arrives as a link, and
        ConfirmEmailScreen is still rendered above the navigator for it.
      */}
      <Stack.Screen name="ResetPassword">
        {({ route, navigation }) => (
          <ResetPasswordScreen
            // Empty when someone reaches this screen directly — the form asks
            // for the address in that case rather than refusing to open.
            email={(route.params as { email?: string } | undefined)?.email ?? ""}
            onDone={() => navigation.navigate("Login")}
            onNewCode={() => navigation.navigate("RecoverPassword")}
          />
        )}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

/**
 * Watches for the auth deep links Supabase's emails point at.
 *
 * WHY THIS RATHER THAN REACT NAVIGATION'S `linking` CONFIG. The credentials in
 * these links live in the URL *fragment*, which navigation's path/param matcher
 * does not model, and the screens they lead to have to win over whatever is
 * currently on screen — including a signed-in session, because "reset my
 * password" is exactly what someone does when they think another person has
 * their account. Rendering them above the navigator sidesteps both problems.
 *
 * Both the cold-start URL and links that arrive while the app is already open
 * are handled: on Android a running app receives the second kind, and only the
 * second kind, which is the case that silently does nothing if you only ask for
 * the initial URL.
 */
function useAuthDeepLink() {
  const [link, setLink] = useState<AuthLinkResult>(null);
  const [initialLinkReady, setInitialLinkReady] = useState(false);

  useEffect(() => {
    let active = true;

    Linking.getInitialURL()
      .then((url) => {
        if (active && url) {
          const parsed = parseAuthDeepLink(url);
          if (parsed) setLink(parsed);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setInitialLinkReady(true);
      });

    const sub = Linking.addEventListener("url", ({ url }) => {
      const parsed = parseAuthDeepLink(url);
      if (parsed) setLink(parsed);
    });

    return () => {
      active = false;
      sub.remove();
    };
  }, []);

  return { link, initialLinkReady, dismiss: useCallback(() => setLink(null), []) };
}

function Root({ fontsReady }: { fontsReady: boolean }) {
  const { profile, loading } = useAuth();
  const { link, initialLinkReady, dismiss } = useAuthDeepLink();

  // Restoring the session from the device keystore is async, so the app waits
  // here rather than flashing Login at an already-signed-in user. A cold
  // email link must also resolve before choosing the destination screen.
  const ready = fontsReady && !loading && initialLinkReady;
  /*
   * The launch animation gets to finish. It writes the name out beside the
   * logo, and replacing it the instant the session was restored cut it off
   * mid-word on every fast start. LaunchScreen reports when it is done: once
   * the sequence has played and its minimum time on screen (MIN_SHOW_MS, 3s
   * by product decision) has passed, never later than two seconds after that.
   */
  const [launchDone, setLaunchDone] = useState(false);
  const onLaunchFinished = useCallback(() => setLaunchDone(true), []);

  useEffect(() => {
    // Once typography and theme are ready, hand over from the native splash
    // to the animated one while session/link restoration finishes.
    if (fontsReady) SplashScreen.hideAsync().catch(() => undefined);
  }, [fontsReady]);

  if (!ready || !launchDone) {
    return <LaunchScreen fontsReady={fontsReady} onFinished={onLaunchFinished} />;
  }

  /*
   * An auth link beats whatever else is on screen.
   *
   * Two kinds reach here now: a confirmation link and the website's session
   * hand-back. Password RESET is no longer one of them — its email carries a
   * code rather than a button, so nothing opens the app from it and the reset
   * is finished on the ResetPassword screen in the auth stack instead.
   */
  if (link) {
    const tokens = "tokens" in link ? link.tokens : null;
    const linkError = "error" in link ? link.error : null;

    /*
     * Leaving one of these screens is just "stop showing it": clearing `link`
     * hands the screen back to the branch below, which shows the tabs to a
     * signed-in owner and the log-in form to everyone else. Confirmation and
     * handoff have both just ESTABLISHED a session, so that is the whole job —
     * this used to also `logout()`, which signed the owner straight back out of
     * the account they had just finished setting up.
     */
    if (link.kind === "confirm-email") {
      return <ConfirmEmailScreen tokens={tokens} linkError={linkError} onDone={dismiss} />;
    }
    if (link.kind === "session-handoff") {
      return (
        <SessionHandoffScreen
          code={"code" in link ? link.code : null}
          linkError={linkError}
          onDone={dismiss}
        />
      );
    }
  }

  return profile ? (
    <BusinessProfileProvider>
      <MainOrOnboarding />
    </BusinessProfileProvider>
  ) : (
    <AuthStack />
  );
}

/**
 * Sends an owner who has no business yet into the setup wizard.
 *
 * WHY `profiles.length === 0` IS THE ENTRY TEST. It is the fact the app already
 * depends on everywhere else — no business means no records, no targets, and
 * nothing to show — so it needs no flag of its own, and it can never catch an
 * established owner: having a profile is exactly what completing setup means.
 * See src/lib/onboardingDraft.ts.
 *
 * IT IS THE ENTRY TEST ONLY, NOT THE STAY TEST. The wizard creates the profile
 * at the end of step 2, so re-asking that question on every render evicted the
 * wizard one step before its last one. `shouldShowOnboarding` latches it.
 *
 * DISMISSAL IS RESPECTED. Someone who chose "Skip for now" is not sent back
 * here on the next launch; they get on with whatever they opened the app for
 * and resume from the prompt on the dashboard. A skip that does not skip is
 * worse than no skip button at all.
 *
 * Lives inside BusinessProfileProvider because it decides on the profile list,
 * and renders nothing until both that list and the stored dismissal have
 * resolved — the alternative is a flash of the tab bar before the wizard
 * replaces it, which reads as a glitch.
 */
function MainOrOnboarding() {
  const t = useTheme();
  const { profile: user } = useAuth();
  const { profiles, selected, loading } = useBusinessProfiles();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  /** Latched once the wizard hands over, so finishing it does not re-enter it. */
  const [left, setLeft] = useState(false);
  /**
   * Set when the wizard's readiness step picked a first action, consumed on
   * mount below. Was a boolean for the importer alone; setup now ends with a
   * choice of four, and a second boolean per destination would be four latches
   * that can all be true at once.
   */
  const [pendingStart, setPendingStart] = useState<OnboardingNext | null>(null);

  useEffect(() => {
    let active = true;
    if (!user) return;
    void readOnboarding(user.id).then((stored) => {
      if (active) setDismissed(Boolean(stored.dismissed));
    });
    return () => {
      active = false;
    };
    // Keyed by the id alone: the profile object is replaced on every refresh,
    // and depending on it would re-read the keystore for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  /*
   * Deferred to an effect rather than dispatched from the wizard's callback:
   * the tabs do not exist yet at the moment the owner taps "Import CSV", so a
   * navigate() there would land on a navigator that has not mounted and be
   * silently dropped.
   */
  useEffect(() => {
    if (!pendingStart) return;
    setPendingStart(null);
    if (navigationRef.isReady()) {
      navigationRef.dispatch(
        CommonActions.navigate("Records", { screen: ONBOARDING_NEXT_SCREENS[pendingStart] }),
      );
    }
  }, [pendingStart]);

  /*
   * THE LATCH. Set the first time the wizard renders and never cleared while
   * this component is mounted — see shouldShowOnboarding in lib/onboardingDraft.ts
   * for the bug it exists to close (step 2 creates the profile, which used to
   * evict the wizard before step 3 could render).
   *
   * A ref rather than state because nothing needs to re-render when it flips:
   * it is read in the same pass that sets it, and the render that sets it is
   * already the render that shows the wizard.
   */
  const enteredWizard = useRef(false);

  // The loading gate is skipped once the wizard is up: `refresh()` flipping
  // `loading` back to true mid-setup would swap the owner's half-filled form
  // for a spinner and lose the step they were on, which is the same defect in
  // a different disguise.
  if (!enteredWizard.current && (loading || dismissed === null)) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.surfaceSunken }}>
        <ActivityIndicator color={t.brand[600]} />
      </View>
    );
  }

  if (
    shouldShowOnboarding({
      hasProfiles: profiles.length > 0,
      dismissed: dismissed === true,
      finished: left,
      entered: enteredWizard.current,
    })
  ) {
    enteredWizard.current = true;
    return (
      <OnboardingScreen
        onDone={(next) => {
          if (next) setPendingStart(next);
          setLeft(true);
        }}
      />
    );
  }

  /*
   * The product tour is mounted HERE and nowhere else.
   *
   * Inside BusinessProfileProvider, because the start gate needs the selected
   * business; around MainTabs rather than inside a screen, because the tour
   * points at the tab bar as well as at Home; and past the onboarding branch
   * above, so a brand-new owner finishes setup before being toured — the same
   * order web uses. One mount is what makes two overlays impossible.
   */
  /*
   * AiChatProvider wraps the tour and the tabs for one reason: an Ask FinSight
   * conversation must outlive the screen it was started on. Held inside a
   * screen — which is where it used to live, as that screen's useState — the
   * thread was thrown away by the navigation that took the owner to the numbers
   * they were asking about. Inside BusinessProfileProvider because a thread
   * belongs to one business; above the navigator because it must survive every
   * route change under it. Same placement web uses in AuthenticatedLayout.
   */
  /*
   * Keep screen-specific period choices above the navigator so returning to a
   * screen restores its choice. The business's month list is loaded once here.
   */
  return (
    <ReportingPeriodProvider>
      <BusinessNavigationBoundary businessProfileId={selected?.id ?? null}>
        <AiChatProvider>
          <TourProvider>
            <MainTabs />
          </TourProvider>
        </AiChatProvider>
      </BusinessNavigationBoundary>
    </ReportingPeriodProvider>
  );
}

export default function App() {
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    Font.loadAsync({
      IBMPlexSans_400Regular,
      IBMPlexSans_500Medium,
      IBMPlexSans_600SemiBold,
      IBMPlexSans_700Bold,
      IBMPlexMono_400Regular,
      IBMPlexMono_500Medium,
      IBMPlexMono_600SemiBold,
    })
      // A font failure must not block the app — React Native falls back to the
      // system face, which looks worse but is entirely usable.
      .catch(() => undefined)
      .finally(() => setFontsReady(true));
  }, []);

  /*
   * The providers mount immediately, before the fonts are in.
   *
   * This used to return early while loading fonts, which meant AuthProvider
   * did not exist yet and the session was not read from the keystore until
   * the final font had landed — two waits, one after the other, for two
   * jobs that have nothing to do with each other. Root holds the screen back
   * until both are done, so nothing renders early; they just now overlap.
   */
  return (
    // GestureHandlerRootView must be the OUTERMOST view, above the navigation
    // container. Swipeable record rows do nothing at all on Android without
    // it — and fail silently rather than erroring, which is the worst way for
    // a gesture to be broken.
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/*
        ThemeProvider sits above everything that paints, including the
        NavigationContainer (whose own theme is built from the palette) and
        AuthProvider (because the login screen is the first thing drawn on a
        cold start and must already be the right colour).
      */}
      <ThemeProvider>
        <SafeAreaProvider>
          <AppErrorBoundary>
            <Themed fontsReady={fontsReady} />
          </AppErrorBoundary>
        </SafeAreaProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Everything below the theme, so it can read the palette.
 *
 * Its own component because `useTheme` cannot be called in `App` — the
 * provider is rendered there, and a component cannot consume a context it is
 * itself mounting.
 */
function Themed({ fontsReady }: { fontsReady: boolean }) {
  const t = useTheme();
  const { ready: themeReady } = useThemeControl();

  return (
    <>
      {/* Screen-specific bars (including the dark launch plate) override this default. */}
      <StatusBar barStyle={t.statusBarStyle === "dark" ? "dark-content" : "light-content"} backgroundColor={t.surface} />
      <NavigationContainer ref={navigationRef} theme={navThemeFor(t)}>
        <AuthProvider>
          <Root fontsReady={fontsReady && themeReady} />
        </AuthProvider>
      </NavigationContainer>
    </>
  );
}
