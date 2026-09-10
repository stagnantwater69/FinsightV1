import { useState } from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Button, Card, Field, T } from "../../components/ui";
import { useTheme } from "../../context/ThemeContext";
import { FAQS, FAQ_TOPICS, TUTORIALS } from "../../lib/helpContent";
import { font, radius, space } from "../../theme/tokens";
import { HelpPage } from "./HelpPage";

export function FaqsScreen() {
  const t = useTheme();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const search = query.trim().toLocaleLowerCase();
  const matches = FAQS.filter((faq) => `${faq.topic} ${faq.q} ${faq.a}`.toLocaleLowerCase().includes(search));

  return (
    <HelpPage intro="Find answers about using FinSight, your records, and what to expect.">
      <View>
        <Field
          label="Search questions"
          icon="search-outline"
          value={query}
          onChangeText={setQuery}
          placeholder="Try receipt, offline, or data"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {search ? (
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
            <T accessibilityLiveRegion="polite" style={{ flexGrow: 1, color: t.textSecondary }}>
              {matches.length} {matches.length === 1 ? "answer" : "answers"} found
            </T>
            <Button title="Clear search" variant="ghost" style={{ minHeight: 48 }} onPress={() => setQuery("")} />
          </View>
        ) : null}
      </View>

      {matches.length === 0 ? (
        <View style={{ gap: space.sm }}>
          <T variant="title" accessibilityRole="header">No matching questions</T>
          <T style={{ color: t.textSecondary }}>Try a shorter phrase or browse all questions by clearing your search.</T>
        </View>
      ) : FAQ_TOPICS.map((topic) => {
        const questions = matches.filter((faq) => faq.topic === topic);
        if (questions.length === 0) return null;
        return (
          <View key={topic} style={{ gap: space.md }}>
            <T variant="title" accessibilityRole="header">{topic}</T>
            <Card style={{ padding: 0, overflow: "hidden" }}>
              {questions.map((faq, index) => {
                const expanded = open === faq.q;
                return (
                  <View key={faq.q} style={{ borderTopWidth: index === 0 ? 0 : 1, borderTopColor: t.border }}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={faq.q}
                      accessibilityState={{ expanded }}
                      accessibilityHint={expanded ? "Hides the answer" : "Shows the answer"}
                      onPress={() => setOpen(expanded ? null : faq.q)}
                      style={({ pressed }) => ({
                        minHeight: 56,
                        padding: space.lg,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: space.md,
                        backgroundColor: pressed || expanded ? t.brandSurface : t.surface,
                      })}
                    >
                      <T style={{ flex: 1, minWidth: 0, fontFamily: font.sansSemibold, color: expanded ? t.brandText : t.textPrimary }}>
                        {faq.q}
                      </T>
                      <Ionicons name={expanded ? "remove-outline" : "add-outline"} size={20} color={t.brandText} accessibilityElementsHidden importantForAccessibility="no" />
                    </Pressable>
                    {expanded ? (
                      <T selectable style={{ padding: space.lg, color: t.textSecondary, lineHeight: 24 }}>
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
    </HelpPage>
  );
}

const GUIDE_GROUPS = [
  { title: "Start with the essentials", steps: [1, 2] },
  { title: "Bring in your records", steps: [3, 4] },
  { title: "Understand your business", steps: [5, 6] },
];

export function TutorialsScreen() {
  const t = useTheme();
  return (
    <HelpPage intro="Six short guides to help you get started. Follow them in order, or go straight to the topic you need.">
      {GUIDE_GROUPS.map((group) => (
        <View key={group.title} style={{ gap: space.lg }}>
          <T variant="title" accessibilityRole="header">{group.title}</T>
          {TUTORIALS.filter((tutorial) => group.steps.includes(tutorial.n)).map((tutorial) => (
            <View key={tutorial.n} style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
              <View style={{ minWidth: 32, minHeight: 32, padding: space.xs, borderRadius: radius.sm, backgroundColor: t.brandSurface, alignItems: "center", justifyContent: "center" }}>
                <T accessibilityElementsHidden importantForAccessibility="no" style={{ color: t.brandText, fontFamily: font.sansSemibold }}>{tutorial.n}</T>
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: space.sm }}>
                <T accessibilityRole="header" accessibilityLabel={`Step ${tutorial.n}: ${tutorial.title}`} style={{ fontFamily: font.sansSemibold }}>
                  {tutorial.title}
                </T>
                <T selectable style={{ color: t.textSecondary, lineHeight: 24 }}>{tutorial.body}</T>
              </View>
            </View>
          ))}
        </View>
      ))}
      <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.lg, gap: space.xs }}>
        <T style={{ fontFamily: font.sansMedium }}>Video walkthroughs coming soon</T>
        <T style={{ color: t.textSecondary }}>You can use the written guides above today.</T>
      </View>
    </HelpPage>
  );
}
