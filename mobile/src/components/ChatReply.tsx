import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { Button, ErrorNote, Money, T } from "./ui";
import { api } from "../lib/api";
import * as haptics from "../lib/haptics";
import { CHAT_PAGE_TARGETS, inlineRuns, parseChatBlocks, recordPath } from "../lib/chatLinks";
import { useTheme } from "../context/ThemeContext";
import { TAP, font, radius, space, typeScale } from "../theme/tokens";
import type { ChatAction, ChatAnswerMetadata, RecordItem } from "../lib/types";

/**
 * Fin's reply text, in the small Markdown slice it writes. Rendered as nested
 * <Text> runs — model output is untrusted, and nothing in it can become
 * anything but text.
 */
export function ChatMarkdown({ text, color }: { text: string; color: string }) {
  const t = useTheme();
  const base = { color, fontSize: typeScale.bodySm, lineHeight: 20 } as const;
  const runs = (line: string) =>
    inlineRuns(line).map((run, i) =>
      run.bold ? (
        <Text key={i} style={{ fontFamily: font.sansSemibold, color: t.ink[900] }}>
          {run.text}
        </Text>
      ) : (
        run.text
      ),
    );

  return (
    <View style={{ gap: space.sm }}>
      {parseChatBlocks(text).map((block, i) =>
        block.kind === "p" ? (
          <T key={i} style={base}>
            {block.lines.map((line, j) => (
              <Text key={j}>
                {j > 0 ? "\n" : null}
                {runs(line)}
              </Text>
            ))}
          </T>
        ) : (
          <View key={i} style={{ gap: space.xs }}>
            {block.items.map((item, j) => (
              <View key={j} style={{ flexDirection: "row", gap: space.sm }}>
                <T style={base}>{block.kind === "ul" ? "•" : `${j + 1}.`}</T>
                <T style={[base, { flex: 1 }]}>{runs(item)}</T>
              </View>
            ))}
          </View>
        ),
      )}
    </View>
  );
}

/**
 * Everything the server resolved alongside a reply — the mobile twin of web's
 * AnswerExtras. Record links are records the server put in that message's
 * context, page links come from a fixed table (lib/chatLinks), and actions are
 * built by the server from the flag the chat was opened on; an action runs only
 * when pressed, through the same review endpoint the flag card uses.
 *
 * Follow-ups and actions show on the LATEST reply only.
 */
export function ChatReplyExtras({
  metadata,
  latest,
  feedback,
  onFollowUp,
  onRate,
  onLeave,
}: {
  metadata: ChatAnswerMetadata;
  latest: boolean;
  feedback: "up" | "down" | null;
  onFollowUp: (question: string) => void;
  onRate: (feedback: "up" | "down" | null) => void;
  /** Closes the sheet before the app moves to another screen under it. */
  onLeave: () => void;
}) {
  const t = useTheme();
  const { brand, ink } = t;
  const navigation = useNavigation<any>();
  const [opening, setOpening] = useState<number | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  async function openRecord(recordType: "expense" | "sales", id: number) {
    haptics.tapped();
    setOpening(id);
    setLinkError(null);
    try {
      // EditRecord takes the whole record, so it is loaded first — through
      // the owner-scoped endpoint, which 404s anything that is not theirs.
      const record = await api.get<RecordItem>(recordPath(recordType, id));
      onLeave();
      navigation.navigate("Records", { screen: "EditRecord", params: { record } });
    } catch {
      setLinkError("That record couldn't be opened — it may have been deleted.");
    } finally {
      setOpening(null);
    }
  }

  function openPage(key: keyof typeof CHAT_PAGE_TARGETS, params?: Record<string, unknown>) {
    haptics.tapped();
    const target = CHAT_PAGE_TARGETS[key];
    onLeave();
    navigation.navigate(target.tab, { screen: target.screen, ...(params ? { params } : {}) });
  }

  const chip = {
    minHeight: TAP,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    borderWidth: 1,
    borderColor: brand[100],
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    backgroundColor: t.surface,
  };

  return (
    <View style={{ marginLeft: space.sm, gap: space.sm, maxWidth: "92%" }}>
      {metadata.references.map((reference) => (
        <Pressable
          key={`${reference.recordType}-${reference.id}`}
          onPress={() => void openRecord(reference.recordType, reference.id)}
          disabled={opening !== null}
          accessibilityRole="link"
          accessibilityLabel={`Open record ${reference.label}`}
          style={chip}
        >
          <View style={{ flex: 1 }}>
            <T numberOfLines={1} style={{ fontFamily: font.sansMedium, fontSize: typeScale.label, color: ink[900] }}>
              {reference.label}
            </T>
            <T variant="caption">
              <Money value={reference.amount} /> · {reference.date}
            </T>
          </View>
          <Ionicons name={opening === reference.id ? "hourglass-outline" : "arrow-forward"} size={16} color={brand[700]} />
        </Pressable>
      ))}
      {metadata.pages.map((page) => (
        <Pressable key={page.key} onPress={() => openPage(page.key)} accessibilityRole="link" style={chip}>
          <T style={{ flex: 1, fontFamily: font.sansMedium, fontSize: typeScale.label, color: ink[900] }}>Open {page.label}</T>
          <Ionicons name="arrow-forward" size={16} color={brand[700]} />
        </Pressable>
      ))}
      {linkError ? <ErrorNote>{linkError}</ErrorNote> : null}

      {latest && metadata.actions.length > 0 ? (
        <ActionRow
          actions={metadata.actions}
          onOpenSpendingImpact={(amount) => openPage("spending-impact", { plannedAmount: amount })}
        />
      ) : null}

      {metadata.period || metadata.amountCheck === "trimmed" ? (
        <T variant="caption">
          {metadata.period ? `Based on your records for ${metadata.period}.` : ""}
          {metadata.period && metadata.amountCheck === "trimmed" ? " " : ""}
          {metadata.amountCheck === "trimmed"
            ? "Part of this answer was removed because it used a figure FinSight couldn't find in your records."
            : ""}
        </T>
      ) : null}

      {latest && metadata.followUps.length > 0 ? (
        <View style={{ gap: space.sm }}>
          {metadata.followUps.map((question) => (
            <Pressable
              key={question}
              onPress={() => {
                haptics.tapped();
                onFollowUp(question);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Use this question: ${question}`}
              style={{
                minHeight: TAP,
                justifyContent: "center",
                borderWidth: 1,
                borderColor: brand[200],
                borderRadius: radius.full,
                paddingHorizontal: space.md,
              }}
            >
              <T style={{ color: brand[700], fontSize: typeScale.label }}>{question}</T>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={{ flexDirection: "row", gap: space.xs }}>
        {(["up", "down"] as const).map((value) => {
          const active = feedback === value;
          return (
            <Pressable
              key={value}
              onPress={() => {
                haptics.tapped();
                onRate(active ? null : value);
              }}
              accessibilityRole="button"
              accessibilityLabel={value === "up" ? "Helpful" : "Not helpful"}
              accessibilityState={{ selected: active }}
              hitSlop={8}
              style={{
                width: 36,
                height: 36,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: radius.sm,
                backgroundColor: active ? brand[50] : "transparent",
              }}
            >
              <Ionicons
                name={value === "up" ? (active ? "thumbs-up" : "thumbs-up-outline") : active ? "thumbs-down" : "thumbs-down-outline"}
                size={16}
                color={active ? brand[700] : ink[600]}
              />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function ActionRow({
  actions,
  onOpenSpendingImpact,
}: {
  actions: ChatAction[];
  onOpenSpendingImpact: (amount: number) => void;
}) {
  const t = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: ChatAction) {
    if (action.kind === "open-spending-impact") {
      onOpenSpendingImpact(action.amount);
      return;
    }
    haptics.pressed();
    setBusy(action.label);
    setError(null);
    try {
      await api.patch(`/insights/findings/${action.findingId}/review`, {
        status: action.status,
        feedback: action.feedback,
      });
      haptics.committed();
      setDone(action.label);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "That didn't save. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return (
      <T variant="caption" style={{ color: t.brand[700] }}>
        Saved: {done}. This flag has left your review list.
      </T>
    );
  }
  return (
    <View style={{ gap: space.sm }}>
      {actions.map((action) => (
        <Button
          key={action.label}
          title={busy === action.label ? "Saving…" : action.label}
          variant="secondary"
          disabled={busy !== null}
          onPress={() => void run(action)}
        />
      ))}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </View>
  );
}
