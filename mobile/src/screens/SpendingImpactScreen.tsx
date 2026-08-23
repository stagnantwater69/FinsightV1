import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Alert as AlertBanner, Callout, Card, ErrorNote, Money, Screen, T } from "../components/ui";
import { AskFinSight } from "../components/AskFinSight";
import { AskFinSightFab, FAB_CLEARANCE } from "../components/AskFinSightFab";
import { InsightHeader } from "../components/InsightsShared";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api, errorMessage } from "../lib/api";
import { TAP, font, radius, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import type { SpendingImpact } from "../lib/types";

// ---------------------------------------------------------------- Spending impact

export function SpendingImpactScreen({ navigation }: any) {
  const t = useTheme();
  const { ACCENT, brand, ink, paper, statusText } = t;
  const { selected } = useBusinessProfiles();
  const [amount, setAmount] = useState("");
  const [data, setData] = useState<SpendingImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  // This input is drawn by hand rather than through `Field` — it shares a row
  // with the Check button, which `Field`'s own label-above-input layout cannot
  // express. It gets `Field`'s focus border anyway so the app has one focus
  // treatment, not two.
  const [amountFocused, setAmountFocused] = useState(false);

  async function run() {
    const value = Number(amount);
    if (!selected || !Number.isFinite(value) || value <= 0) {
      setData(null);
      return;
    }
    try {
      setData(await api.get<SpendingImpact>("/insights/spending-impact", {
        businessProfileId: selected.id,
        plannedAmount: value,
        periodDays: 30,
      }));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!selected) return null;

  const bandColor = data
    ? data.impactBand === "High Impact"
      ? statusText.critical
      : data.impactBand === "Noticeable Impact"
        ? statusText.warning
        : statusText.good
    : ink[400];
  /*
    The band as a tinted pill rather than a solid fill. Solid critical red on
    a white card reads as an error the owner has made; "High Impact" is a
    description of size, and the purchase may still be the right call. The
    text keeps the full-strength colour, so contrast is unchanged.
  */
  const bandSurface = data
    ? data.impactBand === "High Impact"
      ? t.statusSurface.critical
      : data.impactBand === "Noticeable Impact"
        ? t.statusSurface.warning
        : t.statusSurface.good
    : paper[100];

  return (
    <Screen safeTop>
      <ScrollView
        // The FAB floats over this list, so the scroll has to end far enough
        // up that it can never cover the last card.
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl + FAB_CLEARANCE }}
      >
        <InsightHeader navigation={navigation} active="SpendingImpact" title="Spending impact" />

        <View style={{ marginBottom: space.lg }}>
          <Callout tone="info">
            A what-if check — nothing is saved, and FinSight won't tell you whether to buy it.
          </Callout>
        </View>

        <Card style={{ marginBottom: space.lg }}>
          <T variant="label" style={{ marginBottom: 4 }}>Planned amount (PHP)</T>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              onSubmitEditing={run}
              onFocus={() => setAmountFocused(true)}
              onBlur={() => setAmountFocused(false)}
              keyboardType="decimal-pad"
              placeholder="e.g. 11000"
              placeholderTextColor={ink[400]}
              style={{
                flex: 1,
                minHeight: TAP,
                // Width held at 1 on both states so the row does not reflow
                // and shove the Check button sideways when focus lands.
                borderWidth: 1,
                borderColor: amountFocused ? brand[600] : ink[200],
                borderRadius: radius.md,
                paddingHorizontal: space.md,
                fontSize: typeScale.body,
                color: ink[900],
              }}
            />
            <Pressable
              onPress={run}
              accessibilityRole="button"
              // "Check" alone says nothing about what is being checked once
              // the amount field beside it is out of view, which is exactly
              // the situation of anyone reading this one control at a time.
              accessibilityLabel="Check this planned amount"
              style={{
                minHeight: TAP,
                paddingHorizontal: space.lg,
                borderRadius: radius.md,
                backgroundColor: ACCENT.fill,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <T style={{ color: ACCENT.onFill, fontFamily: font.sansSemibold }}>Check</T>
            </Pressable>
          </View>
          {error ? <View style={{ marginTop: space.md }}><ErrorNote>{error}</ErrorNote></View> : null}
        </Card>

        {data ? (
          <Card>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: space.md }}>
              <T variant="heading" accessibilityRole="header">Estimated impact</T>
              <View
                style={{
                  backgroundColor: bandSurface,
                  borderRadius: radius.full,
                  paddingHorizontal: space.md,
                  paddingVertical: 4,
                }}
              >
                <T style={{ color: bandColor, fontSize: typeScale.caption }}>{data.impactBand}</T>
              </View>
            </View>

            <BeforeAfter label="Available business funds" before={data.funds.before} after={data.funds.after} />
            <BeforeAfter
              label={`Recorded expenses (last ${data.periodDays} days)`}
              before={data.periodExpenses.before}
              after={data.periodExpenses.after}
            />

            <T variant="caption" style={{ marginTop: space.md }}>
              That uses {data.percentOfFunds >= 999999 ? "more than 100%" : `${data.percentOfFunds.toFixed(1)}%`} of your
              available funds. You treat anything above {data.thresholdPercent}% as high impact.
            </T>
            {data.exceedsFunds ? (
              <View style={{ marginTop: space.md }}>
                <AlertBanner kind="needs-review" label="Exceeds your funds">
                  This is more than the available business funds you have on record.
                </AlertBanner>
              </View>
            ) : null}
          </Card>
        ) : (
          <Card>
            {/*
              A real illustration rather than EmptyState's text glyph. This is
              the whole screen until an amount is typed, and "◎" rendered at
              whatever weight the system font happened to give it — the one
              place the app asks someone to start, drawn in a character that
              varies by device.
            */}
            <View style={{ alignItems: "center", paddingVertical: space.xxl, paddingHorizontal: space.lg }}>
              <View
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: 48,
                  backgroundColor: brand[50],
                  alignItems: "center",
                  justifyContent: "center",
                  marginBottom: space.lg,
                }}
              >
                <Ionicons name="locate-outline" size={44} color={brand[600]} />
              </View>
              <T variant="title" accessibilityRole="header" style={{ textAlign: "center" }}>
                Enter an amount to check
              </T>
              <T variant="caption" style={{ textAlign: "center", marginTop: 6, lineHeight: 18, maxWidth: 260 }}>
                See what a planned purchase would do to your funds before you spend it.
              </T>
            </View>
          </Card>
        )}
      </ScrollView>

      {/*
        Outside the ScrollView so it stays put while the page moves under it —
        the same placement and the same reasoning as Home. The question an
        owner wants to ask an insight is usually prompted by something they
        have just scrolled past, which a button pinned to the end of the page
        is the worst possible place for.
      */}
      <AskFinSightFab onPress={() => setAskOpen(true)} />

      <AskFinSight visible={askOpen} onClose={() => setAskOpen(false)} module="Spending Impact" />
    </Screen>
  );
}

/**
 * One figure before a planned purchase and after it.
 *
 * ONE BAR, NOT TWO. It was drawn as two stacked bars, one per state, which
 * made the reader compare two lengths in two places to answer a question
 * about a single quantity moving.
 *
 * WHAT THE BAR ENCODES: the solid part is the SMALLER of the two figures and
 * the tinted remainder is the change between them. That one rule reads
 * correctly in both directions without the caller having to say which way is
 * good — funds fall, so the solid part is what would be left and the
 * remainder is what the purchase eats; expenses rise, so the solid part is
 * what is already spent and the remainder is what would be added. Either
 * way, the light section is the purchase.
 *
 * The fill stays the brand colour rather than tracking the impact band. The
 * band already has a pill of its own, and colouring the "what remains"
 * section by severity would say the remaining funds were themselves alarming.
 * Only the REMAINDER turns red, and only when the purchase cannot be covered.
 */
/** Height of the before/after bar; its corner radius is derived from this. */
const BAR_HEIGHT = 10;

function BeforeAfter({
  label,
  before,
  after,
}: {
  label: string;
  before: number;
  after: number;
}) {
  const t = useTheme();
  const { brand, ink, paper, statusText } = t;
  /*
   * Overspending is the case this has to get right. A negative `after` means
   * the purchase consumed everything and more, so the solid part is what
   * existed and the whole remainder is red — there is no such thing as a
   * negative length, and clamping to zero would draw "nothing left"
   * identically to "exactly nothing left".
   */
  const overspent = after < 0;
  const span = overspent ? before + Math.abs(after) : Math.max(Math.abs(before), Math.abs(after), 1);
  const solid = overspent ? before : Math.min(Math.abs(before), Math.abs(after));
  const ratio = Math.max(0, Math.min(solid / span, 1));

  return (
    <View style={{ marginBottom: space.lg }}>
      <T variant="label" style={{ color: ink[700], marginBottom: space.sm }}>
        {label}
      </T>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", gap: space.sm }}>
        <View>
          <T variant="caption">Before</T>
          <Money value={before} size={14} weight="medium" style={{ marginTop: 1 }} />
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <T variant="caption">After</T>
          <Money
            value={after}
            size={14}
            weight="semibold"
            color={overspent ? statusText.critical : ink[900]}
            style={{ marginTop: 1 }}
          />
        </View>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }}
        style={{
          height: BAR_HEIGHT,
          // The track IS the change: soft brand normally, alarm red when the
          // purchase runs past what there is.
          backgroundColor: overspent ? t.statusSurface.critical : brand[100],
          // Radius from the height, matching RecoveryMeter's own Bar. A bar
          // is not a chip, and `radius.full` on a brand-filled pill is the
          // marker chipConsistency looks for.
          borderRadius: BAR_HEIGHT / 2,
          overflow: "hidden",
          marginTop: space.sm,
          flexDirection: "row",
        }}
      >
        <View
          style={{
            width: `${ratio * 100}%`,
            height: "100%",
            borderRadius: BAR_HEIGHT / 2,
            backgroundColor: brand[600],
          }}
        />
        {/*
          A hairline at the boundary. Where the two tints are close in value
          the join is hard to place exactly, and this is a chart whose whole
          point is where that join falls.
        */}
        {ratio > 0.02 && ratio < 0.98 ? (
          <View style={{ width: 1.5, height: "100%", backgroundColor: paper.DEFAULT, opacity: 0.9 }} />
        ) : null}
      </View>
    </View>
  );
}
