import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import {
  NavigationContainer,
  CommonActions,
  DefaultTheme,
  createNavigationContainerRef,
  getFocusedRouteNameFromRoute,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as Font from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from "@expo-google-fonts/inter";
import { Sora_600SemiBold, Sora_700Bold } from "@expo-google-fonts/sora";
import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
  IBMPlexMono_600SemiBold,
} from "@expo-google-fonts/ibm-plex-mono";

import { AuthProvider, useAuth } from "./src/context/AuthContext";
import { BusinessProfileProvider, useBusinessProfiles } from "./src/context/BusinessProfileContext";
import { TourProvider, useTourOptional } from "./src/context/TourContext";
import { AiChatProvider } from "./src/context/AiChatContext";
import { useTourTarget } from "./src/components/tour/targets";
import { QUICK_ADD_STEP_IDS, type TourTargetKey } from "./src/components/tour/steps";
import {
  ONBOARDING_NEXT_SCREENS,
  OnboardingResumeScreen,
  OnboardingScreen,
  type OnboardingNext,
} from "./src/screens/OnboardingScreens";
import { readOnboarding } from "./src/lib/onboardingDraft";
import {
  LoginScreen,
  RegisterScreen,
  RecoverPasswordScreen,
  ResetPasswordScreen,
  ConfirmEmailScreen,
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
import type { Palette } from "./src/theme/palette";
import { ThemeProvider, useTheme, useThemeControl } from "./src/context/ThemeContext";
import { recordsTabPressAction, RECORDS_LIST_SCREEN } from "./src/lib/tabSelection";
import { QuickActionMenu, type RadialAction } from "./src/components/QuickActionMenu";

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

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

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
  } as const;
}

/**
 * The Dashboard needs a stack of its own so it can push the alerts list —
 * web reaches the same screen from the bell in its header.
 */
function DashboardStack() {
  const screenOptions = useScreenOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      {/*
        headerShown: false — DashboardScreen (now Home) builds its own header
        with an avatar, a business switcher and a bell, which replaces both
        this native title bar and the eyebrow/title ScreenHeader every other
        screen uses. Same pattern MoreStack already uses for MoreHome.
      */}
      <Stack.Screen name="DashboardHome" component={DashboardScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Notifications" component={NotificationsScreen} options={{ title: "Alerts" }} />
      {/* How someone who chose "Skip for now" gets back into setup — the
          wizard draws its own header, so this one is hidden. */}
      <Stack.Screen name="Onboarding" component={OnboardingResumeScreen} options={{ headerShown: false }} />
    </Stack.Navigator>
  );
}

function RecordsStack() {
  const screenOptions = useScreenOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      {/*
        headerShown: false, like Home, Insights and More.

        The native header printed "Records" directly above the screen's own
        "Records" heading — the same word twice, one under the other, with
        nothing between them. The list is the tab's root, so the header also
        had no back arrow to justify itself. Every screen PUSHED from here
        keeps its header, because those do have somewhere to go back to.
      */}
      <Stack.Screen name="RecordsList" component={RecordsScreen} options={{ headerShown: false }} />
      <Stack.Screen name="AddExpense" component={AddExpenseScreen} options={{ title: "Add expense" }} />
      <Stack.Screen name="AddSales" component={AddSalesScreen} options={{ title: "Add sales" }} />
      {/*
        Tapping a record on the list navigates here. This was missing: the
        list has always called navigate("EditRecord"), so every tap resolved
        to nothing and a saved record could not be corrected on mobile at all.
      */}
      <Stack.Screen name="EditRecord" component={EditRecordScreen} options={{ title: "Edit record" }} />
      <Stack.Screen name="ScanReceipt" component={ScanReceiptScreen} options={{ title: "Scan receipt" }} />
      <Stack.Screen name="ImportCsv" component={ImportCsvScreen} options={{ title: "Import CSV" }} />
      <Stack.Screen name="FlaggedRecords" component={FlaggedRecordsScreen} options={{ title: "Review" }} />
      {/*
        In the Records stack rather than under More, because a category is a
        records concept — the screen's own "view records" route goes straight
        back to RecordsList, which only works without a stack hop from here.
      */}
      <Stack.Screen name="Categories" component={CategoriesScreen} options={{ title: "Categories" }} />
    </Stack.Navigator>
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
    <Stack.Navigator screenOptions={{ ...screenOptions, headerShown: false }}>
      <Stack.Screen name="ExpenseBehavior" component={ExpenseBehaviorScreen} />
      <Stack.Screen name="SpendingImpact" component={SpendingImpactScreen} />
      <Stack.Screen name="RecoveryTarget" component={RecoveryTargetScreen} />
      {/*
        The one screen in this stack that IS pushed onto something, so it is
        the one that keeps a header: it has a parent to go back to (the
        Recurring tab of Expense insight), and without the native header the
        only way out would be the hardware back button.
      */}
      <Stack.Screen
        name="RecurringSchedule"
        component={RecurringScheduleScreen}
        options={{ headerShown: true, title: "Repeating payment" }}
      />
    </Stack.Navigator>
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
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="MoreHome" component={MoreScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Profile" component={ProfileScreen} options={{ title: "My account" }} />
      {/*
        How the app behaves for this owner: the guided tour, Fin's daily
        message on Home, and light or dark. It replaces the "Preferences" card
        that used to sit on the More screen itself — see SettingsScreen.tsx.
      */}
      <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: "Settings" }} />
      <Stack.Screen name="BusinessProfiles" component={BusinessProfilesScreen} options={{ title: "Businesses" }} />
      <Stack.Screen name="BusinessProfileForm" component={BusinessProfileFormScreen} options={{ title: "Business profile" }} />
      <Stack.Screen name="OperatingSchedule" component={OperatingScheduleScreen} options={{ title: "Operating schedule" }} />
      <Stack.Screen
        name="RecoveryNotificationPreferences"
        component={RecoveryNotificationPreferencesScreen}
        options={{ title: "Notification settings" }}
      />
      <Stack.Screen
        name="MonthEndReview"
        component={MonthEndReviewScreen}
        options={{ title: "Month-end review" }}
      />
      <Stack.Screen name="Notifications" component={NotificationsScreen} options={{ title: "Alerts" }} />
      {/*
        Help and legal live IN the app, not behind a link to the website.
        Most owners have a phone and no computer, so for them this is the only
        place these documents will ever be read — and Privacy and Terms are
        not optional reading to route someone off-device for.
      */}
      <Stack.Screen name="Faqs" component={FaqsScreen} options={{ title: "Questions" }} />
      <Stack.Screen name="Tutorials" component={TutorialsScreen} options={{ title: "Tutorials" }} />
      <Stack.Screen name="Contact" component={ContactScreen} options={{ title: "Contact us" }} />
      <Stack.Screen name="Privacy" component={PrivacyScreen} options={{ title: "Privacy" }} />
      <Stack.Screen name="Terms" component={TermsScreen} options={{ title: "Terms of use" }} />
    </Stack.Navigator>
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
      <Ionicons name={pair ? pair[focused ? 1 : 0] : "ellipse-outline"} size={22} color={color} />
    </View>
  );
}

/**
 * Adding something, given the middle of the bar.
 *
 * Recording what was spent and earned is what this app is FOR and the reason
 * someone opens it standing at a counter, so it gets the easiest target on
 * the screen rather than being a button two taps away.
 *
 * It used to be a camera, because it opened the camera. It now opens five
 * actions (see QuickActionMenu), so the glyph is a plus — a camera on it
 * would promise which of the five happens, to someone who has not pressed it
 * yet. The plus turns into the X that closes the menu, which is why the
 * selected state matters here and not merely as decoration.
 *
 * Raised out of the bar and drawn as a filled circle so it reads as an action
 * rather than a fifth destination.
 */
function ScanTabButton({
  onPress,
  active,
  glow,
}: {
  onPress: () => void;
  active: boolean;
  // Distinct from `active`: the halo turns on for a quick-add destination
  // screen too (AddExpense, AddSales, ScanReceipt, ImportCsv, Categories),
  // where the menu is already closed and the glyph must stay a plus, not
  // rotate into the X that means "the menu is open".
  glow?: boolean;
}) {
  const t = useTheme();
  const lit = active || glow;
  // The tour's "Receipt scanner" step points here: on a phone this raised
  // button IS the quick-add menu web spotlights.
  const tourTarget = useTourTarget("quick-add", { pad: { top: 8, bottom: 8, left: 8, right: 8 }, radius: 999 });

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "flex-start" }}>
      {/*
        The selected halo, drawn BEHIND the button rather than as another
        border on it. A third concentric ring on the button itself would fight
        the white one that lifts it off the bar; a soft disc behind reads as
        the same highlight the other tabs get, in the same brand family.
      */}
      {lit ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: -26,
            // Centred explicitly rather than relying on the parent's
            // alignItems reaching an absolutely-positioned child — it does,
            // but a halo that silently slides to one edge is not worth
            // leaving to an implicit rule.
            alignSelf: "center",
            width: 66,
            height: 66,
            borderRadius: 33,
            backgroundColor: t.brandBorder,
          }}
        />
      ) : null}
      <Pressable
        {...tourTarget}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={active ? "Close the actions menu" : "Add a record"}
        // Announced as selected, so a screen reader says the same thing the
        // halo does rather than leaving the state visual-only.
        accessibilityState={{ selected: lit }}
        style={({ pressed }) => ({
          width: 54,
          height: 54,
          borderRadius: 27,
          marginTop: -20,
          alignItems: "center",
          justifyContent: "center",
          // Deeper while scanning, so the button reads as engaged even where
          // the halo is hard to see — a dark phone in daylight, say.
          // `brandSolid`, not the brand ramp: this disc is dark teal in BOTH
          // themes. The ramp's 700 step lightens in Dark so brand TEXT stays
          // legible on a dark card, which would have turned this button into
          // a pale mint circle carrying white glyphs.
          backgroundColor: pressed || lit ? t.brandSolidPressed : t.brandSolid,
          // A ring in the bar's own colour so the circle reads as sitting
          // above the bar rather than punched through it.
          borderWidth: 4,
          borderColor: t.surface,
          shadowColor: t.shadow,
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.18 * t.shadowStrength,
          shadowRadius: 5,
          elevation: 5,
        })}
      >
        {/*
          A PLUS, not a camera.

          The button opened the camera and nothing else when it was drawn as
          one. It now offers five actions — a sale, an expense, a spreadsheet,
          a category, and yes a scan — and a camera glyph on it is a promise
          about which one happens, made to someone who has not pressed it yet.
          A plus is the universal "add something", which is exactly the set
          behind it, and it rotates into the X that closes the menu.
        */}
        <Ionicons name={active ? "close" : "add"} size={30} color={t.onBrandSolid} />
      </Pressable>
    </View>
  );
}


function MainTabs() {
  const t = useTheme();
  const { ACCENT, categorical, categoricalOnColor } = t;
  /*
   * The phone's own navigation bar sits under ours.
   *
   * React Navigation adds the bottom inset for you — but only while you leave
   * the tab bar's height alone. Setting a fixed height (which this did) throws
   * that away, and on a device with gesture or button navigation the labels end
   * up behind the system bar. The inset is added back explicitly here rather
   * than dropping the height, because the taller bar is what gives the raised
   * scan button room.
   */
  const insets = useSafeAreaInsets();

  /**
   * The five actions the raised button now offers instead of going straight
   * to the camera. See components/QuickActionMenu for why it is an arc.
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
  useEffect(() => {
    const sync = () => {
      if (!navigationRef.isReady()) return;
      const recordsRoute = navigationRef.getRootState()?.routes.find((r) => r.name === "Records");
      setRecordsFocusedScreen(recordsRoute ? getFocusedRouteNameFromRoute(recordsRoute) : undefined);
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
      label: "Expense",
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
      label: "Sales",
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
      label: "Scan receipt",
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
      label: "Import CSV",
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
      label: "Categories",
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
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: t.brandText,
        tabBarInactiveTintColor: t.textMuted,
        tabBarStyle: {
          backgroundColor: t.surface,
          borderTopColor: t.border,
          height: 60 + insets.bottom,
          paddingTop: 6,
          paddingBottom: 8 + insets.bottom,
        },
        tabBarLabelStyle: { fontFamily: font.sansMedium, fontSize: 11 },
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
        options={{
          // Muted to the same colour Insights/More get while unfocused, so
          // the tab doesn't glow for a screen the owner reached via the plus
          // button rather than by pressing Records itself.
          tabBarActiveTintColor: onQuickAddScreen ? t.textMuted : t.brandText,
        }}
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
        options={{
          tabBarLabel: "",
          tabBarButton: (props) => (
            <ScanTabButton
              onPress={() => props.onPress?.({} as never)}
              active={menuOpen}
              glow={onQuickAddScreen}
            />
          ),
        }}
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
      visible={menuOpen || tourHoldsMenu}
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

  useEffect(() => {
    let active = true;

    Linking.getInitialURL()
      .then((url) => {
        if (active && url) {
          const parsed = parseAuthDeepLink(url);
          if (parsed) setLink(parsed);
        }
      })
      .catch(() => undefined);

    const sub = Linking.addEventListener("url", ({ url }) => {
      const parsed = parseAuthDeepLink(url);
      if (parsed) setLink(parsed);
    });

    return () => {
      active = false;
      sub.remove();
    };
  }, []);

  return { link, dismiss: useCallback(() => setLink(null), []) };
}

function Root({ fontsReady }: { fontsReady: boolean }) {
  const t = useTheme();
  const { profile, loading, logout } = useAuth();
  const { link, dismiss } = useAuthDeepLink();

  // Restoring the session from the device keystore is async, so the app waits
  // here rather than flashing Login at an already-signed-in user. Fonts are
  // waited on in the same place because the two finish independently and
  // there is nothing worth showing until both have.
  const ready = fontsReady && !loading;

  useEffect(() => {
    // Uncovering the app is the last thing that happens, after the tree that
    // replaces the splash has been committed. hideAsync's rejection is
    // ignored for the same reason preventAutoHideAsync's is.
    if (ready) SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);

  if (!ready) {
    // Normally invisible — the native splash is still up. This is what the
    // owner sees if the splash could not be held, so it stays a real view
    // rather than null.
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.surfaceSunken }}>
        <ActivityIndicator color={t.brand[600]} />
      </View>
    );
  }

  /*
   * An auth link beats whatever else is on screen.
   *
   * Including a signed-in session: someone resetting their password is often
   * doing it BECAUSE another person has their account, and dropping them into
   * the dashboard instead would be the one outcome that helps nobody. Finishing
   * a reset ends every session anyway (the backend revokes globally), so
   * `logout` clears the now-dead local one on the way out.
   */
  if (link) {
    const tokens = "tokens" in link ? link.tokens : null;
    const linkError = "error" in link ? link.error : null;
    const finish = () => {
      dismiss();
      if (profile) void logout();
    };
    return link.kind === "reset-password" ? (
      <ResetPasswordScreen tokens={tokens} linkError={linkError} onDone={finish} />
    ) : (
      <ConfirmEmailScreen tokens={tokens} linkError={linkError} onDone={finish} />
    );
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
 * WHY `profiles.length === 0` IS THE WHOLE TEST. It is the fact the app already
 * depends on everywhere else — no business means no records, no targets, and
 * nothing to show — so it needs no flag of its own, and it can never catch an
 * established owner: having a profile is exactly what completing setup means.
 * See src/lib/onboardingDraft.ts.
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
  const { profiles, loading } = useBusinessProfiles();
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

  if (loading || dismissed === null) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.surfaceSunken }}>
        <ActivityIndicator color={t.brand[600]} />
      </View>
    );
  }

  if (profiles.length === 0 && !dismissed && !left) {
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
  return (
    <AiChatProvider>
      <TourProvider>
        <MainTabs />
      </TourProvider>
    </AiChatProvider>
  );
}

export default function App() {
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    Font.loadAsync({
      Inter_400Regular,
      Inter_500Medium,
      Inter_600SemiBold,
      Sora_600SemiBold,
      Sora_700Bold,
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
   * the eighth typeface had landed — two waits, one after the other, for two
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
          <Themed fontsReady={fontsReady} />
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
      <NavigationContainer ref={navigationRef} theme={navThemeFor(t)}>
        <AuthProvider>
          <Root fontsReady={fontsReady && themeReady} />
        </AuthProvider>
      </NavigationContainer>
      {/*
        The status bar follows the theme: dark glyphs on a light app, light
        glyphs on a dark one. Hardcoded "dark" here was invisible against a
        dark page — the clock and the battery simply disappeared.
      */}
      <StatusBar style={t.statusBarStyle} />
    </>
  );
}
