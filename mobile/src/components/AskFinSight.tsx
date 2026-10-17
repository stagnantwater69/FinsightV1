import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * How much of the screen the sheet covers.
 *
 * Tall enough for a real conversation, short enough that the dimmed strip
 * above it still reads as "the screen you came from" — which is what makes a
 * sheet feel dismissible rather than like a new page.
 */
const SHEET_HEIGHT = Math.round(Dimensions.get("window").height * 0.88);
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, Callout, ErrorNote, T } from "./ui";
import { TAP_FLOOR } from "./touchTarget";
import { ChatHistoryPanel } from "./ChatHistoryPanel";
import { ChatMarkdown, ChatReplyExtras } from "./ChatReply";
import { Mascot } from "./MascotState";
import { useAiChat } from "../context/AiChatContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import * as haptics from "../lib/haptics";
import { formatMoney } from "../lib/money";
import { useReducedMotion } from "../lib/useReducedMotion";
import { font, radius, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import type { ChatMessage, InteractionModule } from "../lib/types";
import { FIELD_LIMITS } from "../lib/fieldLimits";

/**
 * Ask FinSight — a full-screen modal per module.
 *
 * The web app uses a side drawer, which is a desktop pattern that makes no
 * sense on a phone: a 420px panel over a 375px screen is just a worse
 * full-screen view. This presents as a modal sheet instead, which is the native
 * idiom and gets the keyboard handling right.
 *
 * WHAT THE SHEET NO LONGER OWNS. It used to hold the messages in its own
 * `useState` and refetch `/ai/history` on every open, so the thread was tied to
 * the sheet being on screen and to the screen it was opened from. Conversations
 * now live in context/AiChatContext (see lib/chatStore for the reasoning), and
 * this file is a view over them: opening and closing it, and moving between
 * screens, cannot start a new conversation or reset the current one.
 *
 * CHAT HISTORY IS A MODE OF THIS SHEET, not a screen and not a second modal —
 * see ChatHistoryPanel for why.
 *
 * Everything else is still identical to web: same endpoints, same lazy
 * creation, and no client-side context — the server rebuilds it from fresh data
 * on every message, which is what lets a follow-up see a record added seconds
 * ago.
 */

const STARTERS: { module: InteractionModule; question: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { module: "Expense Insights", question: "Which category is highest?", icon: "grid-outline" },
  { module: "Dashboard", question: "What needs my attention?", icon: "analytics-outline" },
  { module: "Spending Impact", question: "What if I spend ₱11,000 on a fridge?", icon: "calculator-outline" },
  { module: "Recovery Target", question: "How much more sales do I need?", icon: "trending-up-outline" },
];

interface SendAttempt {
  question: string;
  businessId: number;
  conversationId: number | null;
  draft: string | null;
  generation: number;
}

export function AskFinSight({
  visible,
  onClose,
  module,
}: {
  visible: boolean;
  onClose: () => void;
  /**
   * The screen the sheet was opened from. It seeds the origin of the NEXT new
   * conversation and chooses the greeting copy — an existing thread keeps the
   * `originModule` it was created with, so it stays readable from anywhere.
   */
  module: InteractionModule;
}) {
  const t = useTheme();
  const { brand, ink, paper } = t;
  const chat = useAiChat();
  const { selected } = useBusinessProfiles();
  const active = chat.conversations.find((c) => c.id === chat.activeId) ?? null;
  const currentModule = active?.originModule ?? chat.seedModule;
  const businessId = selected?.id ?? null;

  /*
   * The sheet's own animation.
   *
   * Driven by the JS Animated API rather than a library: translateY and
   * opacity are both native-driver properties, so the slide runs off the JS
   * thread and stays smooth while history is being fetched — the exact moment
   * the JS thread is busy and a non-native animation would jank.
   *
   * Reanimated + a bottom-sheet library would give the same result and a much
   * larger native dependency, for one sheet.
   */
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(SHEET_HEIGHT)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  /*
   * Reduced motion, read through a ref rather than used directly.
   *
   * WHY THE REF: the PanResponder below is built once inside a useRef and
   * keeps the handlers it was given for the life of the sheet. Anything those
   * handlers close over is frozen at first render — and the first render is
   * always before the asynchronous reduce-motion read comes back, so reading
   * the state value there would pin the drag path to "motion is fine" forever.
   * Keeping `animateTo` free of the state value also keeps its identity
   * stable, which is what lets the pan responder hold onto it safely.
   */
  const reduceMotion = useReducedMotion();
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;

  const animateTo = useCallback(
    (to: "open" | "closed", onDone?: () => void) => {
      const settled = to === "open" ? 0 : SHEET_HEIGHT;
      const dimmed = to === "open" ? 0.45 : 0;

      /*
       * Reduced motion: go straight to the end state.
       *
       * `onDone` is not decoration — on the closing path it IS `onClose`, the
       * only thing that flips `visible` to false and takes the sheet down.
       * Skipping the animation without calling it would leave a sheet that
       * cannot be dismissed by the close button, the backdrop, or a drag. So
       * the callback fires here exactly as the completion handler fires below,
       * and only the travel between the two states is dropped.
       */
      if (reduceMotionRef.current) {
        translateY.setValue(settled);
        backdrop.setValue(dimmed);
        onDone?.();
        return;
      }

      Animated.parallel([
        Animated.timing(translateY, {
          toValue: settled,
          duration: to === "open" ? 260 : 200,
          easing: to === "open" ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
          useNativeDriver: Platform.OS !== "web",
        }),
        Animated.timing(backdrop, {
          toValue: dimmed,
          duration: to === "open" ? 260 : 200,
          useNativeDriver: Platform.OS !== "web",
        }),
      ]).start(({ finished }) => {
        if (finished) onDone?.();
      });
    },
    [translateY, backdrop],
  );

  /**
   * Slides out first, THEN unmounts — closing instantly would look like a
   * crash. Under reduced motion it goes straight down, which is the trade the
   * owner asked for; `animateTo` still calls back either way.
   */
  const close = useCallback(() => {
    animateTo("closed", onClose);
  }, [animateTo, onClose]);

  useEffect(() => {
    if (visible) {
      translateY.setValue(SHEET_HEIGHT);
      animateTo("open");
    }
  }, [visible, animateTo, translateY]);

  /*
   * Drag-to-dismiss, attached to the handle only.
   *
   * Downward drags follow the finger; upward ones are ignored rather than
   * letting the sheet be pulled above its own top edge. Released past a third
   * of the height, or thrown down fast, it closes — otherwise it springs back,
   * so a half-hearted drag is never destructive.
   */
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) translateY.setValue(g.dy);
      },
      onPanResponderRelease: (_, g) => {
        const flung = g.vy > 0.8;
        if (g.dy > SHEET_HEIGHT / 3 || flung) {
          animateTo("closed", onClose);
        } else if (reduceMotionRef.current) {
          // Snap back with no bounce. The drag itself still tracked the
          // finger — that is direct manipulation, not animation — so all that
          // is removed here is the spring overshoot on release.
          translateY.setValue(0);
        } else {
          Animated.spring(translateY, { toValue: 0, useNativeDriver: Platform.OS !== "web", bounciness: 4 }).start();
        }
      },
    }),
  ).current;
  const dragHandlers = pan.panHandlers;
  const [inputFocused, setInputFocused] = useState(false);
  const composerInputId = `ask-finsight-input-${useId()}`;
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const style = document.createElement("style");
    const selector = `textarea[id="${composerInputId}"]`;
    style.textContent = `${selector} { scrollbar-width: none; outline: none; } ${selector}::-webkit-scrollbar { display: none; }`;
    document.head.appendChild(style);
    return () => style.remove();
  }, [composerInputId]);
  /**
   * Whether the history list is over the messages.
   *
   * A VIEW FLAG AND NOTHING ELSE. It reaches nothing that fetches and nothing
   * that holds a conversation, which is what makes toggling it incapable of
   * starting, clearing or reloading a thread — the same separation the store
   * gives `visible`, one level down.
   */
  const [historyOpen, setHistoryOpen] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const starterDraft = useRef<{ businessId: number | null; module: InteractionModule; draft: string } | null>(null);
  const attemptRef = useRef<SendAttempt | null>(null);
  const lifecycle = useRef({ businessId, generation: 0, mounted: true });
  if (lifecycle.current.businessId !== businessId) {
    lifecycle.current = { businessId, generation: lifecycle.current.generation + 1, mounted: lifecycle.current.mounted };
  }
  useEffect(() => {
    lifecycle.current.mounted = true;
    return () => {
      lifecycle.current.mounted = false;
      lifecycle.current.generation += 1;
    };
  }, []);
  const [failedSend, setFailedSend] = useState<SendAttempt | null>(null);
  const currentScope = useRef({ businessId, activeId: chat.activeId });
  if (currentScope.current.activeId !== chat.activeId && chat.sending) lifecycle.current.generation += 1;
  currentScope.current = { businessId, activeId: chat.activeId };

  useEffect(() => {
    setFailedSend(null);
  }, [businessId, chat.activeId]);
  useEffect(() => {
    attemptRef.current = null;
    starterDraft.current = null;
  }, [businessId]);

  /*
   * Opening the sheet does two things, and creating a conversation is not one
   * of them: it records which screen a NEW thread would start from, and it
   * asks for the history list, which the store fetches once per business and
   * then serves from memory. Reopening the sheet costs no request.
   */
  const { setSeedModule, ensureList, getState } = chat;
  useEffect(() => {
    if (!visible) {
      // A view reset and nothing more: the sheet should reopen on the
      // conversation, not on the list somebody was browsing last time.
      setHistoryOpen(false);
      return;
    }
    const state = getState();
    const chosen = starterDraft.current;
    const preserveStarter = chosen && chosen.businessId === businessId && state.activeId === null && state.input.trim() && state.input === chosen.draft && !state.pendingFocus && !state.pendingReductionOpportunity;
    setSeedModule(preserveStarter ? chosen.module : module);
    ensureList();
    // The store's own methods are stable for its lifetime, so this effect runs
    // on open and on a module change — never on every state update, which
    // would re-ask for the list after a failed fetch in a loop.
  }, [visible, module, businessId, getState, setSeedModule, ensureList]);

  const messages = chat.messages;
  const latestMessageId = messages.at(-1)?.id;
  useEffect(() => {
    if (!visible || latestMessageId === undefined) return;
    const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(timer);
  }, [visible, latestMessageId, chat.activeId]);

  async function submit(text: string, retry = false) {
    const question = text.trim();
    if (!question || chat.getState().sending || attemptRef.current || businessId === null) return;
    const attempt: SendAttempt = {
      question,
      businessId,
      conversationId: chat.activeId,
      draft: retry && chat.input !== question ? chat.input : null,
      generation: lifecycle.current.generation,
    };
    attemptRef.current = attempt;
    setFailedSend(null);
    haptics.pressed();
    const pending = retry && chat.pendingSend ? chat.retrySend() : chat.send(question);
    if (retry && attempt.draft !== null) chat.setInput(attempt.draft);
    await pending;
    if (attemptRef.current === attempt) attemptRef.current = null;
    if (!lifecycle.current.mounted || lifecycle.current.generation !== attempt.generation || currentScope.current.businessId !== attempt.businessId) return;
    const result = chat.getState();
    if (result.error && result.activeId === attempt.conversationId) setFailedSend(attempt);
    // The store restores the failed question; an independently typed draft
    // belongs to the composer while Retry continues to use the original.
    if (attempt.draft !== null && (!result.error || result.activeId === attempt.conversationId)) {
      chat.setInput(attempt.draft);
    }
  }

  function setDraft(value: string) {
    if (attemptRef.current) attemptRef.current.draft = value;
    if (starterDraft.current) starterDraft.current.draft = value;
    chat.setInput(value);
  }

  const latestPeriod = [...messages].reverse().find((message) => message.role === "assistant")?.metadata?.period;
  const showWelcome = chat.activeId === null && messages.length === 0 && !chat.messagesLoading && !chat.sending;
  const starters = [...STARTERS].sort((a, b) => Number(b.module === currentModule) - Number(a.module === currentModule));
  const canRetry = failedSend && failedSend.businessId === businessId && failedSend.conversationId === chat.activeId;

  return (
    <Modal
      visible={visible}
      animationType="none"
      transparent
      // Edge to edge on Android, so the sheet reaches the bottom of the screen
      // and the composer's own inset is the only gap under it. Without these
      // the window stopped above the navigation bar and the composer padded
      // for that bar a second time.
      statusBarTranslucent
      navigationBarTranslucent
      // Android's back button. While the history list is up it closes the
      // list, the way Escape does on web — backing out of the sheet entirely
      // from a list you only opened to look at is a step too far.
      onRequestClose={() => (historyOpen ? setHistoryOpen(false) : close())}
    >
      {/*
        A dimmed backdrop that closes on tap. `pageSheet` gave this behaviour
        on iOS for free and nothing at all on Android, where it fell back to an
        opaque full-screen modal — so the sheet is built here instead and both
        platforms get the same thing.
      */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          // A literal rather than `scrim`: this backdrop is animated through
          // `opacity`, so it needs an OPAQUE colour, and near-black is the
          // right one behind a sheet on either theme.
          { backgroundColor: "#0b1416", opacity: backdrop },
        ]}
      >
        <Pressable
          style={{ flex: 1 }}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Close Ask FinSight"
        />
      </Animated.View>

      <Animated.View
        accessibilityViewIsModal
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: SHEET_HEIGHT,
          backgroundColor: paper[50],
          borderTopLeftRadius: radius.xl,
          borderTopRightRadius: radius.xl,
          overflow: "hidden",
          transform: [{ translateY }],
        }}
      >
        <View style={{ backgroundColor: paper[50], paddingHorizontal: space.lg, paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: t.border }}>
          {/*
            The drag handle, and the ONLY part that responds to a drag. Putting
            the pan responder on the whole sheet would make it fight the
            message list for every vertical gesture, so scrolling up would
            close the sheet instead.
          */}
          <View {...dragHandlers} style={{ paddingVertical: space.md, alignItems: "center" }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.borderStrong }} />
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
            <T
              accessibilityRole="header"
              style={{ color: t.textPrimary, fontFamily: font.sansSemibold, fontSize: typeScale.title, flex: 1 }}
            >
              {historyOpen ? "Chat history" : "Ask FinSight"}
            </T>

            <Pressable
              onPress={() => {
                haptics.tapped();
                setHistoryOpen((open) => !open);
              }}
              accessibilityRole="button"
              accessibilityLabel={historyOpen ? "Back to this conversation" : "Chat history"}
              accessibilityState={{ expanded: historyOpen }}
              style={{ minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, alignItems: "center", justifyContent: "center" }}
            >
              <Ionicons name={historyOpen ? "chevron-back" : "time-outline"} size={20} color={t.textSecondary} />
            </Pressable>

            <Pressable
              onPress={() => {
                haptics.tapped();
                // Persists NOTHING — see lib/chatStore. It clears back to the
                // greeting, and only the first send creates a conversation, so
                // an abandoned empty chat never reaches the list.
                chat.newChat();
                starterDraft.current = null;
                setFailedSend(null);
                setHistoryOpen(false);
              }}
              accessibilityRole="button"
              accessibilityLabel="New chat"
              style={{ minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, alignItems: "center", justifyContent: "center" }}
            >
              <Ionicons name="add-outline" size={22} color={t.textSecondary} />
            </Pressable>

            <Pressable
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel="Close Ask FinSight"
              style={{ minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, alignItems: "center", justifyContent: "center" }}
            >
              <Ionicons name="close-outline" size={24} color={t.textSecondary} />
            </Pressable>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.sm }}>
            <Ionicons name="storefront-outline" size={14} color={t.textMuted} />
            <T variant="label" style={{ color: t.textSecondary, flex: 1 }}>{selected?.name ?? "Choose a business"}</T>
          </View>
          <T variant="caption" style={{ marginTop: space.xs }}>
            {historyOpen ? "Search or manage your saved conversations." : `${currentModule}${latestPeriod ? ` · ${latestPeriod}` : ""}`}
          </T>
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
          keyboardVerticalOffset={0}
        >
          {/*
            The message list and the history list share this one box, so the
            keyboard handling, the safe area and the drag gesture above are
            solved once for both. `historyOpen` swaps which is on top; neither
            unmounts the other's state, because neither of them holds any.
          */}
          <View style={{ flex: 1 }}>
            <FlatList
              ref={listRef}
              data={messages}
              keyExtractor={(m) => String(m.id)}
              keyboardShouldPersistTaps="handled"
              maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
              accessibilityElementsHidden={historyOpen}
              importantForAccessibility={historyOpen ? "no-hide-descendants" : "auto"}
              contentContainerStyle={{ padding: space.xl, paddingTop: showWelcome ? space.lg : space.xl, gap: space.xxl }}
              ListHeaderComponent={
                <View style={{ gap: space.xl }}>
                  {chat.messagesCursor ? <Button title="Load earlier messages" variant="secondary" loading={chat.messagesLoadingMore} onPress={() => void chat.loadOlderMessages()} /> : null}
                  {showWelcome ? (
                    <View style={{ gap: space.md }}>
                      <Mascot state="brandMark" size={56} style={{ alignSelf: "flex-start" }} />
                      <T accessibilityRole="header" style={{ fontFamily: font.sansSemibold, fontSize: typeScale.titleLg, lineHeight: 32, color: t.textPrimary }}>
                        Make sense of your numbers.
                      </T>
                      <T style={{ color: t.textMuted }}>Ask about your records, a planned expense or your recovery target.</T>
                      <View style={{ gap: space.xs, marginTop: space.xs }}>
                        <T variant="caption">Start with a question</T>
                        {starters.map((starter) => (
                          <Pressable
                            key={starter.module}
                            accessibilityRole="button"
                            accessibilityLabel={`Use this question: ${starter.question}`}
                            accessibilityHint={`Fills the question box for ${starter.module}. Tap Send when ready.`}
                            onPress={() => {
                              haptics.tapped();
                              chat.setSeedModule(starter.module);
                              chat.prepareQuestion(starter.question);
                              starterDraft.current = { businessId, module: starter.module, draft: starter.question };
                              setFailedSend(null);
                            }}
                            style={({ pressed }) => ({ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: pressed ? t.surfaceMuted : "transparent" })}
                          >
                            <Ionicons name={starter.icon} size={22} color={t.brandText} />
                            <View style={{ flex: 1, gap: space.xs }}>
                              <T style={{ fontFamily: font.sansMedium, color: t.textPrimary }}>{starter.question}</T>
                              <T variant="caption">{starter.module}</T>
                            </View>
                            <Ionicons name="chevron-forward" size={16} color={t.textMuted} />
                          </Pressable>
                        ))}
                      </View>
                    </View>
                  ) : null}
                  {chat.messagesLoading ? (
                    <T variant="caption" accessibilityLiveRegion="polite" style={{ textAlign: "center" }}>Loading this conversation…</T>
                  ) : null}
                </View>
              }
              renderItem={({ item, index }) =>
                item.role === "user" ? (
                  <Bubble>{item.content}</Bubble>
                ) : (
                  <View style={{ gap: space.md }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                      <Ionicons name="book-outline" size={16} color={t.brandText} />
                      <T variant="label" style={{ color: t.textSecondary, fontFamily: font.sansSemibold }}>FinSight</T>
                    </View>
                    <ChatMarkdown text={item.content} color={t.textSecondary} />
                    {item.metadata ? (
                      <ChatReplyExtras
                        metadata={item.metadata}
                        scopeKey={`${businessId}:${chat.activeId}`}
                        // The newest reply, while nothing newer is being
                        // written, is the one whose follow-ups and actions
                        // are still current.
                        latest={index === messages.length - 1 && !chat.sending}
                        feedback={item.feedback ?? null}
                        onFollowUp={(question) => {
                          setFailedSend(null);
                          chat.setInput(question);
                        }}
                        onRate={(value) => void chat.rate(item.id, value)}
                        onLeave={close}
                      />
                    ) : null}
                  </View>
                )
              }
              ListFooterComponent={
                <View style={{ gap: space.md, marginTop: space.md }}>
                  {chat.sending ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                      <ActivityIndicator color={brand[600]} />
                      <T variant="caption" accessibilityLiveRegion="polite">Working from your records…</T>
                    </View>
                  ) : null}
                  {chat.unavailable ? (
                    <ErrorNote>
                      FinSight's AI assistant is unreachable right now. The message above is a placeholder. Your other
                      screens still show figures calculated by FinSight.
                    </ErrorNote>
                  ) : null}
                  {/*
                    The figure drives a real calculation, so it is shown: if the
                    server misread "11,000" the owner should be able to see that
                    before trusting the answer built on it. Same disclosure web
                    makes, in the app's own Callout.
                  */}
                  {chat.detectedAmount !== null ? (
                    <Callout>
                      FinSight read {formatMoney(chat.detectedAmount)} from your question and used that figure in its
                      calculation.
                    </Callout>
                  ) : null}
                  {chat.error ? <ErrorNote>{chat.error}</ErrorNote> : null}
                  {chat.messagesError && chat.activeId !== null ? <Button title="Reload conversation" variant="secondary" loading={chat.messagesLoading} onPress={() => void chat.reloadConversation()} /> : null}
                  {chat.recoveryLoading ? <T variant="caption">Checking this device for an unfinished question…</T> : null}
                  {chat.recoveryError ? <View style={{ gap: space.sm }}><ErrorNote>{chat.recoveryError}</ErrorNote><Button title="Reload question recovery" variant="secondary" onPress={() => void chat.reloadRecovery()} /></View> : null}
                  {chat.pendingSend ? <View style={{ gap: space.sm }}>
                    <T variant="caption">Previous question: {chat.pendingSend.body.question}</T>
                    <Button title="Check previous question" variant="secondary" disabled={chat.sending} loading={chat.checkingSend} onPress={() => void chat.checkSend()} />
                    {chat.canRetrySend ? <Button title="Retry previous question" variant="secondary" disabled={chat.sending || chat.checkingSend} onPress={() => void chat.retrySend()} /> : null}
                  </View> : null}
                  {canRetry ? (
                    <View style={{ gap: space.sm }}>
                      <T variant="caption">Question to retry: {failedSend.question}</T>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Retry question"
                        disabled={chat.sending}
                        accessibilityState={{ disabled: chat.sending }}
                        onPress={() => void submit(failedSend.question, true)}
                        style={({ pressed }) => ({ minHeight: TAP_FLOOR, alignSelf: "flex-start", justifyContent: "center", paddingHorizontal: space.lg, borderRadius: radius.md, backgroundColor: pressed ? t.brandFillPressed : t.brandFill })}
                      >
                        <T style={{ color: t.onBrandFill, fontFamily: font.sansSemibold }}>Retry question</T>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              }
            />

            {historyOpen ? (
              <ChatHistoryPanel
                conversations={chat.conversations}
                activeId={chat.activeId}
                loading={chat.listLoading}
                error={chat.listError}
                hasMore={Boolean(chat.listCursor)}
                loadingMore={chat.listLoadingMore}
                onLoadMore={() => void chat.loadMoreConversations()}
                onRefresh={() => chat.reloadList()}
                onSelect={(id) => {
                  setFailedSend(null);
                  starterDraft.current = null;
                  void chat.selectConversation(id);
                  // Straight back to the messages: choosing a thread IS the
                  // exit from the list, so a separate "close" tap would be one
                  // the owner has already made.
                  setHistoryOpen(false);
                }}
                onRename={(id, title) => void chat.rename(id, title)}
                onDelete={(conversation) => {
                  haptics.committed();
                  void chat.remove(conversation.id);
                }}
                onRetry={() => chat.reloadList()}
              />
            ) : null}
          </View>

          {/*
            Hidden while the history list is up: a question typed there would
            go to whichever thread happens to be active behind the list.

            The composer clears the home indicator itself. The sheet is a bare
            Animated.View rather than a SafeAreaView, because the safe area
            belongs at the BOTTOM of the sheet only — applying it to the whole
            sheet would inset the header away from the rounded top corners.
          */}
          {historyOpen ? null : (
          <View
            style={{
              flexDirection: "column",
              alignItems: "stretch",
              gap: space.sm,
              padding: space.md,
              // With the keyboard up it already covers the home indicator, so
              // clearing it as well left a band of empty space above the keys.
              paddingBottom: space.md + (inputFocused ? 0 : insets.bottom),
              borderTopWidth: 1,
              borderTopColor: t.border,
              backgroundColor: paper[50],
            }}
          >
            <View style={{
              flexDirection: "row",
              alignItems: "flex-end",
              gap: space.xs,
              padding: space.xs,
              borderWidth: 1,
              borderColor: inputFocused ? t.brandText : t.ink[400],
              borderRadius: radius.lg,
              backgroundColor: t.surface,
            }}>
            <TextInput
              nativeID={composerInputId}
              accessibilityLabel="Ask about your business"
              value={chat.input}
              onChangeText={setDraft}
              placeholder="Ask about your business…"
              placeholderTextColor={t.textMuted}
              maxLength={FIELD_LIMITS.aiQuestion}
              /*
                Multi-line, so a question longer than the box stays readable
                while it is being written — a single line scrolled its own start
                out of sight. Return inserts a line break rather than sending;
                Send is the only way out, which is what every phone keyboard's
                return key already implies here.
              */
              multiline
              textAlignVertical="top"
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              style={{
                flex: 1,
                minHeight: TAP_FLOOR,
                // Around six lines. Past that the field scrolls, so the
                // composer can never grow over the conversation behind it.
                maxHeight: 140,
                borderWidth: 0,
                paddingHorizontal: space.sm,
                paddingVertical: space.md,
                fontFamily: font.sans,
                fontSize: typeScale.body,
                color: ink[900],
                backgroundColor: "transparent",
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              accessibilityState={{ disabled: !chat.input.trim() || chat.sending }}
              onPress={() => void submit(chat.input)}
              disabled={!chat.input.trim() || chat.sending}
              style={({ pressed }) => ({
                width: TAP_FLOOR,
                height: TAP_FLOOR,
                flexShrink: 0,
                alignSelf: "center",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: radius.md,
                backgroundColor: !chat.input.trim() || chat.sending ? t.surfaceMuted : pressed ? t.ACCENT.fillStrong : t.ACCENT.fill,
              })}
            >
              <Ionicons name="arrow-up" size={22} color={!chat.input.trim() || chat.sending ? t.textMuted : t.ACCENT.onFill} />
            </Pressable>
            </View>
            <T variant="caption" style={{ textAlign: "center" }}>Check important decisions against your records.</T>
          </View>
          )}
        </KeyboardAvoidingView>
      </Animated.View>
    </Modal>
  );
}

function Bubble({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: "flex-end" }}>
      <View
        style={{
          maxWidth: "88%",
          backgroundColor: t.surfaceMuted,
          borderRadius: radius.lg,
          borderBottomRightRadius: space.xs,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
        }}
      >
        <T style={{ color: t.textPrimary, fontSize: typeScale.body, lineHeight: 22 }}>{children}</T>
      </View>
    </View>
  );
}

/*
 * The rectangular "✦ Ask FinSight" trigger used to live here.
 *
 * Removed rather than left unused: every screen that had one — Home first,
 * then the three insight screens — now uses the mascot FAB in
 * components/AskFinSightFab, so this had no call sites left. A trigger that
 * still exists is a trigger the next screen will reach for, and then the app
 * has two ways to ask the same question that look nothing alike.
 */
