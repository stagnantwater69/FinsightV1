import { useState } from "react";
import { View } from "react-native";
import { Button, Field, T } from "../../components/ui";
import { SubpageCard } from "../../components/SubpageKit";
import { TAP_FLOOR } from "../../components/touchTarget";
import { useTheme } from "../../context/ThemeContext";
import { FAQS, FAQ_TOPICS, TUTORIALS } from "../../lib/helpContent";
import { font, space, typeScale } from "../../theme/tokens";
import { HelpDisclosure, HelpGroup, HelpIcon, HelpLink, HelpPage, type HelpNavigation } from "./HelpPage";

const TOPIC_ICONS = {
  "Getting started": "compass-outline",
  "Using FinSight": "help-circle-outline",
  "Your data": "shield-checkmark-outline",
  "Cost and limits": "information-circle-outline",
} as const;

export function FaqsScreen({ navigation }: { navigation?: HelpNavigation } = {}) {
  const t = useTheme();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const search = query.trim().toLocaleLowerCase();
  const matches = FAQS.filter((faq) => `${faq.topic} ${faq.q} ${faq.a}`.toLocaleLowerCase().includes(search));

  return (
    <HelpPage title="Questions & answers" navigation={navigation}>
      <SubpageCard tone="mint">
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, marginBottom: space.md }}>
          <HelpIcon name="search-outline" />
          <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
            <T variant="title" accessibilityRole="header">Find an answer</T>
            <T>Help with your everyday tasks.</T>
          </View>
        </View>
        <Field
          label="Search questions"
          value={query}
          onChangeText={setQuery}
          placeholder="Try receipt, offline, or data"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {search ? (
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
            <T accessibilityLiveRegion="polite" style={{ flexGrow: 1, color: t.textSecondary, fontSize: typeScale.bodySm }}>
              {matches.length} {matches.length === 1 ? "answer" : "answers"} found
            </T>
            <Button title="Clear search" variant="ghost" style={{ minHeight: TAP_FLOOR }} onPress={() => setQuery("")} />
          </View>
        ) : null}
      </SubpageCard>

      {matches.length === 0 ? (
        <SubpageCard title="No matching questions" icon="search-outline">
          <T style={{ color: t.textSecondary }}>Try a shorter phrase or browse all questions by clearing your search.</T>
        </SubpageCard>
      ) : FAQ_TOPICS.map((topic) => {
        const questions = matches.filter((faq) => faq.topic === topic);
        if (questions.length === 0) return null;
        return (
          <HelpGroup key={topic} title={topic} icon={TOPIC_ICONS[topic]}>
            {questions.map((faq, index) => {
              const expanded = open === faq.q;
              return (
                <HelpDisclosure key={faq.q} title={faq.q} kind="answer" expanded={expanded} first={index === 0} onPress={() => setOpen(expanded ? null : faq.q)}>
                  <T selectable style={{ color: t.textSecondary, lineHeight: 24 }}>{faq.a}</T>
                </HelpDisclosure>
              );
            })}
          </HelpGroup>
        );
      })}
      {navigation ? (
        <SubpageCard style={{ paddingVertical: space.xs }}>
          <HelpLink first icon="book-outline" title="Browse written tutorials" detail="Follow a guide at your own pace."
            onPress={() => navigation.navigate("Tutorials")} />
        </SubpageCard>
      ) : null}
    </HelpPage>
  );
}

const GUIDE_GROUPS = [
  { title: "Start with the essentials", steps: [1, 2], icon: "storefront-outline" },
  { title: "Bring in your records", steps: [3, 4], icon: "receipt-outline" },
  { title: "Understand your business", steps: [5, 6], icon: "bar-chart-outline" },
] as const;

export function TutorialsScreen({ navigation }: { navigation?: HelpNavigation } = {}) {
  const t = useTheme();
  const [open, setOpen] = useState<number | null>(null);
  return (
    <HelpPage title="Tutorials" navigation={navigation} intro="Six short guides for everyday tasks.">
      {GUIDE_GROUPS.map((group) => (
        <HelpGroup key={group.title} title={group.title} icon={group.icon}>
          {TUTORIALS.filter((tutorial) => (group.steps as readonly number[]).includes(tutorial.n)).map((tutorial, index) => (
            <HelpDisclosure key={tutorial.n} title={tutorial.title} label={`Step ${tutorial.n}: ${tutorial.title}`} number={tutorial.n}
              kind="guide" expanded={open === tutorial.n} first={index === 0} onPress={() => setOpen(open === tutorial.n ? null : tutorial.n)}>
              <T selectable style={{ color: t.textSecondary, lineHeight: 24 }}>{tutorial.body}</T>
            </HelpDisclosure>
          ))}
        </HelpGroup>
      ))}
      <SubpageCard tone="mint" style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <HelpIcon name="videocam-outline" />
        <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
          <T style={{ color: t.textPrimary, fontFamily: font.sansMedium }}>Video walkthroughs coming soon</T>
          <T style={{ color: t.textSecondary, fontSize: typeScale.bodySm }}>You can use the written guides above today.</T>
        </View>
      </SubpageCard>
    </HelpPage>
  );
}
