import { useEffect, useRef, useState } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { ErrorNote, Money, T } from "./ui";
import { TAP_FLOOR } from "./touchTarget";
import * as haptics from "../lib/haptics";
import { api, errorMessage } from "../lib/api";
import { compactAmount, formatMoney } from "../lib/money";
import { currentMonthKey } from "../lib/recoveryPlanForm";
import { useImportOperation } from "../lib/useImportOperation";
import { useTheme } from "../context/ThemeContext";
import { font, radius, space, typeScale } from "../theme/tokens";
import { shadowStyle } from "../theme/shadow";
import type { RecoveryPlan, RecoveryScenario } from "../lib/types";

/*
 * The inline "what if my expenses change?" check.
 *
 * Read-only by design: POST /insights/recovery-scenario never writes, and the
 * only write here is the owner pressing "Save as my plan", which stores a
 * reference note (RecoveryPlan) and never the business profile.
 *
 * Why a slider when Spending Impact chose presets: that screen's amounts run
 * across six figures in ₱500 steps, too fine for a thumb. This one moves in
 * 5% steps of the owner's own basis (21 positions), which a thumb can hit, and
 * it is an `adjustable` control so a screen reader steps it with swipes.
 */

const MIN_PCT = 50;
const MAX_PCT = 150;
const STEP_PCT = 5;
const PRESETS = [
  { label: "−10%", pct: 90 },
  { label: "−20%", pct: 80 },
  { label: "+10%", pct: 110 },
] as const;

function clampPct(pct: number): number {
  return Math.max(MIN_PCT, Math.min(MAX_PCT, Math.round(pct / STEP_PCT) * STEP_PCT));
}

export function RecoveryWhatIfCard({
  businessProfileId,
  basis,
  plan,
  onTypeAmount,
  onPlanSaved,
}: {
  businessProfileId: number;
  /** The real monthly expense basis. Never changed by anything on this card. */
  basis: number;
  plan: RecoveryPlan | null;
  /** Opens the full scenario sheet for a typed amount. */
  onTypeAmount: () => void;
  onPlanSaved: (plan: RecoveryPlan) => void;
}) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const stacked = width < 390 || fontScale > 1.2;
  const [pct, setPct] = useState(100);
  const [result, setResult] = useState<RecoveryScenario | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const seq = useRef(0);
  const request = useRef<AbortController | null>(null);
  const operation = useImportOperation(businessProfileId);
  const track = useRef<View>(null);
  const trackLeft = useRef(0);
  const [trackWidth, setTrackWidth] = useState(0);
  const amount = Math.round((basis * pct) / 100);

  // A refreshed basis (or another business) makes an old result wrong.
  useEffect(() => {
    seq.current += 1;
    request.current?.abort();
    operation.cancel();
    setPct(100);
    setResult(null);
    setError(null);
    setSaved(false);
    setRunning(false);
    setSaving(false);
    return () => {
      seq.current += 1;
      request.current?.abort();
      operation.cancel();
    };
  }, [basis, businessProfileId, operation]);

  async function run(nextPct: number) {
    const value = Math.round((basis * nextPct) / 100);
    const mySeq = (seq.current += 1);
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSaved(false);
    setError(null);
    setResult(null);
    if (nextPct === 100) {
      setResult(null);
      setRunning(false);
      return;
    }
    setRunning(true);
    try {
      const response = await api.post<RecoveryScenario>("/insights/recovery-scenario", {
        businessProfileId,
        assumedExpectedMonthlyExpenses: value,
      }, { signal: controller.signal });
      if (seq.current !== mySeq) return;
      if (response.assumedExpectedMonthlyExpenses !== value) {
        throw new Error("The estimate doesn't match this amount. Try checking it again.");
      }
      setResult(response);
    } catch (err) {
      if (seq.current !== mySeq) return;
      setResult(null);
      setError(errorMessage(err));
    } finally {
      if (seq.current === mySeq) setRunning(false);
    }
  }

  function choose(nextPct: number) {
    if (saving) return;
    const clamped = clampPct(nextPct);
    if (clamped === pct && result?.assumedExpectedMonthlyExpenses === amount) return;
    haptics.tapped();
    setPct(clamped);
    void run(clamped);
  }

  function pctAt(pageX: number): number {
    if (trackWidth <= 0) return pct;
    const ratio = Math.max(0, Math.min(1, (pageX - trackLeft.current) / trackWidth));
    return clampPct(MIN_PCT + ratio * (MAX_PCT - MIN_PCT));
  }

  async function saveAsPlan() {
    if (!result || running || result.assumedExpectedMonthlyExpenses !== amount) return;
    const task = operation.begin();
    if (!task) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.put<RecoveryPlan>(
        `/business-profiles/${businessProfileId}/recovery-plans/${currentMonthKey()}`,
        {
          ownerTargetAmount: result.assumedExpectedMonthlyExpenses,
          // Keep the owner's own deadline and buffer if a plan already has them.
          deadline: plan?.deadline ?? null,
          bufferPercent: plan?.bufferPercent ?? null,
        }, { signal: task.controller.signal },
      );
      if (!operation.current(task)) return;
      onPlanSaved(updated);
      setSaved(true);
      haptics.succeeded();
    } catch (err) {
      if (operation.current(task)) setError(errorMessage(err));
    } finally {
      if (operation.current(task)) setSaving(false);
      operation.finish(task);
    }
  }

  const thumbRatio = (pct - MIN_PCT) / (MAX_PCT - MIN_PCT);
  const resultMatchesAmount = result?.assumedExpectedMonthlyExpenses === amount;
  const current = resultMatchesAmount ? result?.current.adjustedDailyTarget ?? null : null;
  const hypothetical = resultMatchesAmount ? result?.hypothetical.adjustedDailyTarget ?? null : null;
  const delta = current !== null && hypothetical !== null ? hypothetical - current : null;

  return (
    <View
      style={{
        borderRadius: 24,
        borderWidth: 1.5,
        borderStyle: "dashed",
        borderColor: t.accent[300],
        backgroundColor: t.surface,
        padding: space.lg,
      }}
    >
      <View style={{ flexDirection: stacked ? "column" : "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm }}>
        <T variant="title" accessibilityRole="header" style={{ flex: 1, color: t.textPrimary }}>
          What if expenses change?
        </T>
        <View style={{ borderRadius: radius.full, backgroundColor: t.ACCENT.surface, paddingHorizontal: space.sm, paddingVertical: 3 }}>
          <T style={{ fontSize: typeScale.micro, fontFamily: font.sansSemibold, color: t.ACCENT.text }}>Try it · not saved</T>
        </View>
      </View>

      {/* Slider: 50% to 150% of the real basis, in 5% steps. */}
      <View
        ref={track}
        onLayout={(e) => {
          setTrackWidth(e.nativeEvent.layout.width);
          track.current?.measureInWindow((x) => (trackLeft.current = x));
        }}
        accessible
        accessibilityRole="adjustable"
        accessibilityState={{ disabled: saving }}
        accessibilityLabel="Monthly expenses to try"
        accessibilityValue={{ text: `${formatMoney(amount)}, ${pct}% of your current ${formatMoney(basis)}` }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => choose(pct + (e.nativeEvent.actionName === "increment" ? STEP_PCT : -STEP_PCT))}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(e) => {
          if (saving) return;
          const { pageX } = e.nativeEvent;
          track.current?.measureInWindow((x) => {
            trackLeft.current = x;
            setPct(pctAt(pageX));
          });
        }}
        onResponderMove={(e) => { if (!saving) setPct(pctAt(e.nativeEvent.pageX)); }}
        onResponderRelease={(e) => choose(pctAt(e.nativeEvent.pageX))}
        style={{ height: TAP_FLOOR + 12, justifyContent: "center", marginTop: space.lg }}
      >
        <View style={{ height: 8, borderRadius: 4, backgroundColor: t.surfaceStrong }}>
          <View style={{ width: `${thumbRatio * 100}%`, height: "100%", borderRadius: 4, backgroundColor: t.brandFill }} />
        </View>
        {/* Where the real basis sits. */}
        <View style={{ position: "absolute", left: "50%", top: 0, alignItems: "center", transform: [{ translateX: -24 }], width: 48 }}>
          <T style={{ fontSize: typeScale.micro, color: t.textMuted }}>now</T>
          <View style={{ width: 2, height: 16, backgroundColor: t.borderStrong, marginTop: 2 }} />
        </View>
        <View
          style={{
            position: "absolute",
            left: `${thumbRatio * 100}%`,
            width: 28,
            height: 28,
            marginLeft: -14,
            borderRadius: 14,
            backgroundColor: t.textOnFill,
            borderWidth: 3,
            borderColor: t.brandFill,
            ...shadowStyle({ color: t.shadow, offsetY: 2, opacity: 0.2 * t.shadowStrength, blurRadius: 4, elevation: 3 }),
          }}
        />
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <T style={{ fontFamily: font.mono, fontSize: typeScale.micro, color: t.textMuted }}>{compactAmount(basis * 0.5)}</T>
        <T style={{ fontFamily: font.mono, fontSize: typeScale.micro, color: t.textMuted }}>{compactAmount(basis * 1.5)}</T>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.md }}>
        {PRESETS.map((preset) => {
          const on = pct === preset.pct;
          return (
            <Pressable
              key={preset.label}
              accessibilityRole="button"
              accessibilityState={{ selected: on, disabled: saving }}
              accessibilityLabel={`Try ${preset.label} of your monthly expense basis`}
              onPress={() => choose(preset.pct)}
              disabled={saving}
              style={({ pressed }) => ({
                minHeight: TAP_FLOOR,
                minWidth: 60,
                paddingHorizontal: space.md,
                borderRadius: radius.full,
                borderWidth: 1,
                borderColor: on ? t.brand[300] : t.borderStrong,
                backgroundColor: on ? t.brandSurface : pressed ? t.surfaceMuted : t.surface,
                alignItems: "center",
                justifyContent: "center",
              })}
            >
              <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.label, color: on ? t.brandText : t.textPrimary }}>
                {preset.label}
              </T>
            </Pressable>
          );
        })}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Type amount"
          accessibilityState={{ disabled: saving }}
          disabled={saving}
          onPress={onTypeAmount}
          style={({ pressed }) => ({
            minHeight: TAP_FLOOR,
            paddingHorizontal: space.md,
            borderRadius: radius.full,
            borderWidth: 1,
            borderColor: t.borderStrong,
            backgroundColor: pressed ? t.surfaceMuted : t.surface,
            alignItems: "center",
            justifyContent: "center",
          })}
        >
          <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.label, color: t.textPrimary }}>Type amount</T>
        </Pressable>
      </View>

      {/* Expenses → per day. The left box is the owner's assumption; the right one is the server's answer. */}
      <View style={{ flexDirection: stacked ? "column" : "row", alignItems: "stretch", gap: space.sm, marginTop: space.md }}>
        <View style={{ flex: 1, borderRadius: radius.lg, backgroundColor: t.surfaceSunken, padding: space.md }}>
          <T variant="caption">Expenses</T>
          <Money value={amount} size={typeScale.bodyLg} weight="semibold" style={{ marginTop: 2 }} />
        </View>
        <Ionicons name={stacked ? "arrow-down" : "arrow-forward"} size={18} color={t.textFaint} style={{ alignSelf: "center" }} />
        <View
          accessibilityLiveRegion="polite"
          style={{
            flex: 1,
            borderRadius: radius.lg,
            padding: space.md,
            backgroundColor: result ? t.brandSurface : t.surfaceSunken,
            borderWidth: result ? 1.5 : 0,
            borderColor: t.brandBorder,
          }}
        >
          <T variant="caption">Per day</T>
          {running ? (
            <T style={{ fontSize: typeScale.bodySm, color: t.textMuted, marginTop: 2 }}>Checking…</T>
          ) : hypothetical !== null ? (
            <>
              <Money value={hypothetical} size={typeScale.bodyLg} weight="semibold" color={t.brandText} style={{ marginTop: 2 }} />
              {delta !== null && Math.abs(delta) >= 0.5 ? (
                <T style={{ fontFamily: font.monoMedium, fontSize: typeScale.micro, color: t.brandText }}>
                  {`${delta < 0 ? "▼" : "▲"} ${formatMoney(Math.abs(delta))} ${delta < 0 ? "less" : "more"}`}
                </T>
              ) : null}
            </>
          ) : result ? (
            <T style={{ fontSize: typeScale.bodySm, color: t.textMuted, marginTop: 2 }}>No open days left</T>
          ) : (
            <T style={{ fontSize: typeScale.bodySm, color: t.textMuted, marginTop: 2 }}>Move the slider</T>
          )}
        </View>
      </View>

      {error ? <View style={{ marginTop: space.md }}><ErrorNote>{error}</ErrorNote></View> : null}

      {result ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save as my plan"
          accessibilityState={{ disabled: saving || running || !resultMatchesAmount, busy: saving }}
          disabled={saving || running || !resultMatchesAmount}
          onPress={() => void saveAsPlan()}
          style={({ pressed }) => ({
            minHeight: TAP_FLOOR,
            marginTop: space.md,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: t.borderStrong,
            backgroundColor: pressed ? t.surfaceMuted : t.surface,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: space.sm,
            opacity: saving ? 0.6 : 1,
          })}
        >
          <Ionicons name="bookmark-outline" size={16} color={t.textPrimary} />
          <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: t.textPrimary }}>
            {saving ? "Saving…" : "Save as my plan"}
          </T>
        </Pressable>
      ) : null}
      {saved ? (
        <T variant="caption" accessibilityLiveRegion="polite" style={{ marginTop: space.sm, color: t.statusText.good, textAlign: "center" }}>
          Saved. Your real target and sales stay the same.
        </T>
      ) : null}
    </View>
  );
}
