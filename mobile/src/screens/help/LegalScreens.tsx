import { useRef, useState } from "react";
import { AccessibilityInfo, findNodeHandle, Platform, ScrollView, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { SubpageCard } from "../../components/SubpageKit";
import { TAP_FLOOR } from "../../components/touchTarget";
import { T } from "../../components/ui";
import { useTheme } from "../../context/ThemeContext";
import {
  LEGAL_DISCLAIMER_HEADING,
  PRIVACY_DISCLAIMER,
  PRIVACY_SECTIONS,
  TERMS_DISCLAIMER,
  TERMS_SECTIONS,
  type LegalSection,
} from "../../lib/helpContent";
import { font, radius, space, typeScale } from "../../theme/tokens";
import { HelpAction, HelpIcon, HelpNumber, HelpPage, type HelpNavigation } from "./HelpPage";

function SectionLink({ heading, number, onPress }: { heading: string; number: number; onPress: () => void }) {
  const t = useTheme();
  return (
    <HelpAction accessibilityLabel={`Jump to ${heading}`} accessibilityHint="Scrolls to this section and focuses its heading"
      onPress={onPress}
      style={({ pressed }) => ({ minHeight: TAP_FLOOR, paddingVertical: space.md, paddingHorizontal: space.xs, flexDirection: "row", alignItems: "center", gap: space.md, borderTopWidth: 1, borderTopColor: t.border, backgroundColor: pressed ? t.brandSurface : "transparent" })}>
      <HelpNumber value={number} />
      <T style={{ flex: 1, minWidth: 0, color: t.brandText, fontFamily: font.sansMedium }}>{heading}</T>
      <Ionicons name="chevron-forward-outline" size={18} color={t.brandText} accessibilityElementsHidden importantForAccessibility="no" />
    </HelpAction>
  );
}

/** Legal copy stays complete and shared with the web; presentation alone lives here. */
function LegalDocument({
  title,
  navigation,
  sections,
  disclaimer,
}: {
  title: string;
  navigation?: HelpNavigation;
  sections: LegalSection[];
  disclaimer: string;
}) {
  const t = useTheme();
  const [indexOpen, setIndexOpen] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const sectionOffsets = useRef<number[]>([]);
  const headingRefs = useRef<(View | null)[]>([]);

  function jumpToSection(index: number) {
    const offset = sectionOffsets.current[index];
    if (offset === undefined) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, offset - space.sm), animated: false });
    const heading = headingRefs.current[index];
    if (!heading) return;
    if (Platform.OS === "web") heading.focus();
    else {
      const handle = findNodeHandle(heading);
      if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
    }
  }

  return (
    <HelpPage title={title} navigation={navigation} scrollRef={scrollRef} showScrollIndicator>
      <SubpageCard style={{ paddingVertical: space.sm }}>
        <HelpAction accessibilityLabel="On this page" accessibilityState={{ expanded: indexOpen }} aria-expanded={indexOpen}
          accessibilityHint={indexOpen ? "Hides the section list" : "Shows sections you can jump to"}
          onPress={() => setIndexOpen(!indexOpen)}
          style={({ pressed }) => ({ minHeight: TAP_FLOOR, paddingVertical: space.sm, borderRadius: radius.sm, flexDirection: "row", alignItems: "center", gap: space.md, backgroundColor: pressed ? t.brandSurface : "transparent" })}>
          <HelpIcon name="list-outline" />
          <T variant="title" style={{ flex: 1, minWidth: 0 }}>On this page</T>
          <Ionicons name={indexOpen ? "chevron-up-outline" : "chevron-down-outline"} size={20} color={t.brandText} accessibilityElementsHidden importantForAccessibility="no" />
        </HelpAction>
        {indexOpen ? sections.map((section, index) => (
          <SectionLink key={section.heading} heading={section.heading} number={index + 1} onPress={() => jumpToSection(index)} />
        )) : null}
      </SubpageCard>
      <SubpageCard title={LEGAL_DISCLAIMER_HEADING} icon="information-circle-outline" tone="mint">
        <T selectable style={{ color: t.textSecondary, fontSize: typeScale.body, lineHeight: 24 }}>{disclaimer}</T>
      </SubpageCard>
      {sections.map((section, index) => (
        <View key={section.heading} onLayout={(event) => { sectionOffsets.current[index] = event.nativeEvent.layout.y; }}>
          <SubpageCard style={{ gap: space.md }}>
            <View ref={(node) => { headingRefs.current[index] = node; }} accessible accessibilityRole="header" accessibilityLabel={section.heading} tabIndex={-1}
              style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
              <HelpNumber value={index + 1} />
              <T variant="title" style={{ flex: 1, minWidth: 0, color: t.textPrimary }}>{section.heading}</T>
            </View>
            {section.body.map((paragraph) => <T key={paragraph} selectable style={{ color: t.textSecondary, fontSize: typeScale.body, lineHeight: 24 }}>{paragraph}</T>)}
          </SubpageCard>
        </View>
      ))}
    </HelpPage>
  );
}

export function PrivacyScreen({ navigation }: { navigation?: HelpNavigation } = {}) {
  return (
    <LegalDocument
      title="Privacy"
      navigation={navigation}
      sections={PRIVACY_SECTIONS}
      disclaimer={PRIVACY_DISCLAIMER}
    />
  );
}

export function TermsScreen({ navigation }: { navigation?: HelpNavigation } = {}) {
  return <LegalDocument title="Terms of use" navigation={navigation} sections={TERMS_SECTIONS} disclaimer={TERMS_DISCLAIMER} />;
}
