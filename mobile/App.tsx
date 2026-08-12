import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, Modal, Pressable, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import {
  NavigationContainer,
  CommonActions,
  DefaultTheme,
  createNavigationContainerRef,
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
import { OnboardingResumeScreen, OnboardingScreen } from "./src/screens/OnboardingScreens";
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
import {
  AddExpenseScreen,
  AddSalesScreen,
  EditRecordScreen,
  FlaggedRecordsScreen,
  ImportCsvScreen,
  RecordsScreen,
  ScanReceiptScreen,
} from "./src/screens/RecordsScreens";
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
import {
  BusinessProfileFormScreen,
  BusinessProfilesScreen,
  ProfileScreen,
} from "./src/screens/BusinessScreens";
import { ACCENT, brand, categorical, categoricalOnColor, font, ink, paper } from "./src/theme/tokens";
import { recordsTabPressAction, RECORDS_LIST_SCREEN } from "./src/lib/tabSelection";
import { ReceiptCamera } from "./src/components/receipt-camera";
import { QuickActionMenu, type RadialAction } from "./src/components/QuickActionMenu";
import { handOffSections } from "./src/lib/receiptHandoff";

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

const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: brand[600],
    background: paper[50],
    card: paper.DEFAULT,
    text: ink[900],
    border: brand[100],
  },
};

const screenOptions = {
  headerStyle: { backgroundColor: paper.DEFAULT },
  headerTitleStyle: { fontFamily: font.display, color: brand[900] },
  headerTintColor: brand[700],
} as const;

/**
 * The Dashboard needs a stack of its own so it can push the alerts list —
 * web reaches the same screen from the bell in its header.
 */
function DashboardStack() {
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
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="MoreHome" component={MoreScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Profile" component={ProfileScreen} options={{ title: "My account" }} />
      <Stack.Screen name="BusinessProfiles" component={BusinessProfilesScreen} options={{ title: "Businesses" }} />
      <Stack.Screen name="BusinessProfileForm" component={BusinessProfileFormScreen} options={{ title: "Business profile" }} />
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
function ScanTabButton({ onPress, active }: { onPress: () => void; active: boolean }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "flex-start" }}>
      {/*
        The selected halo, drawn BEHIND the button rather than as another
        border on it. A third concentric ring on the button itself would fight
        the white one that lifts it off the bar; a soft disc behind reads as
        the same highlight the other tabs get, in the same brand family.
      */}
      {active ? (
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
            backgroundColor: brand[100],
          }}
        />
      ) : null}
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={active ? "Close the actions menu" : "Add a record"}
        // Announced as selected, so a screen reader says the same thing the
        // halo does rather than leaving the state visual-only.
        accessibilityState={{ selected: active }}
        style={({ pressed }) => ({
          width: 54,
          height: 54,
          borderRadius: 27,
          marginTop: -20,
          alignItems: "center",
          justifyContent: "center",
          // Deeper while scanning, so the button reads as engaged even where
          // the halo is hard to see — a dark phone in daylight, say.
          backgroundColor: pressed || active ? brand[800] : brand[700],
          // A ring in the bar's own colour so the circle reads as sitting
          // above the bar rather than punched through it.
          borderWidth: 4,
          borderColor: paper.DEFAULT,
          shadowColor: ink[900],
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.18,
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
        <Ionicons name={active ? "close" : "add"} size={30} color="#fff" />
      </Pressable>
    </View>
  );
}


function MainTabs() {
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
   * The receipt camera, owned by the tab bar rather than by a screen.
   *
   * This is what lets the Scan button be an ACTION instead of a destination.
   * The camera opens over whatever the owner was already looking at, and
   * closing it puts them back there with no navigation having happened at
   * all — see receiptHandoff.ts for the full account of why the previous
   * arrangement kept breaking the Records tab.
   */
  const [cameraOpen, setCameraOpen] = useState(false);
  /**
   * The five actions the raised button now offers instead of going straight
   * to the camera. See components/QuickActionMenu for why it is an arc.
   */
  const [menuOpen, setMenuOpen] = useState(false);

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
      color: categorical[2],
      onColor: categoricalOnColor[2],
      onPress: () => openInRecords("AddSales"),
    },
    {
      key: "scan",
      label: "Scan receipt",
      icon: "camera-outline",
      // The middle of the arc, in FinSight's own green: still the action the
      // button is for, just no longer the only one it can reach.
      color: brand[700],
      onColor: "#ffffff",
      onPress: () => setCameraOpen(true),
    },
    {
      key: "csv",
      label: "Import CSV",
      icon: "cloud-upload-outline",
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
       * No special-casing of the Records tab any more.
       *
       * It used to have to surrender its highlight while the scanner was
       * open, because the scanner was a screen ON the Records stack and so
       * lit up Records rather than the button the owner had pressed. The
       * camera is a modal now and lights its own button, and `ScanReceipt`
       * is what it always should have been — an ordinary Records screen where
       * a scanned receipt gets reviewed. Records highlighting there is
       * correct rather than something to work around.
       */
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: brand[700],
        tabBarInactiveTintColor: ink[500],
        tabBarStyle: {
          backgroundColor: paper.DEFAULT,
          borderTopColor: paper[200],
          height: 60 + insets.bottom,
          paddingTop: 6,
          paddingBottom: 8 + insets.bottom,
        },
        tabBarLabelStyle: { fontFamily: font.sansMedium, fontSize: 11 },
        tabBarIcon: ({ color, focused }) => {
          const pair = TAB_ICONS[route.name];
          return <Ionicons name={pair ? pair[focused ? 1 : 0] : "ellipse-outline"} size={22} color={color} />;
        },
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
        options={{
          tabBarLabel: "",
          tabBarButton: (props) => (
            <ScanTabButton
              onPress={() => props.onPress?.({} as never)}
              active={menuOpen || cameraOpen}
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

    <QuickActionMenu visible={menuOpen} actions={quickActions} onClose={() => setMenuOpen(false)} />

    {/*
      `statusBarTranslucent` so the preview runs edge to edge; the camera's
      own SafeAreaView keeps its controls clear of the status bar.

      `onRequestClose` is the Android back button and must be handled, or the
      modal dismisses without telling this component and `cameraOpen` stays
      true — after which the Scan button appears permanently lit and does
      nothing.
    */}
    <Modal
      visible={cameraOpen}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => setCameraOpen(false)}
    >
      {/* Mounted only while visible, so the sensor and torch stop with it. */}
      {cameraOpen ? (
        <ReceiptCamera
          onCancel={() => setCameraOpen(false)}
          onDone={(sections) => {
            setCameraOpen(false);
            /*
             * Handed over out of band, not as a route param — params persist
             * on the route and get replayed by the tab handler, which is the
             * exact fault this rearrangement removed. See receiptHandoff.ts.
             *
             * Navigating only on FINISH is the point: the owner is sent to
             * the review screen because there is now a receipt to read, not
             * because they pressed a button.
             */
            handOffSections(sections);
            // Same route as every other action here — see openInRecords for
            // why the nested-params form is the only one that arrives.
            openInRecords("ScanReceipt");
          }}
        />
      ) : null}
    </Modal>
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
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: paper[50] }}>
        <ActivityIndicator color={brand[600]} />
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
  const { profile: user } = useAuth();
  const { profiles, loading } = useBusinessProfiles();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  /** Latched once the wizard hands over, so finishing it does not re-enter it. */
  const [left, setLeft] = useState(false);
  /** Set when the wizard's last step asked for the importer, consumed on mount below. */
  const [pendingImport, setPendingImport] = useState(false);

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
    if (!pendingImport) return;
    setPendingImport(false);
    if (navigationRef.isReady()) {
      navigationRef.dispatch(CommonActions.navigate("Records", { screen: "ImportCsv" }));
    }
  }, [pendingImport]);

  if (loading || dismissed === null) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: paper[50] }}>
        <ActivityIndicator color={brand[600]} />
      </View>
    );
  }

  if (profiles.length === 0 && !dismissed && !left) {
    return (
      <OnboardingScreen
        onDone={(next) => {
          if (next === "import") setPendingImport(true);
          setLeft(true);
        }}
      />
    );
  }

  return <MainTabs />;
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
      <SafeAreaProvider>
        <NavigationContainer ref={navigationRef} theme={navTheme}>
          <AuthProvider>
            <Root fontsReady={fontsReady} />
          </AuthProvider>
        </NavigationContainer>
        <StatusBar style="dark" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
