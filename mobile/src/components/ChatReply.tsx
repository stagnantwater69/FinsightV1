import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, ErrorNote, Money, T } from "./ui";
import { TAP_FLOOR } from "./touchTarget";
import { api } from "../lib/api";
import * as haptics from "../lib/haptics";
import { CHAT_PAGE_TARGETS, inlineRuns, parseChatBlocks, recordPath } from "../lib/chatLinks";
import { formatMoney } from "../lib/money";
import { formatDueDate } from "../lib/recurringAgenda";
import { useTheme } from "../context/ThemeContext";
import { font, radius, space, typeScale } from "../theme/tokens";
import type { ChatAction, ChatAnswerMetadata, RecordItem } from "../lib/types";
import { navigateToTabScreen, type TabNavigation } from "../navigation/types";

/**
 * Fin's reply text, in the small Markdown slice it writes. Rendered as nested
 * <Text> runs — model output is untrusted, and nothing in it can become
 * anything but text.
 */
export function ChatMarkdown({ text, color }: { text: string; color: string }) {
  const t = useTheme();
  const base = { color, fontSize: typeScale.body, lineHeight: 24 } as const;
  const runs = (line: string) =>
    inlineRuns(line).map((run, i) => (
      <Text key={i} style={run.bold ? { fontFamily: font.sansSemibold, color: t.textPrimary } : undefined}>
        {run.text.split(/((?:₱|PHP\s*)[+-]?\d[\d,]*(?:\.\d+)?)/g).map((part, j) =>
          /^(?:₱|PHP)/.test(part) ? <Text key={j} style={{ fontFamily: font.monoMedium, color: t.textPrimary }}>{part}</Text> : part,
        )}
      </Text>
    ));

  return (
    <View style={{ gap: space.lg }}>
      {parseChatBlocks(text).map((block, i) =>
        block.kind === "p" ? (
          <T key={i} style={i === 0 && block.lines.length === 1 && inlineRuns(block.lines[0]!).every((run) => run.bold) ? [base, { fontSize: typeScale.title, lineHeight: 25, color: t.textPrimary }] : base}>
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
  scopeKey = "",
}: {
  metadata: ChatAnswerMetadata;
  latest: boolean;
  feedback: "up" | "down" | null;
  onFollowUp: (question: string) => void;
  onRate: (feedback: "up" | "down" | null) => void;
  /** Closes the sheet before the app moves to another screen under it. */
  onLeave: () => void;
  scopeKey?: string;
}) {
  const t = useTheme();
  const { brand, ink } = t;
  const navigation = useNavigation<TabNavigation>();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const openingRef = useRef<string | null>(null);
  const mounted = useRef(true);
  const currentScope = useRef({ key: scopeKey, generation: 0 });
  if (currentScope.current.key !== scopeKey) currentScope.current = { key: scopeKey, generation: currentScope.current.generation + 1 };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [linkError, setLinkError] = useState<string | null>(null);
  useEffect(() => {
    openingRef.current = null;
    setOpening(null);
    setLinkError(null);
    setSourcesOpen(false);
  }, [scopeKey]);

  async function openRecord(recordType: "expense" | "sales", id: number) {
    if (!mounted.current || openingRef.current !== null || !Number.isSafeInteger(id) || id < 1 || (recordType !== "expense" && recordType !== "sales")) return;
    const forScope = currentScope.current.generation;
    const referenceKey = `${recordType}-${id}`;
    const requestKey = `${forScope}:${referenceKey}`;
    openingRef.current = requestKey;
    haptics.tapped();
    setOpening(referenceKey);
    setLinkError(null);
    try {
      // EditRecord takes the whole record, so it is loaded first — through
      // the owner-scoped endpoint, which 404s anything that is not theirs.
      const record = await api.get<RecordItem>(recordPath(recordType, id));
      if (!mounted.current || currentScope.current.generation !== forScope) return;
      onLeave();
      navigation.navigate("Records", { screen: "EditRecord", params: { record } });
    } catch {
      if (mounted.current && currentScope.current.generation === forScope) setLinkError("That record couldn't be opened. It may have been deleted.");
    } finally {
      if (openingRef.current === requestKey) openingRef.current = null;
      if (mounted.current && currentScope.current.generation === forScope) setOpening(null);
    }
  }

  function openPage(key: keyof typeof CHAT_PAGE_TARGETS, params?: Record<string, unknown>) {
    if (!mounted.current || !Object.hasOwn(CHAT_PAGE_TARGETS, key)) return;
    haptics.tapped();
    const target = CHAT_PAGE_TARGETS[key];
    onLeave();
    navigateToTabScreen(navigation, target, params);
  }

  const chip = {
    minHeight: TAP_FLOOR,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    paddingVertical: space.md,
  };

  return (
    <View style={{ gap: space.sm }}>
      {metadata.period ? <T variant="caption">Based on records for {metadata.period}.</T> : null}
      {metadata.amountCheck === "trimmed" ? (
        <T variant="caption">Part of this answer was removed because it used a figure FinSight couldn't find in your records.</T>
      ) : null}
      {metadata.references.length > 0 ? (
      <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: radius.md, backgroundColor: t.surface }}>
        <Pressable
          onPress={() => setSourcesOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel={`Records mentioned (${metadata.references.length})`}
          accessibilityState={{ expanded: sourcesOpen }}
          style={{ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm }}
        >
          <Ionicons name="receipt-outline" size={17} color={t.textMuted} />
          <T variant="label" style={{ flex: 1, color: t.textSecondary }}>Records mentioned ({metadata.references.length})</T>
          <Ionicons name={sourcesOpen ? "chevron-down" : "chevron-forward"} size={16} color={t.textMuted} />
        </Pressable>
      {sourcesOpen ? <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingHorizontal: space.md }}>{metadata.references.map((reference) => (
        <Pressable
          key={`${reference.recordType}-${reference.id}`}
          onPress={() => void openRecord(reference.recordType, reference.id)}
          disabled={opening !== null}
          accessibilityRole="link"
          accessibilityLabel={`Open record ${reference.label}, ${formatMoney(reference.amount, { decimals: true })}, ${formatDueDate(reference.date)}`}
          accessibilityState={{ disabled: opening !== null, busy: opening === `${reference.recordType}-${reference.id}` }}
          style={[chip, { borderBottomWidth: 1, borderBottomColor: t.border }]}
        >
          <View style={{ flex: 1 }}>
            <T style={{ fontFamily: font.sansMedium, fontSize: typeScale.bodySm, color: ink[900] }}>
              {reference.label}
            </T>
            <T variant="caption">
              <Money value={reference.amount} decimals /> · {formatDueDate(reference.date)}
            </T>
          </View>
          <Ionicons name={opening === `${reference.recordType}-${reference.id}` ? "hourglass-outline" : "arrow-forward"} size={16} color={t.textMuted} />
        </Pressable>
      ))}</View> : null}
      </View>
      ) : null}
      {metadata.pages.map((page) => (
        <Pressable key={page.key} onPress={() => openPage(page.key)} accessibilityRole="link" accessibilityLabel={`Open ${page.label}`} style={chip}>
          <T style={{ fontFamily: font.sansMedium, fontSize: typeScale.label, color: t.brandText }}>Open {page.label}</T>
          <Ionicons name="arrow-forward" size={16} color={brand[700]} />
        </Pressable>
      ))}
      {linkError ? <ErrorNote>{linkError}</ErrorNote> : null}

      {latest && metadata.actions.length > 0 ? (
        <ActionRow
          key={scopeKey}
          actions={metadata.actions}
          onOpenSpendingImpact={(amount) => openPage("spending-impact", { plannedAmount: amount })}
        />
      ) : null}

      {latest && metadata.followUps.length > 0 ? (
        <View style={{ gap: space.sm, marginTop: space.md }}>
          <T variant="caption">Ask a follow-up</T>
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
                minHeight: TAP_FLOOR,
                justifyContent: "center",
                borderWidth: 1,
                borderColor: t.brandBorder,
                backgroundColor: t.surface,
                borderRadius: radius.md,
                paddingHorizontal: space.md,
                paddingVertical: space.sm,
              }}
            >
              <T style={{ color: brand[700], fontSize: typeScale.label }}>{question}</T>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <T variant="caption" style={{ flex: 1 }}>Was this helpful?</T>
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
              style={{
                minWidth: TAP_FLOOR,
                minHeight: TAP_FLOOR,
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
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function run(action: ChatAction) {
    if (!mounted.current || busyRef.current) return;
    if (action.kind === "open-spending-impact") {
      if (!Number.isFinite(action.amount) || action.amount < 0) return;
      onOpenSpendingImpact(action.amount);
      return;
    }
    if (!Number.isSafeInteger(action.findingId) || action.findingId < 1) return;
    busyRef.current = true;
    haptics.pressed();
    setBusy(action.label);
    setError(null);
    try {
      await api.patch(`/insights/findings/${action.findingId}/review`, {
        status: action.status,
        feedback: action.feedback,
      });
      if (!mounted.current) return;
      haptics.committed();
      setDone(action.label);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error && err.message ? err.message : "That didn't save. Please try again.");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
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
