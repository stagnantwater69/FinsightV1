import type { ReactNode } from "react";
import { ScrollView } from "react-native";
import { Screen, T } from "../../components/ui";
import { useTheme } from "../../context/ThemeContext";
import { space, typeScale } from "../../theme/tokens";

/** Native navigation provides the title and Back; help content shares a reading width. */
export function HelpPage({ intro, children }: { intro: string; children: ReactNode }) {
  const t = useTheme();
  return (
    <Screen>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          width: "100%",
          maxWidth: 720,
          alignSelf: "center",
          padding: space.lg,
          paddingBottom: space.xxl * 2,
          gap: space.xxl,
        }}
      >
        <T style={{ color: t.textSecondary, fontSize: typeScale.body, lineHeight: 23 }}>{intro}</T>
        {children}
      </ScrollView>
    </Screen>
  );
}
