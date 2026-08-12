import { useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  FAQS,
  FAQ_TOPICS,
  LEGAL_DISCLAIMER_HEADING,
  PRIVACY_DISCLAIMER,
  PRIVACY_SECTIONS,
  SUPPORT_EMAIL,
  TERMS_DISCLAIMER,
  TERMS_SECTIONS,
  TUTORIALS,
  type LegalSection,
} from "../lib/helpContent";
import { Button, Callout, Card, Screen, ScreenHeader, T } from "../components/ui";
import { brand, font, ink, radius, space, TAP, typeScale } from "../theme/tokens";

/**
 * Help and legal, in the app.
 *
 * WHY THESE EXIST ON A PHONE: the panel found most small business owners have
 * a phone and no computer. Everything here already existed on the website —
 * and a website is exactly what those owners will not go to. For a great many
 * of them the app is the only place they will ever read what FinSight does
 * with their records, which is also why Privacy and Terms are here rather than
 * being treated as marketing pages the app can link out to.
 *
 * Every word comes from lib/helpContent, a mirror of the website's copy that
 * tests/helpContent.test.ts holds identical. Nothing on these screens writes
 * its own prose, because a second version of a privacy notice is the failure
 * this arrangement exists to prevent.
 */

// ---------------------------------------------------------------- FAQs

/**
 * Grouped by topic, one collapsible per question.
 *
 * Collapsed by default: thirteen answers is a very long scroll on a phone, and
 * the list of questions IS the navigation. Web can afford to use native
 * <details> here; React Native has no equivalent, so the open/closed state is
 * held explicitly and the trigger declares its own expanded state for screen
 * readers.
 */
export function FaqsScreen() {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
        <ScreenHeader
          eyebrow="Help"
          title="Questions & answers"
          subtitle="What FinSight does, what it does not do, and what happens to your records."
        />

        {FAQ_TOPICS.map((topic) => {
          const inTopic = FAQS.filter((f) => f.topic === topic);
          if (inTopic.length === 0) return null;

          return (
            <View key={topic} style={{ marginBottom: space.lg }}>
              <T
                accessibilityRole="header"
                variant="label"
                style={{ textTransform: "uppercase", letterSpacing: 0.6, color: ink[400], marginBottom: space.sm }}
              >
                {topic}
              </T>

              <Card>
                {inTopic.map((faq, i) => {
                  const isOpen = open === faq.q;
                  return (
                    <View
                      key={faq.q}
                      style={{
                        borderTopWidth: i === 0 ? 0 : 1,
                        borderTopColor: ink[200],
                        paddingTop: i === 0 ? 0 : space.md,
                        marginTop: i === 0 ? 0 : space.md,
                      }}
                    >
                      <Pressable
                        onPress={() => setOpen(isOpen ? null : faq.q)}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: isOpen }}
                        accessibilityHint={isOpen ? "Hides the answer" : "Shows the answer"}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: space.sm,
                          minHeight: TAP,
                        }}
                      >
                        <T style={{ flex: 1, fontSize: typeScale.body, color: ink[900], fontFamily: font.sansMedium }}>
                          {faq.q}
                        </T>
                        <Ionicons
                          name={isOpen ? "chevron-up" : "chevron-down"}
                          size={18}
                          color={ink[400]}
                        />
                      </Pressable>

                      {isOpen ? (
                        <T style={{ fontSize: typeScale.bodySm, lineHeight: 21, color: ink[600], marginTop: space.xs, marginBottom: space.sm }}>
                          {faq.a}
                        </T>
                      ) : null}
                    </View>
                  );
                })}
              </Card>
            </View>
          );
        })}
      </ScrollView>
    </Screen>
  );
}

// ---------------------------------------------------------------- Tutorials

export function TutorialsScreen() {
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
        <ScreenHeader
          eyebrow="Help"
          title="Tutorials"
          subtitle="Step by step, from setting up your business to reading what the dashboard is telling you."
        />

        {TUTORIALS.map((t) => (
          <Card key={t.n} style={{ marginBottom: space.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: radius.full,
                  backgroundColor: brand[700],
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {/* Decorative — the step number is already in the heading order. */}
                <T style={{ color: "#fff", fontSize: typeScale.bodySm, fontFamily: font.sansSemibold }} accessibilityElementsHidden>
                  {t.n}
                </T>
              </View>
              <T
                accessibilityRole="header"
                style={{ flex: 1, fontSize: typeScale.body, color: ink[900], fontFamily: font.sansSemibold }}
              >
                {t.title}
              </T>
            </View>

            <T style={{ fontSize: typeScale.bodySm, lineHeight: 21, color: ink[600], marginTop: space.sm }}>{t.body}</T>

            {/*
              A written marker, not a play button. A control that looks live
              and isn't teaches an owner something worse about the product than
              an honest label does — the same reasoning the website's cards use.
            */}
            <T variant="caption" style={{ marginTop: space.sm, color: ink[400] }}>
              Video walkthrough coming soon
            </T>
          </Card>
        ))}
      </ScrollView>
    </Screen>
  );
}

// ---------------------------------------------------------------- Contact

/**
 * Deliberately not a form — there is no inbox behind one, and a form that
 * silently discards messages is worse than no contact screen at all.
 *
 * The email opens the phone's mail app, which is the one thing this screen can
 * do that the website's cannot.
 */
export function ContactScreen({ navigation }: { navigation: { navigate: (screen: string) => void } }) {
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
        <ScreenHeader
          eyebrow="Help"
          title="Contact us"
          subtitle="Questions, problems, or something FinSight read wrong — we would rather hear about it."
        />

        <Card>
          <T accessibilityRole="header" style={{ fontSize: typeScale.body, color: ink[900], fontFamily: font.sansSemibold }}>
            Email us
          </T>
          <T style={{ fontSize: typeScale.bodySm, lineHeight: 21, color: ink[600], marginTop: space.xs }}>
            The most reliable way to reach us. If a receipt was read wrong, saying which shop it came from
            helps more than anything else.
          </T>
          {/*
            The address is shown as text as well as being on a button.
            `selectable` is what lets an owner copy it by hand — which is the
            fallback when the phone has no mail app configured, and the reason
            the button's failure below can stay silent.
          */}
          <T
            selectable
            style={{ fontSize: typeScale.body, color: brand[700], marginTop: space.md, fontFamily: font.sansMedium }}
          >
            {SUPPORT_EMAIL}
          </T>

          <View style={{ marginTop: space.md }}>
            <Button
              title="Open email app"
              variant="primary"
              onPress={() => {
                // Silent on failure by design: a phone with no mail app
                // configured cannot be helped by an error dialog, and the
                // address above stays readable and copyable regardless.
                Linking.openURL(`mailto:${SUPPORT_EMAIL}`).catch(() => undefined);
              }}
            />
          </View>
        </Card>

        <Card style={{ marginTop: space.sm }}>
          <T accessibilityRole="header" style={{ fontSize: typeScale.body, color: ink[900], fontFamily: font.sansSemibold }}>
            Check the questions first
          </T>
          <T style={{ fontSize: typeScale.bodySm, lineHeight: 21, color: ink[600], marginTop: space.xs }}>
            Most questions — whether it works offline, what it costs, what happens to your receipt photos —
            are already answered there.
          </T>
          <View style={{ marginTop: space.md }}>
            <Button title="Read the questions" variant="ghost" onPress={() => navigation.navigate("Faqs")} />
          </View>
        </Card>

        <View style={{ marginTop: space.lg }}>
          <Callout>
            Receipt reading is the part most likely to be wrong, and the reports that actually help us fix it
            include the shop, what was printed, and what FinSight read instead. You do not need to send the
            photo — the description is usually enough.
          </Callout>
        </View>
      </ScrollView>
    </Screen>
  );
}

// ---------------------------------------------------------------- Legal

/**
 * Both legal documents render through this, because they are the same shape
 * and the only thing that should differ between them is their words.
 */
function LegalScreen({
  eyebrow,
  title,
  subtitle,
  sections,
  disclaimer,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  sections: LegalSection[];
  disclaimer: string;
}) {
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
        <ScreenHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />

        {sections.map((section) => (
          <View key={section.heading} style={{ marginBottom: space.lg }}>
            <T
              accessibilityRole="header"
              style={{ fontSize: typeScale.bodyLg, color: ink[900], fontFamily: font.sansSemibold }}
            >
              {section.heading}
            </T>
            {section.body.map((paragraph) => (
              <T
                key={paragraph}
                style={{ fontSize: typeScale.bodySm, lineHeight: 21, color: ink[600], marginTop: space.sm }}
              >
                {paragraph}
              </T>
            ))}
          </View>
        ))}

        {/*
          The closing note is the sentence most likely to be dropped when
          someone tidies a screen, and the one that must not be — it is what
          keeps the document honest about what it is.
        */}
        <View
          style={{
            backgroundColor: brand[50],
            borderWidth: 1,
            borderColor: brand[200],
            borderRadius: radius.lg,
            padding: space.lg,
          }}
        >
          <T style={{ fontSize: typeScale.bodySm, lineHeight: 21, color: brand[900] }}>
            <T style={{ fontFamily: font.sansSemibold, color: brand[900] }}>{LEGAL_DISCLAIMER_HEADING}</T>{" "}
            {disclaimer}
          </T>
        </View>
      </ScrollView>
    </Screen>
  );
}

export function PrivacyScreen() {
  return (
    <LegalScreen
      eyebrow="Legal"
      title="Privacy"
      subtitle="What FinSight stores, where it goes, and who can reach it — in plain language."
      sections={PRIVACY_SECTIONS}
      disclaimer={PRIVACY_DISCLAIMER}
    />
  );
}

export function TermsScreen() {
  return (
    <LegalScreen
      eyebrow="Legal"
      title="Terms of use"
      subtitle="What FinSight is for, what it is not for, and what you can expect from it."
      sections={TERMS_SECTIONS}
      disclaimer={TERMS_DISCLAIMER}
    />
  );
}
