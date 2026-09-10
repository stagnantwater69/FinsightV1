import { View } from "react-native";
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
import { HelpPage } from "./HelpPage";

/** Legal copy stays complete and shared with the web; presentation alone lives here. */
function LegalDocument({
  intro,
  sections,
  disclaimer,
}: {
  intro: string;
  sections: LegalSection[];
  disclaimer: string;
}) {
  const { brand, ink } = useTheme();

  return (
    <HelpPage intro={intro}>
      <View style={{ gap: space.xxl }}>
        {sections.map((section) => (
          <View
            key={section.heading}
            style={{
              borderTopWidth: 1,
              borderTopColor: ink[200],
              paddingTop: space.xxl,
              gap: space.md,
            }}
          >
            <T
              accessibilityRole="header"
              style={{
                fontFamily: font.sansSemibold,
                fontSize: typeScale.title,
                lineHeight: 26,
                color: ink[900],
              }}
            >
              {section.heading}
            </T>
            {section.body.map((paragraph) => (
              <T
                key={paragraph}
                selectable
                style={{ fontSize: typeScale.bodyLg, lineHeight: 26, color: ink[600] }}
              >
                {paragraph}
              </T>
            ))}
          </View>
        ))}
      </View>

      <View
        style={{
          backgroundColor: brand[50],
          borderRadius: radius.lg,
          padding: space.xl,
          gap: space.sm,
        }}
      >
        <T
          accessibilityRole="header"
          style={{
            fontFamily: font.sansSemibold,
            fontSize: typeScale.bodyLg,
            lineHeight: 24,
            color: brand[900],
          }}
        >
          {LEGAL_DISCLAIMER_HEADING}
        </T>
        <T selectable style={{ fontSize: typeScale.bodyLg, lineHeight: 26, color: brand[900] }}>
          {disclaimer}
        </T>
      </View>
    </HelpPage>
  );
}

export function PrivacyScreen() {
  return (
    <LegalDocument
      intro="What FinSight stores, where it goes, and who can reach it — in plain language."
      sections={PRIVACY_SECTIONS}
      disclaimer={PRIVACY_DISCLAIMER}
    />
  );
}

export function TermsScreen() {
  return (
    <LegalDocument
      intro="What FinSight is for, what it is not for, and what you can expect from it."
      sections={TERMS_SECTIONS}
      disclaimer={TERMS_DISCLAIMER}
    />
  );
}
