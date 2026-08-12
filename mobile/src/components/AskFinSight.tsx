import { useCallback, useEffect, useRef, useState } from "react";
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
import { Button, ErrorNote, T } from "./ui";
import { api, errorMessage } from "../lib/api";
import * as haptics from "../lib/haptics";
import { useReducedMotion } from "../lib/useReducedMotion";
import { brand, font, ink, paper, radius, space, TAP, typeScale } from "../theme/tokens";
import type { AIInteraction, AskResponse, InteractionModule } from "../lib/types";
import { FIELD_LIMITS } from "../lib/fieldLimits";

/**
 * Ask FinSight — a full-screen modal per module.
 *
 * The web app uses a side drawer, which is a desktop pattern that makes no
 * sense on a phone: a 420px panel over a 375px screen is just a worse
 * full-screen view. This presents as a modal sheet instead, which is the native
 * idiom and gets the keyboard handling right.
 *
 * Everything else is identical to web: same endpoint, same per-module threading,
 * and no client-side context — the server rebuilds it from fresh data on every
 * message, which is what lets a follow-up see a record added seconds ago.
 */

const MODULE_COPY: Record<InteractionModule, { title: string; scope: string; greeting: string; starters: string[] }> = {
  Dashboard: {
    title: "Ask about your dashboard",
    scope: "Scoped to your Dashboard — totals, what needs review, and your recovery pace.",
    greeting: "I can explain what's on your dashboard right now. What would you like to know?",
    starters: ["Summarise this month for me", "What needs my attention?", "How can I reduce my expenses?"],
  },
  "Expense Insights": {
    title: "Ask about your expenses",
    scope: "Scoped to Expense Insights — category shares, increases, and unusual records.",
    greeting: "I can help you understand your expense behaviour. What would you like to know?",
    starters: ["Why did my expenses increase?", "Which category is highest?", "How can I reduce my expenses?"],
  },
  "Spending Impact": {
    title: "Ask about spending",
    scope: "Describe a planned expense in your own words. The numbers are computed, not estimated by AI.",
    greeting: 'Try: "What if I spend ₱11,000 on a fridge?"',
    starters: ["What if I spend ₱11,000 on a fridge?", "Is this a large expense for me?"],
  },
  "Recovery Target": {
    title: "Ask about recovery",
    scope: "Scoped to Recovery Target — today's gap and your remaining operating days.",
    greeting: "I can compare your recorded sales against your needed target. What would you like to check?",
    starters: ["How much more sales do I need?", "Did I reach today's target?", "What is my adjusted daily target?"],
  },
};

export function AskFinSight({
  visible,
  onClose,
  businessProfileId,
  module,
}: {
  visible: boolean;
  onClose: () => void;
  businessProfileId: number;
  module: InteractionModule;
}) {
  const copy = MODULE_COPY[module];

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
          useNativeDriver: true,
        }),
        Animated.timing(backdrop, {
          toValue: dimmed,
          duration: to === "open" ? 260 : 200,
          useNativeDriver: true,
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
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
        }
      },
    }),
  ).current;
  const dragHandlers = pan.panHandlers;
  const [messages, setMessages] = useState<AIInteraction[]>([]);
  const [input, setInput] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const listRef = useRef<FlatList<AIInteraction>>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoadingHistory(true);
    setError(null);
    api
      .get<AIInteraction[]>("/ai/history", { businessProfileId, module, limit: 20 })
      .then((data) => !cancelled && setMessages(data))
      .catch((err) => !cancelled && setError(errorMessage(err)))
      .finally(() => !cancelled && setLoadingHistory(false));
    return () => {
      cancelled = true;
    };
  }, [visible, businessProfileId, module]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || sending) return;
    setInput("");
    setSending(true);
    setError(null);
    setUnavailable(false);
    try {
      const data = await api.post<AskResponse>("/ai/ask", { businessProfileId, module, question });
      setMessages((prev) => [...prev, data]);
      // Both providers failed. The backend still returns 201 with a placeholder,
      // so it is surfaced as an outage rather than allowed to read as a real
      // considered answer.
      if (data.provider === "unavailable") setUnavailable(true);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal visible={visible} animationType="none" transparent onRequestClose={onClose}>
      {/*
        A dimmed backdrop that closes on tap. `pageSheet` gave this behaviour
        on iOS for free and nothing at all on Android, where it fell back to an
        opaque full-screen modal — so the sheet is built here instead and both
        platforms get the same thing.
      */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
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
        <View style={{ backgroundColor: brand[800], paddingHorizontal: space.lg, paddingBottom: space.lg }}>
          {/*
            The drag handle, and the ONLY part that responds to a drag. Putting
            the pan responder on the whole sheet would make it fight the
            message list for every vertical gesture, so scrolling up would
            close the sheet instead.
          */}
          <View {...dragHandlers} style={{ paddingVertical: space.md, alignItems: "center" }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: brand[500] }} />
          </View>

          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
            <T style={{ color: "#fff", fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg, flex: 1 }}>✦ {copy.title}</T>
            <Pressable
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel="Close Ask FinSight"
              hitSlop={12}
              style={{ minWidth: TAP, minHeight: TAP, alignItems: "flex-end", justifyContent: "center" }}
            >
              <T style={{ color: "#fff", fontSize: 22 }}>×</T>
            </Pressable>
          </View>
          <T style={{ color: brand[50], fontSize: typeScale.caption, marginTop: space.sm, lineHeight: 18 }}>{copy.scope}</T>
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
          keyboardVerticalOffset={0}
        >
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => String(m.id)}
            contentContainerStyle={{ padding: space.lg, gap: space.md }}
            ListHeaderComponent={
              <View style={{ gap: space.md }}>
                <Bubble from="ai">{copy.greeting}</Bubble>
                {loadingHistory ? <T variant="caption" style={{ textAlign: "center" }}>Loading earlier messages…</T> : null}
              </View>
            }
            renderItem={({ item }) => (
              <View style={{ gap: space.md }}>
                <Bubble from="user">{item.question}</Bubble>
                <Bubble from="ai">{item.answer}</Bubble>
              </View>
            )}
            ListFooterComponent={
              <View style={{ gap: space.md, marginTop: space.md }}>
                {sending ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                    <ActivityIndicator color={brand[600]} />
                    <T variant="caption">Working from your records…</T>
                  </View>
                ) : null}
                {unavailable ? (
                  <ErrorNote>
                    FinSight's AI assistant is unreachable right now, so the message above is a placeholder rather than
                    a real answer. The figures on your other screens are unaffected — those are calculated by FinSight,
                    not by AI.
                  </ErrorNote>
                ) : null}
                {error ? <ErrorNote>{error}</ErrorNote> : null}
                {messages.length === 0 && !loadingHistory ? (
                  <View style={{ gap: space.sm }}>
                    {copy.starters.map((s) => (
                      <Pressable
                        key={s}
                        onPress={() => {
                          haptics.tapped();
                          setInput(s);
                        }}
                        accessibilityRole="button"
                        // Read out bare, a starter sounds like a question that
                        // has already been asked. The label says what the tap
                        // actually does — it fills the box, it does not send.
                        accessibilityLabel={`Use this question: ${s}`}
                        style={{
                          minHeight: TAP,
                          justifyContent: "center",
                          borderWidth: 1,
                          borderColor: brand[200],
                          borderRadius: radius.full,
                          paddingHorizontal: space.md,
                        }}
                      >
                        <T style={{ color: brand[700], fontSize: typeScale.label }}>{s}</T>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>
            }
          />

          {/*
            The composer clears the home indicator itself. The sheet is a bare
            Animated.View rather than a SafeAreaView, because the safe area
            belongs at the BOTTOM of the sheet only — applying it to the whole
            sheet would inset the dark header away from the rounded top corners.
          */}
          <View
            style={{
              flexDirection: "row",
              gap: space.sm,
              padding: space.md,
              paddingBottom: space.md + insets.bottom,
              borderTopWidth: 1,
              borderTopColor: ink[200],
              backgroundColor: paper.DEFAULT,
            }}
          >
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Ask about your numbers…"
              placeholderTextColor={ink[400]}
              maxLength={FIELD_LIMITS.aiQuestion}
              onSubmitEditing={() => send(input)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              /*
                Same focus border as every other input in the app. The argument
                for leaving it off — one input, keyboard already up, nothing to
                disambiguate — is true here, but it is just as true of the
                single-field password reset screen, which has the border. An
                input that behaves differently for reasons the owner cannot see
                is the kind of small exception that makes an app feel assembled
                rather than designed.
              */
              style={{
                flex: 1,
                minHeight: TAP,
                borderWidth: 1,
                borderColor: inputFocused ? brand[600] : ink[200],
                borderRadius: radius.full,
                paddingHorizontal: space.md,
                fontSize: typeScale.body,
                color: ink[900],
              }}
            />
            <Button title="Send" onPress={() => send(input)} disabled={!input.trim() || sending} />
          </View>
        </KeyboardAvoidingView>
      </Animated.View>
    </Modal>
  );
}

function Bubble({ from, children }: { from: "ai" | "user"; children: React.ReactNode }) {
  const isUser = from === "user";
  return (
    <View style={{ alignItems: isUser ? "flex-end" : "flex-start" }}>
      <View
        style={{
          maxWidth: "88%",
          backgroundColor: isUser ? brand[600] : paper.DEFAULT,
          borderWidth: isUser ? 0 : 1,
          borderColor: brand[100],
          borderRadius: radius.lg,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
        }}
      >
        <T style={{ color: isUser ? "#fff" : ink[700], fontSize: typeScale.bodySm, lineHeight: 20 }}>{children}</T>
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
