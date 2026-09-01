import { useState } from "react";
import { ScrollView, View } from "react-native";
import { ErrorNote, Screen, SegmentedControl, T } from "../components/ui";
import { Row, Section } from "../components/SettingsList";
import { useAuth, errorMessage } from "../context/AuthContext";
import { useThemeControl } from "../context/ThemeContext";
import { useTourOptional } from "../context/TourContext";
import { space } from "../theme/tokens";
import type { ThemePreference } from "../theme/palette";

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
  const { mode, preference, setPreference } = useThemeControl();
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

        {/*
          Recovery Target Improvement Plan §7.5/§10.8/§11 Phase 6. A
          destination row, not a switch here, because the screen behind it is
          a whole record with its own cross-field rules (a threshold percent,
          quiet hours, a cooldown) — the same reason Operating schedule below
          is a destination and not a row of switches on this screen.
        */}
        <Section title="Recovery target">
          <Row
            first
            icon="notifications-outline"
            label="Notification settings"
            detail="Choose when FinSight alerts you about changes to your Sales Coverage Target — target increases, falling behind pace, and reaching your goal."
            onPress={() => navigation.navigate("RecoveryNotificationPreferences")}
          />
        </Section>

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
          APPEARANCE, as a segmented control rather than three more rows.

          Light, Dark and "the phone decides" are one choice with three
          answers, and a set of switches would let an owner set all of them or
          none. The segmented control is the app's existing "one of these"
          control — the same one the insight screens and the period switchers
          use — so this introduces no new shape, no new colour and no new
          motion.

          "AUTO" RATHER THAN "SYSTEM" ON THE CHIP because three chips share one
          row on a 360dp phone at a scaled-up font, and "Use device setting"
          does not fit in a third of it. The full sentence is in the caption
          above and in the accessible label below, where there is room for it —
          the chip is the short name, not the explanation.

          BOUND TO `preference`, NOT `mode`. With Auto selected, `mode` is
          whichever palette the phone is currently doing; a control bound to it
          would show Light or Dark as the selected chip and quietly lose the
          owner's actual answer the first time they opened this screen.
        */}
        <Section title="Appearance">
          <View style={{ paddingVertical: space.sm, gap: space.md }}>
            <T variant="caption">
              Auto follows your phone&apos;s light or dark setting. Applies to this phone only, so a dark screen at
              the stall in the evening does not follow you onto another device.
            </T>
            <SegmentedControl<ThemePreference>
              accessibilityLabel="Appearance"
              options={
                [
                  { label: "Light", value: "light", icon: "sunny-outline" },
                  { label: "Dark", value: "dark", icon: "moon-outline" },
                  { label: "Auto", value: "system", icon: "phone-portrait-outline" },
                ] as const
              }
              value={preference}
              onChange={setPreference}
            />
            {/*
              What Auto currently RESOLVES TO, said in words. "Auto" alone
              leaves an owner unable to tell a broken setting from a phone
              that is simply in Light mode right now, and it is the one line
              that makes the chip's effect checkable without leaving Settings.
            */}
            {preference === "system" ? (
              <T variant="caption">
                Your phone is set to {mode === "dark" ? "Dark" : "Light"} right now.
              </T>
            ) : null}
          </View>
        </Section>
      </ScrollView>
    </Screen>
  );
}
