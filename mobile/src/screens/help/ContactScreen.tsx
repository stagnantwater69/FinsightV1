import { useState } from "react";
import { Linking, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Button, Card, ErrorNote, T } from "../../components/ui";
import { Row, Section } from "../../components/SettingsList";
import { useTheme } from "../../context/ThemeContext";
import { SUPPORT_EMAIL } from "../../lib/helpContent";
import { space, typeScale } from "../../theme/tokens";
import { HelpPage } from "./HelpPage";

export function ContactScreen({ navigation }: { navigation: { navigate: (screen: string) => void } }) {
  const t = useTheme();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The shared development address is a placeholder, not a functioning inbox.
  const emailAvailable = Boolean(SUPPORT_EMAIL) && !SUPPORT_EMAIL.toLowerCase().endsWith(".example");

  async function openEmail() {
    if (!emailAvailable || opening) return;
    setOpening(true);
    setError(null);
    try {
      await Linking.openURL(`mailto:${SUPPORT_EMAIL}`);
    } catch {
      setError("We couldn't open your email app. Press and hold the address above to copy it into your preferred mail app.");
    } finally {
      setOpening(false);
    }
  }

  return (
    <HelpPage intro="Find help with your account, records, or a receipt that did not scan as expected.">
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, marginBottom: space.md }}>
          <Ionicons name="mail-outline" size={24} color={t.brandText} accessible={false} />
          <T variant="title" accessibilityRole="header" style={{ flex: 1 }}>Email support</T>
        </View>
        {emailAvailable ? (
          <View style={{ gap: space.md }}>
            <T style={{ fontSize: typeScale.bodySm }}>Tell us what happened and what you were trying to do.</T>
            <T selectable style={{ color: t.brandText, fontSize: typeScale.body }}>{SUPPORT_EMAIL}</T>
            <Button title="Open email app" variant="brand" loading={opening} onPress={openEmail} />
            {error ? <ErrorNote>{error}</ErrorNote> : null}
          </View>
        ) : (
          <View style={{ gap: space.xs }}>
            <T style={{ color: t.textPrimary }}>Email support is not available yet.</T>
            <T style={{ fontSize: typeScale.bodySm }}>
              A support address has not been set up for this version of FinSight. You can use the guides below in the meantime.
            </T>
          </View>
        )}
      </Card>
      <Section title="Find help in the app">
        <Row first expandedDetail icon="help-circle-outline" label="Questions & answers"
          detail="Find answers about receipt scanning, your data, and FinSight's limits."
          onPress={() => navigation.navigate("Faqs")} />
        <Row expandedDetail icon="book-outline" label="Tutorials"
          detail="Follow the written guides, from business setup to understanding your figures."
          onPress={() => navigation.navigate("Tutorials")} />
      </Section>
      <View style={{ gap: space.md }}>
        <T variant="title" accessibilityRole="header">If a receipt was read incorrectly</T>
        <T style={{ fontSize: typeScale.bodySm }}>The most useful details to include in a report are:</T>
        {[
          "The shop the receipt came from",
          "What was printed on the receipt",
          "What FinSight read instead",
        ].map((detail) => (
          <View key={detail} style={{ flexDirection: "row", gap: space.sm }}>
            <Ionicons name="checkmark" size={18} color={t.brandText} accessible={false} />
            <T style={{ flex: 1, fontSize: typeScale.bodySm }}>{detail}</T>
          </View>
        ))}
        <T style={{ fontSize: typeScale.bodySm, color: t.textMuted }}>
          You do not need to send the photo — the description is usually enough.
        </T>
      </View>
    </HelpPage>
  );
}
