import { Pressable, useWindowDimensions, View } from "react-native";
// Gesture handler 3 removed the legacy `Swipeable`; this is its maintained
// replacement (it runs on Reanimated). Same props for what this row uses.
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Card, Money, T } from "../../components/ui";
import { TAP_FLOOR } from "../../components/touchTarget";
import { formatMoney } from "../../lib/money";
import * as haptics from "../../lib/haptics";
import { font, radius, space, typeScale } from "../../theme/tokens";
import { useTheme } from "../../context/ThemeContext";
import { RECORD_SOURCE_LABELS, type RecordItem, type RecordSource } from "../../lib/types";
import { badges } from "./shared";

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
  onColour,
  onPress,
  marginBottom,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  colour: string;
  /** The ink for the glyph and the word sitting on `colour`. */
  onColour: string;
  onPress: () => void;
  /** Matches the row it sits behind, so the revealed block is the row's height. */
  marginBottom: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        width: 84,
        minHeight: TAP_FLOOR,
        marginBottom,
        backgroundColor: colour,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.lg,
      }}
    >
      <Ionicons name={icon} size={20} color={onColour} />
      <T style={{ color: onColour, fontSize: typeScale.micro, marginTop: 2 }}>{label}</T>
    </Pressable>
  );
}

/**
 * Where a row sits in its day's group on the Records list.
 *
 * The list reads like a bank statement: one card per day, a hairline between
 * its records, only the group's outer corners rounded. `solo` is a day with a
 * single record. A row that is not in a list at all (`only`, the default) is
 * a card of its own and shows its date, as it always did.
 */
export type RecordCardPosition = "only" | "solo" | "first" | "middle" | "last";

export function RecordCard({
  r,
  categoryName,
  onPress,
  onDelete,
  onResolve,
  position = "only",
}: {
  r: RecordItem;
  categoryName: string;
  onPress?: () => void;
  onDelete?: () => void;
  onResolve?: () => void;
  position?: RecordCardPosition;
}) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const stacked = width < 390 || fontScale > 1.2;
  const { brand, ink, statusText, statusSolid, statusSurface, textOnFill } = t;
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
    formatMoney(r.amount, { decimals: true }),
    `${r.date.slice(0, 10)}, ${r.type === "expense" ? `expense, ${categoryName}` : "sales"}`,
    r.duplicateStatus === "Flagged" ? "possible repeat" : null,
    r.reviewStatus === "Needs Review" ? "needs your check" : null,
    r.largeExpenseFlag ? "large expense" : null,
    RECORD_SOURCE_LABELS[r.source as RecordSource] ?? r.source,
  ]
    .filter(Boolean)
    .join(", ");

  const grouped = position !== "only";
  const opensGroup = position === "only" || position === "solo" || position === "first";
  const closesGroup = position === "only" || position === "solo" || position === "last";
  const rowGap = closesGroup ? space.sm : 0;
  /*
   * A grouped row draws only its share of the group's outline: the sides, a
   * top edge (the card's top on the first row, the divider on every other),
   * and the bottom edge only on the last. No shadow inside a group: one per
   * row would draw a seam at every divider.
   */
  const groupStyle = grouped
    ? {
        marginBottom: rowGap,
        paddingVertical: space.md,
        borderTopLeftRadius: opensGroup ? radius.lg : 0,
        borderTopRightRadius: opensGroup ? radius.lg : 0,
        borderBottomLeftRadius: closesGroup ? radius.lg : 0,
        borderBottomRightRadius: closesGroup ? radius.lg : 0,
        borderBottomWidth: closesGroup ? 1 : 0,
        shadowOpacity: 0,
        elevation: 0,
      }
    : { marginBottom: rowGap };

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
      <Card style={groupStyle}>
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
              backgroundColor: r.type === "expense" ? statusSurface.serious : brand[50],
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons
              name={r.type === "expense" ? "bag-handle-outline" : "trending-up-outline"}
              size={20}
              color={r.type === "expense" ? statusText.serious : brand[700]}
            />
          </View>

          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: stacked ? "column" : "row", gap: space.sm }}>
              <T style={{ flex: stacked ? undefined : 1, fontFamily: font.sansMedium, color: ink[900] }} numberOfLines={stacked ? undefined : 2}>
                {r.description}
              </T>
              <Money
                value={r.amount}
                size={15}
                weight="semibold"
                decimals
                color={r.type === "expense" ? ink[900] : brand[700]}
                style={{ maxWidth: "100%" }}
              />
            </View>
            {/*
              What it is, then how it got here, on one line. The source glyph
              still carries "was this scanned or typed?" at a glance — three
              sources look alike as words and quite different as icons — but it
              no longer costs the card a row of its own. Inside a day group the
              date is the group's header, so it is not repeated per row (it is
              still in the spoken label above).
            */}
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 5, rowGap: 2, marginTop: 2 }}>
              <T variant="caption">
                {grouped ? "" : `${r.date.slice(0, 10)} · `}
                {r.type === "expense" ? `Expense · ${categoryName}` : "Sales"}
                {" ·"}
              </T>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Ionicons name={SOURCE_ICONS[r.source as RecordSource] ?? "ellipse-outline"} size={13} color={ink[400]} />
                <T variant="caption">{RECORD_SOURCE_LABELS[r.source as RecordSource] ?? r.source}</T>
              </View>
            </View>
            {badges(r)}
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
    <ReanimatedSwipeable
      overshootRight={false}
      overshootLeft={false}
      onSwipeableWillOpen={() => haptics.tapped()}
      renderRightActions={
        onDelete
          ? () => (
              /*
                `statusSolid`, not `statusText`: this is a block of colour with
                white ink on it, which is the solid family's whole job. The
                text family lightens in Dark — the red step becomes #f89191 —
                and white on that is unreadable, so the fill has to come from
                the fixed steps that are guaranteed to carry `textOnFill`.
              */
              <SwipeAction
                label="Delete"
                icon="trash-outline"
                colour={statusSolid.critical}
                onColour={textOnFill}
                onPress={onDelete}
                marginBottom={rowGap}
              />
            )
          : undefined
      }
      renderLeftActions={
        onResolve && needsResolving
          ? () => (
              <SwipeAction
                label="Resolve"
                icon="checkmark-circle-outline"
                colour={statusSolid.good}
                onColour={textOnFill}
                onPress={onResolve}
                marginBottom={rowGap}
              />
            )
          : undefined
      }
    >
      {card}
    </ReanimatedSwipeable>
  );
}
