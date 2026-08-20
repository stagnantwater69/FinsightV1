import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { SelectChip, T } from "./ui";
import * as haptics from "../lib/haptics";
import { brand, ink, paper, radius, space, TAP, typeScale } from "../theme/tokens";

/**
 * Picking a date, instead of typing one.
 *
 * Every date on this app used to be a TextInput expecting "YYYY-MM-DD",
 * hand-typed on a phone keypad. That is the worst interaction in the app: it
 * is slow, it is easy to get wrong, and a wrong date is not a typo the owner
 * notices — it silently files an expense in the wrong week and quietly moves
 * a figure on every screen that reads it.
 *
 * The value stays an ISO "YYYY-MM-DD" string end to end, because that is what
 * the API takes and what every caller here already stores. Only the way it is
 * ENTERED changes.
 */

/** ISO date <-> Date, in LOCAL time. */
function parseISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  /*
   * Constructed from parts rather than `new Date("2026-08-01")`, which the
   * spec parses as UTC MIDNIGHT. Anywhere behind UTC that renders as the
   * previous day, so a receipt dated the 1st would show as the 31st — the
   * exact silent off-by-one this component exists to stop.
   */
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d);
}

function toISO(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** How the date reads to a person, once it is chosen. */
function humanise(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "Choose a date";
  const date = parseISO(iso);
  const today = new Date();
  const isSameDay = (a: Date, b: Date) => toISO(a) === toISO(b);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (isSameDay(date, today)) return "Today";
  if (isSameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString("en-PH", { day: "numeric", month: "short", year: "numeric" });
}

export function DateField({
  label,
  value,
  onChange,
  optional = false,
  onClear,
  allowFuture = false,
}: {
  label: string;
  /** ISO "YYYY-MM-DD", or "" when not set. */
  value: string;
  onChange: (iso: string) => void;
  optional?: boolean;
  /** Shown only when provided and a value is set — for filters, not forms. */
  onClear?: () => void;
  /**
   * Lets the picker reach past today.
   *
   * OFF BY DEFAULT, and it must stay that way: every other date in this app is
   * evidence of something that already happened — an expense, a sale, a filter
   * over those — and a receipt dated next Tuesday is a typo, not a plan.
   *
   * The one date that is genuinely forward-looking is a recurring payment's
   * next due date, which is unsettable without this: the cap silently refused
   * every date the field exists to hold.
   */
  allowFuture?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasValue = /^\d{4}-\d{2}-\d{2}$/.test(value);

  return (
    <View style={{ marginBottom: space.md }}>
      <T variant="label" style={{ marginBottom: 4, color: ink[700] }}>
        {label}
        {optional ? <T variant="caption"> · optional</T> : null}
      </T>

      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Pressable
          onPress={() => {
            haptics.tapped();
            setOpen(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={`${label}. ${hasValue ? humanise(value) : "No date chosen"}. Opens a date picker.`}
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            minHeight: TAP,
            paddingHorizontal: space.md,
            borderWidth: 1,
            borderColor: ink[200],
            borderRadius: radius.md,
            backgroundColor: paper.DEFAULT,
          }}
        >
          <Ionicons name="calendar-outline" size={18} color={ink[500]} />
          <T style={{ flex: 1, fontSize: typeScale.body, color: hasValue ? ink[900] : ink[400] }}>
            {hasValue ? humanise(value) : "Choose a date"}
          </T>
        </Pressable>

        {onClear && hasValue ? (
          <Pressable
            onPress={() => {
              haptics.tapped();
              onClear();
            }}
            accessibilityRole="button"
            accessibilityLabel={`Clear ${label}`}
            style={{ minHeight: TAP, minWidth: TAP - 8, alignItems: "center", justifyContent: "center" }}
          >
            <Ionicons name="close-circle" size={20} color={ink[300]} />
          </Pressable>
        ) : null}
      </View>

      {open ? (
        <DateTimePicker
          value={hasValue ? parseISO(value) : new Date()}
          mode="date"
          // Spinner on iOS reads better inside a form than the compact chip;
          // Android ignores this and shows its own dialog either way.
          display={Platform.OS === "ios" ? "spinner" : "default"}
          maximumDate={allowFuture ? undefined : new Date()}
          onChange={(event, picked) => {
            /*
             * Android fires this once for the whole dialog and reports
             * "dismissed" on cancel; iOS fires on every spin with the picker
             * still open. Closing on Android only is what keeps the iOS
             * spinner usable while still dismissing the Android dialog.
             */
            if (Platform.OS === "android") setOpen(false);
            if (event.type === "dismissed" || !picked) return;
            onChange(toISO(picked));
          }}
        />
      ) : null}

      {/* iOS keeps the spinner inline, so it needs a way to put it away. */}
      {open && Platform.OS === "ios" ? (
        <Pressable
          onPress={() => setOpen(false)}
          accessibilityRole="button"
          style={{ alignSelf: "flex-end", paddingVertical: space.sm, paddingHorizontal: space.md }}
        >
          <T style={{ color: brand[700], fontSize: typeScale.bodySm }}>Done</T>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Whole-period shortcuts for filtering.
 *
 * Most filtering is "this week" or "this month", not two specific dates.
 * Offering those directly means the common case costs one tap and the picker
 * is only needed for the genuinely custom range.
 */
export function DateRangeChips({
  onPick,
  activeLabel,
}: {
  onPick: (from: string, to: string, label: string) => void;
  activeLabel: string | null;
}) {
  const today = new Date();
  const iso = (d: Date) => toISO(d);
  const daysAgo = (n: number) => {
    const d = new Date(today);
    d.setDate(today.getDate() - n);
    return d;
  };
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const presets: { label: string; from: Date; to: Date }[] = [
    { label: "Today", from: today, to: today },
    { label: "Last 7 days", from: daysAgo(6), to: today },
    { label: "Last 30 days", from: daysAgo(29), to: today },
    { label: "This month", from: startOfMonth, to: today },
  ];

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
      {presets.map((p) => (
        <SelectChip
          key={p.label}
          label={p.label}
          // The active range is identified by its label, not by its dates: the
          // presets are recomputed from today's date on every render, so two
          // Date objects for "Last 7 days" are never the same instance.
          selected={activeLabel === p.label}
          onPress={() => onPick(iso(p.from), iso(p.to), p.label)}
        />
      ))}
    </View>
  );
}
