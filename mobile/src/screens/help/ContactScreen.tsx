import { useRef, useState } from "react";
import { Linking, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, ErrorNote, T } from "../../components/ui";
import { SubpageCard } from "../../components/SubpageKit";
import { useTheme } from "../../context/ThemeContext";
import { SUPPORT_EMAIL } from "../../lib/helpContent";
import { font, radius, space, typeScale } from "../../theme/tokens";
import { HelpGroup, HelpIcon, HelpLink, HelpNumber, HelpPage, type HelpNavigation } from "./HelpPage";

export function ContactScreen({ navigation }: { navigation: HelpNavigation }) {
  const t = useTheme();
  const [opening, setOpening] = useState(false);
  const openingRequest = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // The shared development address is a placeholder, not a functioning inbox.
  const emailAvailable = Boolean(SUPPORT_EMAIL) && !SUPPORT_EMAIL.toLowerCase().endsWith(".example");

  async function openEmail() {
    if (!emailAvailable || openingRequest.current) return;
    openingRequest.current = true;
    setOpening(true);
    setError(null);
    try {
      await Linking.openURL(`mailto:${SUPPORT_EMAIL}`);
    } catch {
      setError("We couldn't open your email app. Press and hold the address above to copy it into your preferred mail app.");
    } finally {
      openingRequest.current = false;
      setOpening(false);
    }
  }

  return (
    <HelpPage title="Contact us" navigation={navigation} intro="Help with your account, records, or a receipt scan.">
      <SubpageCard tone="mint" style={{ gap: space.lg }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <HelpIcon name="mail-outline" />
          <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
            <T variant="title" accessibilityRole="header" style={{ color: t.textPrimary }}>Email support</T>
            {emailAvailable ? <T variant="caption">Use your preferred email app</T> : (
              <View style={{ alignSelf: "flex-start", backgroundColor: t.surface, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs }}>
                <T style={{ fontSize: typeScale.bodySm, color: t.brandText }}>Not available yet</T>
              </View>
            )}
          </View>
        </View>
        {emailAvailable ? (
          <View style={{ gap: space.md }}>
            <T style={{ fontSize: typeScale.bodySm }}>Tell us what happened and what you were trying to do.</T>
            <T selectable style={{ color: t.brandText, fontSize: typeScale.body }}>{SUPPORT_EMAIL}</T>
            <Button title="Open email app" variant="primary" loading={opening} onPress={openEmail} />
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
      </SubpageCard>
      <HelpGroup title="Find help in the app" icon="help-circle-outline">
        <HelpLink first icon="help-circle-outline" title="Questions & answers"
          detail="Find answers about receipt scanning, your data, and FinSight's limits."
          onPress={() => navigation.navigate("Faqs")} />
        <HelpLink icon="school-outline" title="Tutorials"
          detail="Follow the written guides, from business setup to understanding your figures."
          onPress={() => navigation.navigate("Tutorials")} />
      </HelpGroup>
      <SubpageCard title="Receipt read incorrectly?" icon="receipt-outline">
        <T style={{ fontSize: typeScale.bodySm }}>The most useful details to include in a report are:</T>
        <View style={{ paddingVertical: space.md, gap: space.sm }}>
          {[
            "The shop the receipt came from",
            "What was printed on the receipt",
            "What FinSight read instead",
          ].map((detail, index) => (
            <View key={detail} style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
              <HelpNumber value={index + 1} padded={false} />
              <T style={{ flex: 1, color: t.textPrimary, fontFamily: font.sansMedium, fontSize: typeScale.bodySm }}>{detail}</T>
            </View>
          ))}
        </View>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: t.border }}>
          <Ionicons name="information-circle-outline" size={22} color={t.brandText} accessibilityElementsHidden importantForAccessibility="no" />
          <T style={{ flex: 1, fontSize: typeScale.bodySm, color: t.textSecondary }}>
            You do not need to send the photo. The description is usually enough.
          </T>
        </View>
      </SubpageCard>
    </HelpPage>
  );
}
