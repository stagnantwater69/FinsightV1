import { useState } from "react";
import { ScrollView, View } from "react-native";
import { ErrorNote, Screen, SegmentedControl, T } from "../components/ui";
import { Row, Section } from "../components/SettingsList";
import { useAuth, errorMessage } from "../context/AuthContext";
import { useThemeControl } from "../context/ThemeContext";
import { useTourOptional } from "../context/TourContext";
import { space } from "../theme/tokens";
import type { ThemeMode } from "../theme/palette";

/**
 * How this app behaves for this owner.
 *
 * WHY IT IS A SCREEN AND NOT THE "Preferences" CARD IT REPLACES. That card
 * held two tour rows on the way past Help and Legal. There are now three
 * separate things an owner can change — the tour, Fin's daily message on Home,
 * and light or dark — and none of them is a thing you scroll past to reach
 * something else. Behind one row in More, each gets the room to say what it
 * does, and "open Settings" becomes an instruction that can be given over the
 * phone.
 *
 * THREE GROUPS, ONE HEADING EACH, rather than the two-level General /
 * Personalization structure the website uses. This screen is written in the
 * list language More established — a heading, a card, rows with a medallion
 * and a two-line explanation — and a heading over a heading would be a second
 * grammar invented for three cards. The names are what the owner would call
 * them, not categories.
 *
 * SAVE HAPPENS ON THE TAP. Nothing here has a Save button: each control writes
 * immediately, optimistically, and puts itself back with a message if the
 * account refuses the change (see lib/preferences.ts). A settings form with a
 * Save button is a form you can lose, and none of these settings is worth a
 * confirmation step.
 */

export function SettingsScreen({ navigation }: any) {
  const { preferences, updatePreferences } = useAuth();
  const { mode, setMode } = useThemeControl();
  const tour = useTourOptional();
  const [error, setError] = useState<string | null>(null);

  /** Every switch on this screen goes through here, so they all fail alike. */
  async function write(change: () => Promise<void>) {
    setError(null);
    try {
      await change();
    } catch (err) {
      // The control has already put itself back by the time this runs; this is
      // only the sentence saying why it did.
      setError(errorMessage(err));
    }
  }

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.lg }}
      >
        {/*
          One message for the whole screen, at the top where it cannot be
          missed. Per-row errors would mean four places to look for one
          sentence that says the same thing every time: the change did not
          reach the account.
        */}
        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {/*
          THE TOUR IS ONLY RENDERED WHERE IT EXISTS. `useTourOptional` returns
          null outside the signed-in navigator, and a switch that silently
          stores nothing is worse than no switch. The reasoning is carried over
          from the More screen this section came from, unchanged.
        */}
        {tour ? (
          <Section title="Guided tour">
            <Row
              first
              icon="play-circle-outline"
              label="Always show the tour on login"
              detail="Replays the guided tour every time you sign in. Meant for demos and setting up a new phone — leave it off once you know your way around."
              toggle={{ value: tour.alwaysShow }}
              onPress={() => void write(() => tour.setAlwaysShow(!tour.alwaysShow))}
            />
            <Row
              icon="refresh-outline"
              label="Restart product tour"
              detail="Walks through the app again from the beginning, starting on your Home screen"
              onPress={() => {
                tour.restart();
                // The tour's targets are Home's and the tab bar's, so it opens
                // there — restart() only re-arms it, and the gate does the rest
                // once Home is focused with its figures in.
                navigation.navigate("Dashboard");
              }}
            />
          </Section>
        ) : null}

        <Section title="Daily mascot message">
          <Row
            first
            icon="chatbubble-ellipses-outline"
            label="Show Fin's daily message"
            detail="Show daily tips and helpful messages from the FinSight mascot on your Home screen."
            toggle={{ value: preferences.showDashboardMascotMessage }}
            onPress={() =>
              void write(() =>
                updatePreferences({
                  showDashboardMascotMessage: !preferences.showDashboardMascotMessage,
                }),
              )
            }
          />
        </Section>

        {/*
          APPEARANCE, as a segmented control rather than two more rows.

          Light and Dark are one choice with two answers, and a pair of
          switches would let an owner set both or neither. The segmented
          control is the app's existing "one of these" control — the same one
          the insight screens and the period switchers use — so this introduces
          no new shape, no new colour and no new motion.

          TWO OPTIONS ONLY, deliberately: no system/auto. "What did I pick" has
          exactly one answer here, and following the OS would make the app
          change appearance on its own at sunset with nothing in Settings to
          explain it. See lib/themeStore.ts.
        */}
        <Section title="Appearance">
          <View style={{ paddingVertical: space.sm, gap: space.md }}>
            <T variant="caption">
              Applies to this phone only, so a dark screen at the stall in the evening does not follow you onto
              another device.
            </T>
            <SegmentedControl<ThemeMode>
              accessibilityLabel="Appearance"
              options={
                [
                  { label: "Light", value: "light", icon: "sunny-outline" },
                  { label: "Dark", value: "dark", icon: "moon-outline" },
                ] as const
              }
              value={mode}
              onChange={setMode}
            />
          </View>
        </Section>
      </ScrollView>
    </Screen>
  );
}
