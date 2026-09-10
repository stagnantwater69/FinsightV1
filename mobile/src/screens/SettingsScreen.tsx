import { useState } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { ErrorNote, Screen, SegmentedControl, T } from "../components/ui";
import { Row, Section } from "../components/SettingsList";
import { useAuth, errorMessage } from "../context/AuthContext";
import { useTheme, useThemeControl } from "../context/ThemeContext";
import { useTourOptional } from "../context/TourContext";
import { space, typeScale } from "../theme/tokens";
import type { ThemePreference } from "../theme/palette";

/** Appearance is device-local; account switches save immediately. */
export function SettingsScreen({ navigation }: any) {
  const { preferences, updatePreferences } = useAuth();
  const { mode, preference, setPreference } = useThemeControl();
  const { textSecondary, textMuted } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const tour = useTourOptional();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function write(change: () => Promise<void>) {
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      await change();
    } catch (err) {
      // Preference updates restore their previous state on failure.
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.xxl }}
      >
        <View style={{ gap: space.xs }}>
          <T style={{ color: textSecondary }}>Make FinSight feel right for you.</T>
          <T style={{ color: textMuted, fontSize: typeScale.bodySm, lineHeight: 20 }}>
            Appearance and guidance changes save automatically.
          </T>
        </View>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <Section title="Appearance">
          <View style={{ paddingVertical: space.xs, gap: space.md }}>
            <T style={{ color: textSecondary, fontSize: typeScale.bodySm, lineHeight: 20 }}>
              Choose a theme for this phone. Auto follows your phone&apos;s light or dark setting.
            </T>
            <SegmentedControl<ThemePreference>
              accessibilityLabel="Appearance"
              stacked={width < 360 || fontScale > 1.2}
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
            {preference === "system" ? (
              <T style={{ color: textMuted, fontSize: typeScale.bodySm, lineHeight: 20 }}>
                Your phone is set to {mode === "dark" ? "Dark" : "Light"} right now.
              </T>
            ) : null}
          </View>
        </Section>

        <Section title="Notifications">
          <Row
            first
            expandedDetail
            icon="notifications-outline"
            label="Notification settings"
            detail="Manage Sales Coverage Target alerts, quiet hours, and frequency."
            onPress={() => navigation.navigate("RecoveryNotificationPreferences")}
          />
        </Section>

        <Section title="Guidance">
          <Row
            first
            expandedDetail
            disabled={saving}
            icon="chatbubble-ellipses-outline"
            label="Show Fin's daily message"
            detail="Daily tips and helpful messages from Fin on your Home screen."
            toggle={{ value: preferences.showDashboardMascotMessage }}
            onPress={() =>
              void write(() =>
                updatePreferences({
                  showDashboardMascotMessage: !preferences.showDashboardMascotMessage,
                }),
              )
            }
          />
          {tour ? (
            <>
              <Row
                expandedDetail
                disabled={saving}
                icon="play-circle-outline"
                label="Always show the tour on login"
                detail="Replay the guided tour each time you sign in. Useful for demos or getting familiar with the app."
                toggle={{ value: tour.alwaysShow }}
                onPress={() => void write(() => tour.setAlwaysShow(!tour.alwaysShow))}
              />
              <Row
                expandedDetail
                icon="refresh-outline"
                label="Restart product tour"
                detail="Take another walkthrough, starting on your Home screen."
                onPress={() => {
                  // The tour targets Home and the tab bar; focus Home after re-arming it.
                  tour.restart();
                  navigation.navigate("Dashboard");
                }}
              />
            </>
          ) : null}
        </Section>
      </ScrollView>
    </Screen>
  );
}
