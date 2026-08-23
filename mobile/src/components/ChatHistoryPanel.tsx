import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert as RNAlert,
  Animated,
  Easing,
  Pressable,
  SectionList,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ErrorNote, T } from "./ui";
import * as haptics from "../lib/haptics";
import { CONVERSATION_TITLE_MAX } from "../lib/chatStore";
import { groupConversations } from "../lib/conversationGroups";
import { useReducedMotion } from "../lib/useReducedMotion";
import { TAP, radius, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import type { Conversation } from "../lib/types";

/**
 * The date-grouped conversation list, drawn OVER the sheet's message list.
 *
 * IT IS NOT A SECOND SCREEN AND NOT A SECOND MODAL. Ask FinSight is one sheet
 * that has already solved the hard parts — the keyboard, the drag-to-dismiss
 * gesture, the safe area at the bottom only — and every one of those would have
 * to be solved again in a second surface, or lost. Pushing a screen would also
 * take the conversation off-screen to go and look for another one, which is the
 * opposite of what a history list is for. So history is a MODE of the sheet: it
 * covers the messages, takes the full width while it is up, and gives it all
 * back the moment a conversation is chosen. This is the native equivalent of
 * what web does with its in-drawer overlay.
 *
 * NOTHING IN HERE TOUCHES CONVERSATION STATE. It receives a list and four
 * callbacks. Showing and hiding it is a flag in the sheet that reaches nothing
 * which fetches — the same separation lib/chatStore's header describes, one
 * level down.
 */

export function ChatHistoryPanel({
  conversations,
  activeId,
  loading,
  error,
  onSelect,
  onRename,
  onDelete,
}: {
  conversations: Conversation[];
  activeId: number | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onDelete: (conversation: Conversation) => void;
}) {
  const t = useTheme();
  const { brand, ink, paper } = t;
  const sections = groupConversations(conversations).map((group) => ({
    title: group.label,
    data: group.conversations,
  }));

  /*
   * The arrival: an 8px slide from the right with a fade, which is the app's
   * "a panel came over the top" entrance. Both properties run on the native
   * driver, so it stays smooth while the list is still being fetched — the
   * exact moment the JS thread is busy.
   */
  const reduceMotion = useReducedMotion();
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduceMotion) {
      // Straight to the end state. The panel must still ARRIVE — skipping the
      // animation without setting the value would leave it invisible.
      enter.setValue(1);
      return;
    }
    Animated.timing(enter, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [enter, reduceMotion]);

  return (
    <Animated.View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        // Opaque: bubbles showing through a translucent list would read as two
        // conversations at once.
        backgroundColor: paper[50],
        opacity: enter,
        transform: [{ translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
      }}
    >
      <SectionList
        sections={sections}
        keyExtractor={(item) => String(item.id)}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space.md, paddingBottom: space.xxl }}
        renderSectionHeader={({ section }) => (
          <T
            variant="caption"
            accessibilityRole="header"
            style={{
              color: ink[500],
              textTransform: "uppercase",
              letterSpacing: 0.6,
              paddingHorizontal: space.sm,
              paddingTop: space.md,
              paddingBottom: space.xs,
              backgroundColor: paper[50],
            }}
          >
            {section.title}
          </T>
        )}
        renderItem={({ item }) => (
          <ConversationRow
            conversation={item}
            active={item.id === activeId}
            onSelect={() => onSelect(item.id)}
            onRename={(title) => onRename(item.id, title)}
            onDelete={() => onDelete(item)}
          />
        )}
        ListHeaderComponent={
          loading ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm }}>
              <ActivityIndicator color={brand[600]} />
              <T variant="caption">Loading your conversations…</T>
            </View>
          ) : error ? (
            <View style={{ padding: space.sm }}>
              <ErrorNote>{error}</ErrorNote>
            </View>
          ) : null
        }
        ListEmptyComponent={
          loading || error ? null : (
            <T variant="caption" style={{ padding: space.md, lineHeight: 18 }}>
              Your conversations will appear here once you ask something.
            </T>
          )
        }
      />
    </Animated.View>
  );
}

/**
 * One row, plus the two things that can be done to it.
 *
 * THE ACTIONS ARE A SYSTEM DIALOG, NOT A POPOVER MENU. A menu anchored to a row
 * is a pointer pattern: on a phone it lands under the thumb that opened it and
 * has to be dismissed by tapping somewhere that means nothing. `Alert.alert` is
 * what the rest of this app already uses for exactly this — see
 * RecordsListScreen's swipe-to-delete — and it costs nothing to reach
 * one-handed. Both a long press on the row and the "…" button open it, so the
 * actions are discoverable without the owner having to know about long press.
 *
 * RENAME IS INLINE, AND NOT `Alert.prompt`. `Alert.prompt` exists on iOS only,
 * and this app's owners are on Android almost without exception — a rename that
 * silently did nothing on their phone is worse than no rename. So the row turns
 * into a text field in place, which also keeps the rows either side visible,
 * which is usually why you are renaming it at all.
 *
 * DELETE ASKS AGAIN, destructively. Same shape as every other delete
 * confirmation in the app: a cancel that says what keeping it means, and a
 * red-styled confirm.
 */
function ConversationRow({
  conversation,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: Conversation;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const t = useTheme();
  const { brand, ink, paper } = t;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conversation.title);

  function startRename() {
    setDraft(conversation.title);
    setEditing(true);
  }

  function commitRename() {
    setEditing(false);
    const next = draft.trim();
    // An empty title is a slip, not an edit — the row would become blank
    // space. Keep what was there.
    if (!next || next === conversation.title) return;
    onRename(next);
  }

  function openActions() {
    haptics.tapped();
    RNAlert.alert(conversation.title, undefined, [
      { text: "Rename", onPress: startRename },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          RNAlert.alert(
            "Delete this conversation?",
            `"${conversation.title}" and every message in it will be removed. Your records and figures are not affected.`,
            [
              { text: "Keep it", style: "cancel" },
              { text: "Delete", style: "destructive", onPress: onDelete },
            ],
          );
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  if (editing) {
    return (
      <View style={{ paddingVertical: space.xs }}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          autoFocus
          maxLength={CONVERSATION_TITLE_MAX}
          accessibilityLabel="Rename conversation"
          returnKeyType="done"
          onSubmitEditing={commitRename}
          onBlur={commitRename}
          style={{
            minHeight: TAP,
            borderWidth: 1,
            borderColor: brand[600],
            borderRadius: radius.md,
            paddingHorizontal: space.md,
            fontSize: typeScale.bodySm,
            color: ink[900],
            backgroundColor: paper.DEFAULT,
          }}
        />
      </View>
    );
  }

  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: space.xs }}>
      <Pressable
        onPress={() => {
          haptics.tapped();
          onSelect();
        }}
        onLongPress={openActions}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`Open conversation: ${conversation.title}`}
        accessibilityHint="Long press for rename and delete"
        style={{
          flex: 1,
          minHeight: TAP,
          justifyContent: "center",
          paddingHorizontal: space.md,
          borderRadius: radius.md,
          // "Which one am I in" is carried by the row lifting onto paper with a
          // hairline, the way an active tab does — not by a block of brand
          // colour, which in a list of a dozen rows reads as a stripe that
          // pulls the eye off the conversation itself.
          backgroundColor: active ? paper.DEFAULT : "transparent",
          borderWidth: 1,
          borderColor: active ? brand[200] : "transparent",
        }}
      >
        <T numberOfLines={1} style={{ color: active ? ink[900] : ink[700], fontSize: typeScale.bodySm }}>
          {conversation.title}
        </T>
      </Pressable>

      <Pressable
        onPress={openActions}
        accessibilityRole="button"
        accessibilityLabel={`More options for ${conversation.title}`}
        hitSlop={8}
        style={{ minWidth: TAP, minHeight: TAP, alignItems: "center", justifyContent: "center" }}
      >
        <Ionicons name="ellipsis-horizontal" size={18} color={ink[500]} />
      </Pressable>
    </View>
  );
}
