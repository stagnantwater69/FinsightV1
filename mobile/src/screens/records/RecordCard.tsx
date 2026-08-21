import { Pressable, View } from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import { Card, Money, T } from "../../components/ui";
import { formatMoney } from "../../lib/money";
import * as haptics from "../../lib/haptics";
import { brand, font, ink, radius, space, statusText, typeScale } from "../../theme/tokens";
import { RECORD_SOURCE_LABELS, type RecordItem, type RecordSource } from "../../lib/types";
import { badges } from "./shared";

/** The surface behind an expense medallion. See STATUS_SURFACE in Insights. */
const STATUS_SURFACE_SERIOUS = "#fdf0ea";

/**
 * One glyph per way a record can have arrived.
 *
 * Keyed by the SOURCE enum, not by its label. `RECORD_SOURCE_LABELS` maps
 * `MANUAL_ENTRY` to the words "Manual Entry", and keying on the words would
 * have missed on every row and quietly fallen through to the default glyph —
 * a lookup that never throws and is never right.
 */
const SOURCE_ICONS: Record<RecordSource, keyof typeof Ionicons.glyphMap> = {
  MANUAL_ENTRY: "create-outline",
  RECEIPT_SCAN: "camera-outline",
  CSV_UPLOAD: "cloud-upload-outline",
};

/**
 * The action revealed behind a swiped row.
 *
 * Full-height and colour-filled so the gesture reads as uncovering something
 * rather than dragging the card off its own background.
 */
function SwipeAction({
  label,
  icon,
  colour,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  colour: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        width: 84,
        marginBottom: space.sm,
        backgroundColor: colour,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.lg,
      }}
    >
      <Ionicons name={icon} size={20} color="#fff" />
      <T style={{ color: "#fff", fontSize: typeScale.micro, marginTop: 2 }}>{label}</T>
    </Pressable>
  );
}

export function RecordCard({
  r,
  categoryName,
  onPress,
  onDelete,
  onResolve,
}: {
  r: RecordItem;
  categoryName: string;
  onPress?: () => void;
  onDelete?: () => void;
  onResolve?: () => void;
}) {
  /*
   * Swipe reveals; it never acts on its own.
   *
   * A swipe that deleted on release would be a destructive action triggered by
   * a gesture people make accidentally while scrolling a list. Revealing a
   * button that must then be tapped keeps the shortcut without the hazard —
   * and `onDelete` still asks for confirmation on top of that.
   */
  /*
   * What this card says when it is read rather than seen.
   *
   * Left to itself it is announced as its children fall out of the layout:
   * description, then the date line with its middle dots, then the amount,
   * then each badge with its glyph, then the source. Nothing is missing from
   * that — it is just in layout order rather than reading order, and it
   * speaks separators that only exist to hold a row together. So the same
   * content is composed here in the order it matters: what the record is,
   * what it cost, when and under what, then anything flagged on it, then
   * where it came from. Same facts, no glyphs, figure second instead of third.
   *
   * This is the app's second composed label, after CategoryChips, and for the
   * same reason: the useful spoken form is not the visible arrangement.
   */
  const spoken = [
    r.description,
    formatMoney(r.amount),
    `${r.date.slice(0, 10)}, ${r.type === "expense" ? `expense, ${categoryName}` : "sales"}`,
    r.duplicateStatus === "Flagged" ? "possible duplicate" : null,
    r.reviewStatus === "Needs Review" ? "needs review" : null,
    r.largeExpenseFlag ? "large expense" : null,
    RECORD_SOURCE_LABELS[r.source as RecordSource] ?? r.source,
  ]
    .filter(Boolean)
    .join(", ");

  const card = (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      // A card with nothing wired to it is not a button, and saying it is
      // would promise a tap that does nothing. Both props hang off the same
      // condition as `disabled` so the three cannot disagree.
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={onPress ? spoken : undefined}
    >
      <Card style={{ marginBottom: space.sm }}>
        <View style={{ flexDirection: "row", gap: space.md }}>
          {/*
            A medallion, coloured by what the row IS rather than by its
            category. Sales rise and expenses leave, and that difference is
            the one an owner scanning a mixed list needs first — the category
            is written on the line below, where reading it is cheap.
          */}
          <View
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              backgroundColor: r.type === "expense" ? STATUS_SURFACE_SERIOUS : brand[50],
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons
              name={r.type === "expense" ? "bag-handle-outline" : "trending-up-outline"}
              size={19}
              color={r.type === "expense" ? statusText.serious : brand[700]}
            />
          </View>

          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <T style={{ flex: 1, fontFamily: font.sansMedium, color: ink[900] }} numberOfLines={2}>
                {r.description}
              </T>
              <Money
                value={r.amount}
                size={15}
                weight="semibold"
                decimals
                color={r.type === "expense" ? ink[900] : brand[700]}
              />
            </View>
            <T variant="caption" style={{ marginTop: 2 }}>
              {r.date.slice(0, 10)} · {r.type === "expense" ? `Expense · ${categoryName}` : "Sales"}
            </T>
            {badges(r)}
            {/*
              How the record got here, with the glyph that says it. Three
              sources look alike as words in a caption and quite different as
              icons, which is what makes "was this scanned or typed?"
              answerable at a glance.
            */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: space.sm }}>
              <Ionicons name={SOURCE_ICONS[r.source as RecordSource] ?? "ellipse-outline"} size={13} color={ink[400]} />
              <T variant="caption">{RECORD_SOURCE_LABELS[r.source as RecordSource] ?? r.source}</T>
            </View>
          </View>

          {onPress ? (
            <Ionicons name="chevron-forward" size={16} color={ink[300]} style={{ alignSelf: "center" }} />
          ) : null}
        </View>
      </Card>
    </Pressable>
  );

  // No actions wired means no gesture layer at all — a swipe that reveals
  // nothing is worse than a row that does not swipe.
  if (!onDelete && !onResolve) return card;

  const needsResolving = r.reviewStatus === "Needs Review" || r.duplicateStatus === "Flagged";

  return (
    <Swipeable
      overshootRight={false}
      overshootLeft={false}
      onSwipeableWillOpen={() => haptics.tapped()}
      renderRightActions={
        onDelete
          ? () => <SwipeAction label="Delete" icon="trash-outline" colour={statusText.critical} onPress={onDelete} />
          : undefined
      }
      renderLeftActions={
        onResolve && needsResolving
          ? () => (
              <SwipeAction
                label="Resolve"
                icon="checkmark-circle-outline"
                colour={statusText.good}
                onPress={onResolve}
              />
            )
          : undefined
      }
    >
      {card}
    </Swipeable>
  );
}
