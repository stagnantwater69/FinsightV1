import { useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ContentScrollView } from "../components/ContentScrollView";
import { ErrorNote, Screen, T } from "../components/ui";
import { ThemePicker } from "../components/ThemePicker";
import { Row } from "../components/SettingsList";
import { SubpageCard, SubpageHeader } from "../components/SubpageKit";
import { useAuth, errorMessage } from "../context/AuthContext";
import { useTheme, useThemeControl } from "../context/ThemeContext";
import { useTourOptional } from "../context/TourContext";
import { space, typeScale } from "../theme/tokens";
import type { MoreScreenProps } from "../navigation/types";

/** Appearance is device-local; account switches save immediately. */
export function SettingsScreen({ navigation }: MoreScreenProps<"Settings">) {
  const { preferences, updatePreferences } = useAuth();
  const { mode, preference, setPreference } = useThemeControl();
  const { textSecondary, textMuted, brandText } = useTheme();
  const tour = useTourOptional();
  const insets = useSafeAreaInsets();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const writing = useRef(false);

  async function write(change: () => Promise<void>) {
    if (writing.current) return;
    writing.current = true;
    setError(null);
    setSaving(true);
    try {
      await change();
    } catch (err) {
      // Preference updates restore their previous state on failure.
      setError(errorMessage(err));
    } finally {
      writing.current = false;
      setSaving(false);
    }
  }

  return (
    <Screen>
      <SubpageHeader title="Settings" onBack={() => {
        if (navigation.canGoBack?.() !== false && navigation.goBack) navigation.goBack();
        else navigation.navigate("MoreHome");
      }} />
      <ContentScrollView
        contentContainerStyle={{ padding: space.lg, paddingTop: space.xs, paddingBottom: Math.max(insets.bottom, space.lg) + space.lg, gap: space.md }}
      >
        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <SubpageCard title="Appearance" icon="sunny-outline">
          <View style={{ paddingVertical: space.xs, gap: space.md }}>
            <ThemePicker
              options={[
                { label: "Light", value: "light" },
                { label: "Dark", value: "dark" },
                { label: "Auto", value: "system" },
              ]}
              value={preference}
              onChange={setPreference}
            />
            <T style={{ color: textSecondary, fontSize: typeScale.bodySm, lineHeight: 20 }}>
              Auto follows your phone&apos;s appearance.
            </T>
            {preference === "system" ? (
              <T style={{ color: textMuted, fontSize: typeScale.bodySm, lineHeight: 20 }}>
                Your phone is set to {mode === "dark" ? "Dark" : "Light"} right now.
              </T>
            ) : null}
          </View>
        </SubpageCard>

        <SubpageCard title="Notifications" icon="notifications-outline">
          <Row
            focusRingColor={brandText}
            first
            icon="notifications-outline"
            label="Notification settings"
            detail="Targets, quiet hours and frequency"
            onPress={() => navigation.navigate("RecoveryNotificationPreferences")}
          />
        </SubpageCard>

        <SubpageCard title="Guidance" icon="compass-outline">
          <Row
            focusRingColor={brandText}
            first
            disabled={saving}
            icon="chatbubble-ellipses-outline"
            label="Fin's daily message"
            detail="Helpful messages on Home"
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
                focusRingColor={brandText}
                disabled={saving}
                icon="play-circle-outline"
                label="Tour on sign-in"
                detail="Replay the guided introduction"
                toggle={{ value: tour.alwaysShow }}
                onPress={() => void write(() => tour.setAlwaysShow(!tour.alwaysShow))}
              />
              <Row
                focusRingColor={brandText}
                icon="refresh-outline"
                label="Restart product tour"
                detail="Start again from Home"
                onPress={() => {
                  // The tour targets Home and the tab bar; focus Home after re-arming it.
                  tour.restart();
                  navigation.navigate("Dashboard", { screen: "DashboardHome" });
                }}
              />
            </>
          ) : null}
        </SubpageCard>
        <T variant="caption" style={{ textAlign: "center" }}>Appearance and guidance changes save automatically.</T>
      </ContentScrollView>
    </Screen>
  );
}
