import { forwardRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextProps,
  TextStyle,
  View,
  ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ACCENT, brand, font, ink, paper, radius, space, status, statusText, TAP, typeScale } from "../theme/tokens";
import { formatMoney, type AlertKind } from "../lib/money";
import * as haptics from "../lib/haptics";

/**
 * Shared primitives, mirroring the web design system.
 *
 * ACCESSIBILITY: no text style here sets `allowFontScaling={false}`, so every
 * label respects the system font-size setting. Containers use minHeight rather
 * than fixed height for the same reason — when a user scales type up, rows grow
 * instead of clipping.
 */

// ---------------------------------------------------------------- Text

type Variant = "titleLg" | "title" | "heading" | "body" | "label" | "caption";

/*
 * These are type styles, not semantics. `heading` says "semibold sans at 15px";
 * it does not say "this is a section header". Hanging
 * accessibilityRole="header" off the variant would mean the next person who
 * reaches for `heading` because of how it looks quietly changes where a screen
 * reader is allowed to jump to. The components that are headings by
 * construction — ScreenHeader, EmptyState, and charts' ChartFrame — declare the
 * role themselves, where it describes the thing rather than its font.
 */
/*
 * `title` is 18, not 20. Before this scale existed, 16 of the 21 screens that
 * used `variant="title"` overrode it to 18 and only two left 20 standing — so
 * 18 was already the app's screen title in practice and 20 was a number nobody
 * had gone back to fix. `titleLg` exists for the one genuine hero (the auth
 * screens' headline), which is the only place 26 was ever wanted.
 *
 * `heading` is sans, not the display face. The display face is Sora, which is
 * geometric and wide — it earns its keep at 18 and above and reads worse than
 * Inter at 15, which is exactly the dense-list size `heading` is used at. So
 * the display face stops at `title`.
 */
const TEXT_VARIANTS: Record<Variant, TextStyle> = {
  titleLg: { fontFamily: font.displayBold, fontSize: typeScale.titleLg, color: brand[900] },
  title: { fontFamily: font.displayBold, fontSize: typeScale.title, color: brand[900] },
  heading: { fontFamily: font.sansSemibold, fontSize: typeScale.body, color: ink[700] },
  body: { fontFamily: font.sans, fontSize: typeScale.body, color: ink[700], lineHeight: 22 },
  label: { fontFamily: font.sansMedium, fontSize: typeScale.label, color: ink[500] },
  caption: { fontFamily: font.sans, fontSize: typeScale.caption, color: ink[500] },
};

export function T({
  variant = "body",
  style,
  children,
  ...rest
}: TextProps & { variant?: Variant; children?: ReactNode }) {
  return (
    <Text style={[TEXT_VARIANTS[variant], style]} {...rest}>
      {children}
    </Text>
  );
}

/**
 * A peso amount. Monospaced with tabular figures, exactly as on web — so a
 * column of amounts lines up and the app reads like a ledger.
 *
 * `fontVariant: ["tabular-nums"]` is honoured on iOS; on Android the mono face
 * is already fixed-advance, so alignment holds either way.
 */
export function Money({
  value,
  // No screen passes these two yet. They are kept because they are the only
  // route to formatMoney's decimal and bare forms, which money.test.ts covers.
  decimals = false,
  bare = false,
  size = typeScale.body,
  color = ink[900],
  weight = "medium",
  style,
}: {
  value: number;
  decimals?: boolean;
  bare?: boolean;
  size?: number;
  color?: string;
  weight?: "regular" | "medium" | "semibold";
  style?: TextStyle;
}) {
  const family =
    weight === "semibold" ? font.monoSemibold : weight === "medium" ? font.monoMedium : font.mono;
  return (
    <Text
      style={[{ fontFamily: family, fontSize: size, color, fontVariant: ["tabular-nums"] }, style]}
    >
      {formatMoney(value, { decimals, bare })}
    </Text>
  );
}

// ---------------------------------------------------------------- Button

type ButtonVariant = "primary" | "brand" | "secondary" | "ghost" | "danger";

export function Button({
  title,
  onPress,
  variant = "brand",
  disabled,
  loading,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}) {
  // primary = the amber accent, with DARK ink on it. White on amber measures
  // 2.04:1 and fails; this is the same rule the web app follows.
  const bg = {
    primary: ACCENT.fill,
    brand: brand[600],
    secondary: paper.DEFAULT,
    ghost: "transparent",
    danger: paper.DEFAULT,
  }[variant];
  const fg = {
    primary: ACCENT.onFill,
    brand: "#ffffff",
    secondary: ink[700],
    ghost: ink[500],
    danger: "#b91c1c",
  }[variant];
  const border =
    variant === "secondary" ? ink[200] : variant === "danger" ? "#fca5a5" : "transparent";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!loading }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: border, opacity: disabled || loading ? 0.6 : pressed ? 0.85 : 1 },
        style,
      ]}
    >
      {/*
        The label is capped at one line. A button that wraps reads as a broken
        layout rather than a longer label, and when two sit side by side in a
        row it drags the whole row taller than its neighbour. Nothing is at
        risk of being clipped: the longest title in the app measures 213px
        against a 262px budget on the narrowest screen supported, so the cap
        only ever catches a label already too long to belong on a button.
      */}
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text numberOfLines={1} style={{ fontFamily: font.sansSemibold, fontSize: typeScale.body, color: fg }}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

// ---------------------------------------------------------------- Form

type FieldProps = {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  /**
   * What is wrong with this field, shown under it.
   *
   * The forms had no way to say this at all: a rejected registration showed
   * one sentence at the bottom of the screen and left the owner to work out
   * which of six boxes it meant. Wiring it into `Field` rather than into each
   * screen is what makes the border, the message and the announcement agree
   * — the same argument the web app's own Field makes at the top of its file.
   */
  error?: string | null;
} & React.ComponentProps<typeof TextInput>;

/**
 * A labelled text input — the field every form in the app is built from.
 *
 * It is a forwardRef so a form can hand the keyboard on from one field to the
 * next: `onSubmitEditing` needs a ref to call `focus()` on, and a plain
 * function component swallows `ref` silently.
 *
 * `onFocus`/`onBlur` are pulled out of `rest` deliberately. `{...rest}` is
 * spread last so callers can override anything, which means a caller's own
 * `onFocus` would otherwise replace the one driving the focus border rather
 * than run alongside it. Pulling them out lets both run.
 *
 * Note `style` is still overridable and would replace the input's styling
 * wholesale, focus border included. No caller passes one today; if one ever
 * needs to, compose it as an array here rather than at the call site.
 */
export const Field = forwardRef<TextInput, FieldProps>(function Field(
  { label, value, onChangeText, onFocus, onBlur, secureTextEntry, error, ...rest },
  ref,
) {
  const [focused, setFocused] = useState(false);

  /*
   * Whether a password is currently readable.
   *
   * DEFAULT OFF, and reset on every mount, so nothing is ever shown that the
   * owner did not just ask to see. It exists because a password field is the
   * one input in the app that gives no feedback at all, and it is also the
   * one people most often get wrong — on a phone keyboard, with a capital
   * letter they cannot see. The alternative to revealing it is a failed login
   * nobody can diagnose, which on the login screen is indistinguishable from
   * a wrong account.
   *
   * The state lives here rather than at the call site because `Field` is what
   * knows how to lay the control out, and a toggle bolted on from outside is
   * how the button ends up overlapping the text on the one screen nobody
   * re-checked.
   */
  const [revealed, setRevealed] = useState(false);

  /*
   * The eye appears only once there is something to reveal.
   *
   * An empty password box has nothing to show, so a control sitting in it is
   * a button that does nothing — and on the login screen it is the first
   * thing the eye lands on, competing with the field it decorates. It arrives
   * with the first character.
   *
   * Clearing the field also re-hides: someone who reveals a password, clears
   * it and types a new one would otherwise have the new one on screen without
   * ever asking, because the reveal state outlived the value it described.
   */
  const isPassword = secureTextEntry === true;
  const hasText = value.length > 0;
  const showing = revealed && hasText;

  return (
    <View style={{ marginBottom: space.md }}>
      <T variant="label" style={{ marginBottom: 4, color: ink[700] }}>
        {label}
      </T>
      <View style={{ justifyContent: "center" }}>
        <TextInput
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          placeholderTextColor={ink[400]}
          secureTextEntry={isPassword && !showing}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={{
            minHeight: TAP,
            // Width stays at 1 either way: a thicker focus border would reflow
            // every field below it each time focus moves. Colour alone carries it.
            borderWidth: 1,
            // An error outranks focus: the field an owner is fixing is the
            // one they are in, and losing the red the moment they tap it
            // takes the marker away exactly when it is being acted on.
            borderColor: error ? statusText.critical : focused ? brand[600] : ink[200],
            borderRadius: radius.md,
            paddingHorizontal: space.md,
            // Room for the reveal button, so a long password never runs
            // underneath it.
            paddingRight: isPassword && hasText ? 48 : space.md,
            paddingVertical: space.sm,
            fontSize: typeScale.body,
            color: ink[900],
            backgroundColor: paper.DEFAULT,
          }}
          {...rest}
        />
        {isPassword && hasText ? (
          <Pressable
            onPress={() => setRevealed((r) => !r)}
            accessibilityRole="button"
            /*
             * The label states the ACTION, and accessibilityState carries the
             * current state. A label describing the state instead would leave
             * a screen-reader user unable to tell what pressing it would do —
             * and an icon on its own says nothing at all.
             */
            accessibilityLabel={showing ? "Hide password" : "Show password"}
            accessibilityState={{ selected: showing }}
            hitSlop={10}
            style={{
              position: "absolute",
              right: 4,
              paddingHorizontal: space.sm,
              paddingVertical: space.sm,
            }}
          >
            <Ionicons
              name={showing ? "eye-off-outline" : "eye-outline"}
              size={20}
              color={ink[500]}
            />
          </Pressable>
        ) : null}
      </View>
      {/*
        `accessibilityLiveRegion` so a message that appears after a failed
        submit is spoken, rather than sitting silently under a field the
        owner has already moved past. The glyph is there because severity is
        never carried by colour alone — the same rule Alert and Callout follow.
      */}
      {error ? (
        <View
          accessibilityLiveRegion="polite"
          style={{ flexDirection: "row", gap: 5, marginTop: 5, alignItems: "flex-start" }}
        >
          <T style={{ fontSize: typeScale.micro, color: statusText.critical }}>⚠</T>
          <T style={{ flex: 1, fontSize: typeScale.caption, lineHeight: 17, color: statusText.critical }}>{error}</T>
        </View>
      ) : null}
    </View>
  );
});

/**
 * A labelled checkbox.
 *
 * Its own component because a checkbox's label sits BESIDE the control rather
 * than above it, which is the one shape `Field` cannot express — and
 * hand-rolling it at the call site is how the hit area ends up being the 20px
 * box instead of the whole row. The whole row is the target here, label
 * included.
 */
export function Checkbox({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  /** Optional line under the label, for saying what the choice actually does. */
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Pressable
      onPress={() => onChange(!checked)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={hint ? `${label}. ${hint}` : label}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space.sm,
        minHeight: TAP,
        paddingVertical: space.sm,
        marginBottom: space.md,
      }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          marginTop: 1,
          borderRadius: 5,
          borderWidth: checked ? 0 : 1.5,
          borderColor: ink[300],
          backgroundColor: checked ? brand[600] : paper.DEFAULT,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* The tick is not the only signal — the fill carries it too. */}
        {checked ? <Ionicons name="checkmark" size={14} color="#ffffff" /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <T style={{ fontSize: typeScale.bodySm, color: ink[700] }}>{label}</T>
        {hint ? (
          <T variant="caption" style={{ marginTop: 2 }}>
            {hint}
          </T>
        ) : null}
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------- Selection

/**
 * One choice out of a list, behind a dropdown.
 *
 * WHY THIS EXISTS ALONGSIDE `SelectChip`. Chips are right when the options
 * are few and the owner benefits from seeing them all at once — a period
 * filter, a record type. They are wrong for categories on an itemised
 * receipt, which is where they were being used: a business with a dozen
 * categories renders a dozen chips wrapping over three or four lines, and
 * then does it AGAIN for every line on the receipt. A nine-item receipt put
 * roughly a hundred chips on one screen, which is most of why that screen was
 * unreadable.
 *
 * A dropdown trades one tap for a constant, scannable row. The list itself
 * gets a sheet with room to breathe, which is also where a long category list
 * stops being a wall.
 *
 * Deliberately not a native picker: `@react-native-picker/picker` renders as
 * a system control that takes no styling on Android, so it would be the one
 * input in the app that ignores the design system entirely.
 */
export function CategorySelect<Option extends { id: number; name: string }>({
  options,
  value,
  onChange,
  placeholder = "Choose a category",
  /** What this selects FOR — read out after the value, never shown. */
  accessibilityContext,
  sheetTitle = "Choose a category",
  disabled,
}: {
  options: readonly Option[];
  value: number | null;
  onChange: (id: number) => void;
  placeholder?: string;
  accessibilityContext?: string;
  sheetTitle?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();

  const selected = options.find((o) => o.id === value) ?? null;

  return (
    <>
      <Pressable
        onPress={() => {
          haptics.tapped();
          setOpen(true);
        }}
        disabled={disabled}
        accessibilityRole="button"
        /*
         * The value first, then what it is for. A screen reader moving down
         * an itemised receipt hears "Inventory, category for Rice 25kg" —
         * "Inventory" alone would not say which line it files.
         */
        accessibilityLabel={
          `${selected ? selected.name : placeholder}` +
          (accessibilityContext ? `, category for ${accessibilityContext}` : ", category")
        }
        accessibilityState={{ disabled: !!disabled, expanded: open }}
        style={({ pressed }) => ({
          minHeight: TAP,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.sm,
          borderWidth: 1,
          borderColor: selected ? ink[200] : status.warning,
          borderRadius: radius.md,
          backgroundColor: paper.DEFAULT,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          opacity: disabled ? 0.6 : pressed ? 0.85 : 1,
        })}
      >
        <T
          numberOfLines={1}
          style={{
            flex: 1,
            fontSize: typeScale.bodySm,
            // An unset category is not a placeholder to be styled away — it is
            // the thing standing between the owner and saving, so it is
            // written in the colour the rest of the app uses for "needs you".
            color: selected ? ink[900] : statusText.warning,
          }}
        >
          {selected ? selected.name : placeholder}
        </T>
        <Ionicons name="chevron-down" size={16} color={ink[500]} />
      </Pressable>

      <OptionSheet
        visible={open}
        title={sheetTitle}
        options={options}
        value={value}
        onChoose={(id) => onChange(id)}
        onClose={() => setOpen(false)}
        emptyText="No categories yet. Close this and add one first."
      />
    </>
  );
}


/**
 * One option out of a set the owner can pick from — a filter, a category, a
 * CSV column.
 *
 * Five screens had each grown their own copy of this chip. They were already
 * pixel-identical, so nothing here is a redesign; what differed was the parts
 * you cannot see. Some declared `accessibilityState`, some declared nothing,
 * and not one of them gave any feedback on touch. Those are exactly the
 * details that get forgotten on the sixth copy, which is the argument for
 * there being only one.
 *
 * Deliberately presentational. Toggle-to-clear, an "Any" option, single
 * versus multi select — all of that stays at the call-site, because it
 * genuinely differs per screen and a chip that owned it would need a flag for
 * each variation.
 */
export function SelectChip({
  label,
  selected,
  onPress,
  accessibilityLabel,
  disabled,
  haptic = true,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
  haptic?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => {
        // The chip fires its own selection haptic so no call-site has to
        // remember to. `haptic={false}` exists for the caller that already
        // fires one of its own and would otherwise buzz twice.
        if (haptic) haptics.tapped();
        onPress();
      }}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: selected ? brand[600] : ink[200],
          backgroundColor: selected ? brand[600] : paper.DEFAULT,
          opacity: disabled ? 0.6 : pressed ? 0.85 : 1,
        },
      ]}
    >
      <T style={{ fontSize: typeScale.caption, color: selected ? "#fff" : ink[700] }}>{label}</T>
    </Pressable>
  );
}

/**
 * A short list of mutually exclusive options, all visible at once — a period
 * switcher, a pair of tabs.
 *
 * The track behind the segments is the whole point of the form: it draws the
 * group as ONE control with a marker moving between fixed slots, rather than
 * as several separate things that happen to sit next to each other. That is
 * also why the segments carry no borders of their own — the track already
 * says where the control begins and ends, and a border on each segment would
 * say it a second time.
 *
 * React Native has no dependable "tablist"/"tab" role, so every segment is a
 * button carrying its own selected state. That is what VoiceOver and TalkBack
 * actually read out in a way that means something.
 *
 * The generic is named `Value` rather than `T` on purpose: `T` is the text
 * primitive above, and a type parameter of the same name would shadow it
 * inside this function.
 */
export function SegmentedControl<Value extends string | number>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  // readonly so a call-site can declare its options `as const` and have the
  // literal value types flow through to `onChange` — without that, `value`
  // widens to string and stops matching the state setter it feeds.
  options: readonly { label: string; value: Value; icon?: keyof typeof Ionicons.glyphMap }[];
  value: Value;
  onChange: (v: Value) => void;
  accessibilityLabel?: string;
}) {
  return (
    <View style={styles.segmentTrack} accessibilityLabel={accessibilityLabel}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => {
              haptics.tapped();
              onChange(option.value);
            }}
            style={({ pressed }) => [
              styles.segment,
              {
                backgroundColor: selected ? brand[600] : "transparent",
                opacity: pressed ? 0.85 : 1,
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
              },
            ]}
          >
            {/*
              Optional, and it stays optional. A period switcher
              ("This week" / "This month") has nothing an icon would clarify,
              whereas the three insight sections are destinations an owner
              returns to and learns the shape of. Forcing every segmented
              control to carry one would mean inventing glyphs for the
              switchers that do not want them.
            */}
            {option.icon ? (
              <Ionicons name={option.icon} size={14} color={selected ? "#fff" : ink[500]} />
            ) : null}
            <T style={{ fontSize: typeScale.label, color: selected ? "#fff" : ink[600] }}>{option.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}


/**
 * The bottom sheet both dropdowns open.
 *
 * Extracted the moment there was a second one. This app already has a test
 * (chipConsistency) that exists because eleven hand-rolled chips drifted into
 * five visual treatments, and a modal is a far bigger surface to let drift —
 * the backdrop, the swallow behaviour, the tick, the safe-area padding are
 * each a detail the second copy would get slightly wrong.
 *
 * `transparent` with the sheet at the bottom rather than a full-screen modal:
 * the row being changed stays visible above it, which is what lets someone
 * check what they are choosing FOR while they choose.
 */
export function OptionSheet<Option extends { id: number | string; name: string }>({
  visible,
  title,
  options,
  value,
  onChoose,
  onClose,
  emptyText,
}: {
  visible: boolean;
  title: string;
  options: readonly Option[];
  value: Option["id"] | null;
  onChoose: (id: Option["id"]) => void;
  onClose: () => void;
  emptyText: string;
}) {
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close without choosing"
        style={{ flex: 1, backgroundColor: "rgba(26,32,34,0.45)", justifyContent: "flex-end" }}
      >
        {/*
          The sheet swallows touches so they never reach the backdrop behind —
          without this, a tap anywhere on it would close it, and choosing the
          last option in a scrolled list would dismiss instead of select.

          A View claiming the responder, NOT a Pressable with an empty
          onPress: it is not a control, and a button role here would put a
          phantom stop between every real option for a screen reader.
        */}
        <View
          onStartShouldSetResponder={() => true}
          style={{
            backgroundColor: paper.DEFAULT,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            paddingTop: space.md,
            paddingBottom: insets.bottom + space.md,
            maxHeight: "70%",
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: space.lg,
              paddingBottom: space.sm,
            }}
          >
            <T variant="heading" accessibilityRole="header" style={{ color: brand[900] }}>
              {title}
            </T>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={10}
              style={{ padding: space.xs }}
            >
              <Ionicons name="close" size={20} color={ink[500]} />
            </Pressable>
          </View>

          <ScrollView>
            {options.map((option) => {
              const isSelected = option.id === value;
              return (
                <Pressable
                  key={String(option.id)}
                  onPress={() => {
                    haptics.tapped();
                    onChoose(option.id);
                    onClose();
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: space.sm,
                    minHeight: TAP,
                    paddingHorizontal: space.lg,
                    paddingVertical: space.sm,
                    backgroundColor: pressed ? paper[100] : isSelected ? brand[50] : paper.DEFAULT,
                  })}
                >
                  <T style={{ flex: 1, fontSize: typeScale.body, color: isSelected ? brand[900] : ink[800] }}>
                    {option.name}
                  </T>
                  {/* A tick as well as the tint — never colour alone. */}
                  {isSelected ? <Ionicons name="checkmark" size={18} color={brand[600]} /> : null}
                </Pressable>
              );
            })}
            {options.length === 0 ? (
              <T variant="caption" style={{ paddingHorizontal: space.lg, paddingVertical: space.md }}>
                {emptyText}
              </T>
            ) : null}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

/**
 * A compact dropdown, shaped as a pill.
 *
 * Distinct from CategorySelect on purpose. That one is a form FIELD — full
 * width, sitting under a label, holding an answer the owner must give. This
 * is a VIEW control: it changes what the screen shows, sits inline above the
 * content it governs, and always has a value. A period switcher rendered as a
 * full-width field would look like something waiting to be filled in.
 */
export function DropdownPill<Value extends string | number>({
  options,
  value,
  onChange,
  icon,
  sheetTitle,
  accessibilityLabel,
}: {
  options: readonly { label: string; value: Value }[];
  value: Value;
  onChange: (v: Value) => void;
  icon?: keyof typeof Ionicons.glyphMap;
  sheetTitle: string;
  accessibilityLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <>
      <Pressable
        onPress={() => {
          haptics.tapped();
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${accessibilityLabel ?? sheetTitle}: ${current?.label ?? ""}`}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => ({
          alignSelf: "flex-start",
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          minHeight: TAP - 6,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          borderRadius: radius.full,
          borderWidth: 1,
          borderColor: ink[200],
          backgroundColor: paper.DEFAULT,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        {icon ? <Ionicons name={icon} size={15} color={ink[600]} /> : null}
        <T style={{ fontSize: 13.5, color: ink[800], fontFamily: font.sansMedium }}>{current?.label}</T>
        <Ionicons name="chevron-down" size={15} color={ink[500]} />
      </Pressable>

      <OptionSheet
        visible={open}
        title={sheetTitle}
        options={options.map((o) => ({ id: o.value, name: o.label }))}
        value={value}
        onChoose={(id) => onChange(id as Value)}
        onClose={() => setOpen(false)}
        emptyText="Nothing to choose from."
      />
    </>
  );
}


/**
 * A yes/no question about something that cannot be undone with one tap.
 *
 * A SHEET RATHER THAN `Alert.alert`. The system dialog is the right tool when
 * the answer is genuinely binary and the app has nothing to add — but it
 * cannot be styled, so it arrives as a piece of Android in the middle of an
 * app that has been careful about every other surface, and its buttons read
 * in the system's words rather than in the app's. This says what will happen
 * in FinSight's own voice and puts the destructive answer where the eye
 * already goes.
 *
 * Cancel sits on the LEFT and is the plain one; the destructive action is on
 * the right and filled. That is the wrong way round for iOS convention and
 * the right way round for the phones this app is for, which are Android
 * almost without exception.
 */
export function ConfirmSheet({
  visible,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  confirmVariant = "brand",
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /**
   * How the confirm button is painted. Named for what it IS rather than for
   * what the action means, because the two do not line up: signing out is the
   * most destructive thing on the More screen and still wants FinSight's
   * green, not a red that would imply data is about to be lost.
   */
  confirmVariant?: "brand" | "primary" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel="Dismiss without doing anything"
        style={{ flex: 1, backgroundColor: "rgba(26,32,34,0.45)", justifyContent: "flex-end" }}
      >
        {/*
          Swallows touches so a tap on the sheet cannot reach the backdrop.
          A View claiming the responder, not a Pressable — it is not a control,
          and a button role here would put a phantom stop between the two that
          are.
        */}
        <View
          onStartShouldSetResponder={() => true}
          style={{
            backgroundColor: paper.DEFAULT,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            paddingTop: space.md,
            paddingHorizontal: space.lg,
            paddingBottom: insets.bottom + space.lg,
          }}
        >
          {/* The grabber. Says "this came from the bottom and goes back there". */}
          <View
            style={{
              alignSelf: "center",
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: ink[200],
              marginBottom: space.lg,
            }}
          />

          <T variant="title" accessibilityRole="header" style={{ textAlign: "center" }}>
            {title}
          </T>
          {body ? (
            <T style={{ fontSize: typeScale.bodySm, color: ink[600], textAlign: "center", marginTop: 6, lineHeight: 20 }}>
              {body}
            </T>
          ) : null}

          <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.lg }}>
            <View style={{ flex: 1 }}>
              <Button title={cancelLabel} variant="secondary" onPress={onCancel} />
            </View>
            <View style={{ flex: 1 }}>
              <Button title={confirmLabel} variant={confirmVariant} onPress={onConfirm} />
            </View>
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

// ---------------------------------------------------------------- Card

export function Card({
  children,
  style,
  emphasis = false,
}: {
  children: ReactNode;
  style?: ViewStyle;
  emphasis?: boolean;
}) {
  return (
    <View
      style={[
        styles.card,
        emphasis && { backgroundColor: brand[50], borderColor: brand[200] },
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ---------------------------------------------------------------- StatTile

export function StatTile({
  label,
  value,
  sublabel,
  emphasis = false,
}: {
  label: string;
  value: number;
  sublabel?: string;
  emphasis?: boolean;
}) {
  return (
    <Card emphasis={emphasis} style={{ flex: 1, minWidth: 150 }}>
      <T variant="label" style={{ textTransform: "uppercase", letterSpacing: 0.4, color: emphasis ? brand[700] : ink[500] }}>
        {label}
      </T>
      <Money value={value} size={22} weight="semibold" color={emphasis ? brand[900] : ink[900]} style={{ marginTop: 4 }} />
      {sublabel ? <T variant="caption" style={{ marginTop: 2 }}>{sublabel}</T> : null}
    </Card>
  );
}

// ---------------------------------------------------------------- Alert family

const ALERT_SPEC: Record<AlertKind, { label: string; glyph: string; ink: string; surface: string }> = {
  "needs-review": { label: "Needs review", glyph: "!", ink: statusText.critical, surface: "#fef2f2" },
  "large-expense": { label: "Large expense", glyph: "▲", ink: statusText.serious, surface: "#fff7ed" },
  duplicate: { label: "Possible duplicate", glyph: "⧉", ink: statusText.warning, surface: "#fffbeb" },
  info: { label: "For your information", glyph: "i", ink: brand[700], surface: brand[50] },
};

/**
 * Same visual grammar as web: severity bar, circled glyph, label, then detail.
 * Severity is never colour-alone — every variant carries its own glyph and a
 * written label.
 */
export function Alert({
  kind,
  label,
  children,
  meta,
}: {
  kind: AlertKind;
  label?: string;
  children: ReactNode;
  meta?: string;
}) {
  const spec = ALERT_SPEC[kind];
  return (
    <View style={[styles.alert, { backgroundColor: spec.surface }]}>
      <View style={{ width: 4, backgroundColor: spec.ink }} />
      <View style={styles.alertBody}>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={[styles.glyph, { backgroundColor: spec.ink }]}>
            <Text style={{ color: "#fff", fontSize: typeScale.micro, fontFamily: font.sansSemibold }}>{spec.glyph}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <T variant="label" style={{ color: spec.ink, textTransform: "uppercase", letterSpacing: 0.3 }}>
              {label ?? spec.label}
            </T>
            <T style={{ fontSize: typeScale.bodySm, marginTop: 2 }}>{children}</T>
            {meta ? <T variant="caption" style={{ marginTop: 2 }}>{meta}</T> : null}
          </View>
        </View>
      </View>
    </View>
  );
}

export function AlertBadge({ kind, label }: { kind: AlertKind; label?: string }) {
  const spec = ALERT_SPEC[kind];
  return (
    <View style={[styles.badge, { backgroundColor: spec.ink }]}>
      <Text style={{ color: "#fff", fontSize: typeScale.micro, fontFamily: font.sansMedium }}>
        {spec.glyph} {label ?? spec.label}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------- Empty state

export function EmptyState({
  title,
  body,
  action,
  icon = "＋",
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <Card style={{ alignItems: "center", paddingVertical: space.xxl }}>
      <View style={styles.emptyIcon}>
        <Text style={{ fontSize: 20, color: brand[600] }}>{icon}</Text>
      </View>
      {/*
        A header even though nothing follows it. When a list comes back empty
        this line is the only thing naming the region, so a reader moving by
        heading still lands somewhere that says where they are rather than
        skipping the screen entirely.
      */}
      <T
        accessibilityRole="header"
        variant="heading"
        style={{ marginTop: space.md, textAlign: "center", color: ink[900] }}
      >
        {title}
      </T>
      {body ? (
        <T style={{ marginTop: space.sm, textAlign: "center", color: ink[500], fontSize: typeScale.bodySm }}>{body}</T>
      ) : null}
      {action ? <View style={{ marginTop: space.lg, alignSelf: "stretch" }}>{action}</View> : null}
    </Card>
  );
}

/** Goal-Gradient: how close a brand-new business is to its first insight. */
export function SetupProgress({ steps }: { steps: { label: string; done: boolean }[] }) {
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  return (
    <View style={styles.progress}>
      <T variant="label" style={{ color: brand[900], fontFamily: font.sansSemibold, fontSize: typeScale.bodySm }}>
        {done} of {steps.length} steps to your first insight
      </T>
      <View style={{ flexDirection: "row", gap: 6, marginTop: space.sm }}>
        {steps.map((s, i) => (
          <View
            key={s.label}
            style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: i < done ? brand[500] : brand[200] }}
          />
        ))}
      </View>
      <View style={{ marginTop: space.md, gap: 6 }}>
        {steps.map((s) => (
          <T key={s.label} style={{ fontSize: typeScale.label, color: s.done ? ink[400] : ink[700] }}>
            {s.done ? "✓ " : "○ "}
            {s.label}
          </T>
        ))}
      </View>
    </View>
  );
}

/**
 * A short standing note attached to a form or panel — web's `Callout`.
 *
 * Distinct from `Alert`, which reports something that HAPPENED to a record
 * (a duplicate, a large expense) and carries a severity bar. A callout
 * explains the screen the owner is currently on.
 *
 * The warn tone deliberately uses `statusText.warning` rather than the amber
 * `accent` ramp: tokens.ts reserves accent for the recovery meter and primary
 * CTAs, and states that amber-as-warning is a different idea living in
 * `status`. Same rule as web.
 */
const CALLOUT_TONES = {
  info: { surface: brand[50], ink: brand[700], glyph: "ⓘ" },
  warn: { surface: "#fffbeb", ink: statusText.warning, glyph: "⚠" },
} as const;

export function Callout({
  tone = "info",
  children,
}: {
  tone?: keyof typeof CALLOUT_TONES;
  children: ReactNode;
}) {
  const spec = CALLOUT_TONES[tone];
  return (
    <View
      style={{
        flexDirection: "row",
        gap: space.sm,
        backgroundColor: spec.surface,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: spec.ink + "33",
        padding: space.md,
      }}
    >
      <Text style={{ color: spec.ink, fontSize: typeScale.label, fontFamily: font.sansSemibold }}>{spec.glyph}</Text>
      <T style={{ flex: 1, fontSize: typeScale.label, lineHeight: 19, color: spec.ink }}>{children}</T>
    </View>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <View style={styles.errorNote}>
      <T style={{ color: "#991b1b", fontSize: typeScale.bodySm }}>{children}</T>
    </View>
  );
}

/**
 * A screen's background and its safe area.
 *
 * `safeTop` is off by default because most screens sit under a navigation
 * header, which already clears the status bar — adding the inset there would
 * push everything down twice. A screen with `headerShown: false` has nothing
 * above it and must ask for the inset, or its first line renders underneath
 * the clock and the battery.
 */
export function Screen({
  children,
  style,
  safeTop = false,
}: {
  children: ReactNode;
  style?: ViewStyle;
  safeTop?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        { flex: 1, backgroundColor: paper[50] },
        safeTop && { paddingTop: insets.top },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * The top of a screen: an optional eyebrow, a title, an optional line of
 * context, and room for one action.
 *
 * Every screen was building its own out of a `T variant="title"` and ad-hoc
 * margins, so no two had the same spacing above the first card. Sharing one
 * component is most of what makes a set of screens feel like one app rather
 * than several.
 *
 * The title carries the header role, which is what VoiceOver's rotor and
 * TalkBack's heading gesture navigate by. Declaring it once here is the reason
 * nearly every screen gets it without its author having to know about it — and
 * only the title does, because the eyebrow and the subtitle describe the title
 * rather than standing on their own, and a jump list is only useful while it
 * stays short.
 */
export function ScreenHeader({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md, marginBottom: space.lg }}>
      <View style={{ flex: 1 }}>
        {eyebrow ? (
          <T variant="label" style={{ textTransform: "uppercase", letterSpacing: 0.6, color: ink[400] }}>
            {eyebrow}
          </T>
        ) : null}
        <T accessibilityRole="header" variant="title" numberOfLines={2}>
          {title}
        </T>
        {subtitle ? (
          <T variant="caption" style={{ marginTop: 2 }}>
            {subtitle}
          </T>
        ) : null}
      </View>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: TAP,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: space.sm,
  },
  chip: {
    minHeight: TAP - 10,
    paddingHorizontal: space.md,
    borderRadius: radius.full,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentTrack: {
    flexDirection: "row",
    backgroundColor: paper[100],
    borderRadius: radius.md,
    padding: 3,
  },
  segment: {
    flex: 1,
    minHeight: TAP - 8,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  /*
   * A card is a sheet of paper, not a coloured box.
   *
   * The border used to be brand[100], which tinted every surface in the app
   * faintly green and read as decoration applied to everything equally. A
   * neutral hairline plus a very soft shadow does the actual job — separating
   * the sheet from the background — and lets colour mean something when it
   * does appear.
   *
   * Both shadow systems are set because they are not interchangeable: iOS
   * reads shadowColor/Offset/Opacity/Radius, Android reads elevation only.
   * Giving one and not the other is how a card ends up flat on half the
   * devices it ships to.
   */
  card: {
    backgroundColor: paper.DEFAULT,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: paper[200],
    padding: space.lg,
    shadowColor: ink[900],
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  alert: { flexDirection: "row", borderRadius: radius.md, overflow: "hidden" },
  alertBody: { flex: 1, padding: space.md },
  glyph: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  badge: {
    alignSelf: "flex-start",
    borderRadius: radius.full,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  emptyIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: brand[50],
    alignItems: "center",
    justifyContent: "center",
  },
  progress: {
    backgroundColor: brand[50],
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: brand[100],
    padding: space.lg,
    marginBottom: space.lg,
  },
  errorNote: {
    backgroundColor: "#fef2f2",
    borderColor: "#fecaca",
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
  },
});
