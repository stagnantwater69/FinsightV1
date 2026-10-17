import { ReactNode } from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import Ionicons from "@expo/vector-icons/Ionicons";
import { T } from "./ui";
import { Mascot, type MascotState } from "./MascotState";
import { TAP_FLOOR } from "./touchTarget";
import * as haptics from "../lib/haptics";
import { useTheme } from "../context/ThemeContext";
import { HERO } from "../theme/hero";
import { font, radius, space, typeScale } from "../theme/tokens";
import { KpiWatermark, type KpiWatermarkIcon } from "./KpiWatermark";

/*
 * The shared parts of the redesigned screens: one teal panel at the top with
 * Fin's one-line reading, cards titled with the owner's question, and the
 * small tiles and rows those cards are built from. Every screen uses these
 * rather than its own copy, so Home, Records, Insights and More stay one app.
 */

/** The fixed deep-teal panel. One per screen, at the top. */
export function TealPanel({ children, style, watermarkIcon }: { children: ReactNode; style?: ViewStyle; watermarkIcon?: KpiWatermarkIcon }) {
  return (
    <View style={[{ borderRadius: 28, overflow: "hidden", backgroundColor: HERO.mid }, style]}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100">
        <Defs>
          <RadialGradient id="tealWash" cx="85" cy="0" r="120" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={HERO.from} />
            <Stop offset="0.4" stopColor={HERO.mid} />
            <Stop offset="1" stopColor={HERO.to} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={100} height={100} fill="url(#tealWash)" />
      </Svg>
      {watermarkIcon ? <KpiWatermark name={watermarkIcon} color={HERO.ink} opacity={0.065} borderRadius={style?.borderRadius ?? 28} /> : null}
      <View style={{ padding: space.lg, gap: space.md, zIndex: 1 }}>{children}</View>
    </View>
  );
}

export type BubblePart = { text: string; tone?: "bad" | "good" | "accent" };

/** Fin beside a white speech bubble. The message is built from figures the screen already has. */
export function CoachBubble({ mascot, parts, size = 72 }: { mascot: MascotState; parts: BubblePart[]; size?: number }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.xs }}>
      <Mascot state={mascot} size={size} style={{ alignSelf: "flex-end" }} />
      <View
        style={{
          flex: 1,
          backgroundColor: HERO.bubble,
          borderRadius: 18,
          borderBottomLeftRadius: 6,
          paddingVertical: space.sm + 2,
          paddingHorizontal: space.md,
          marginBottom: space.sm,
        }}
      >
        <T style={{ color: HERO.bubbleInk, fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, lineHeight: 20 }}>
          {parts.map((part, i) => (
            <T
              key={i}
              style={{
                color:
                  part.tone === "bad"
                    ? t.statusSolid.critical
                    : part.tone === "good"
                      ? t.statusSolid.good
                      : part.tone === "accent"
                        ? HERO.bubbleAccent
                        : HERO.bubbleInk,
                fontSize: typeScale.bodySm,
                fontFamily: font.sansSemibold,
              }}
            >
              {part.text}
            </T>
          ))}
        </T>
      </View>
    </View>
  );
}

/** A small chip on the teal panel: a coloured dot and a status word. */
export function PanelStatus({ tone, glyph, copy }: { tone: "good" | "warning" | "critical"; glyph: string; copy: string }) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: 6,
        paddingVertical: 4,
        paddingLeft: 4,
        paddingRight: space.sm + 2,
        borderRadius: radius.full,
        backgroundColor: HERO.wash,
        borderWidth: 1,
        borderColor: HERO.hairline,
      }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          backgroundColor: t.statusSolid[tone],
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <T style={{ color: HERO.ink, fontSize: typeScale.micro }}>{glyph}</T>
      </View>
      <T style={{ color: HERO.ink, fontSize: typeScale.caption, fontFamily: font.sansSemibold }}>{copy}</T>
    </View>
  );
}

/** Every card opens the same way: an icon, an optional small label, then the owner's question. */
export function SectionTitle({
  eyebrow,
  question,
  icon,
  right,
  tone = "brand",
}: {
  eyebrow?: string;
  question: string;
  icon: keyof typeof Ionicons.glyphMap;
  right?: ReactNode;
  tone?: "brand" | "critical" | "accent";
}) {
  const t = useTheme();
  const surface = tone === "critical" ? t.statusSurface.critical : tone === "accent" ? t.ACCENT.surface : t.brandSurface;
  const ink = tone === "critical" ? t.statusText.critical : tone === "accent" ? t.ACCENT.text : t.brandText;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: radius.sm,
          backgroundColor: surface,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name={icon} size={17} color={ink} />
      </View>
      <View style={{ flex: 1 }}>
        {eyebrow ? <T variant="caption">{eyebrow}</T> : null}
        <T variant="title" accessibilityRole="header" style={{ color: t.textPrimary }}>
          {question}
        </T>
      </View>
      {right}
    </View>
  );
}

/** One row in a list card: tinted icon, title and detail, then a value or chevron. */
export function IconRow({
  icon,
  tone = "brand",
  title,
  detail,
  right,
  onPress,
  first,
  accessibilityLabel,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tone?: "brand" | "critical" | "accent" | "info" | "neutral";
  title: string;
  detail?: string | null;
  right?: ReactNode;
  onPress?: () => void;
  first?: boolean;
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  const surface =
    tone === "critical"
      ? t.statusSurface.critical
      : tone === "accent"
        ? t.ACCENT.surface
        : tone === "info"
          ? t.statusSurface.warning
          : tone === "neutral"
            ? t.surfaceMuted
            : t.brandSurface;
  const ink =
    tone === "critical"
      ? t.statusText.critical
      : tone === "accent"
        ? t.ACCENT.text
        : tone === "info"
          ? t.statusText.warning
          : tone === "neutral"
            ? t.textSecondary
            : t.brandText;
  const body = (
    <>
      <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: surface, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name={icon} size={19} color={ink} />
      </View>
      <View style={{ flex: 1 }}>
        <T style={{ fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, color: t.textPrimary }}>{title}</T>
        {detail ? <T variant="caption" style={{ marginTop: 1 }}>{detail}</T> : null}
      </View>
      {right}
      {onPress ? <Ionicons name="chevron-forward" size={16} color={t.textFaint} /> : null}
    </>
  );
  const rowStyle = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    minHeight: TAP_FLOOR + 8,
    paddingVertical: space.sm,
    borderTopWidth: first ? 0 : 1,
    borderTopColor: t.border,
  };
  if (!onPress) return <View style={rowStyle}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (detail ? `${title}, ${detail}` : title)}
      onPress={() => {
        haptics.tapped();
        onPress();
      }}
      style={({ pressed }) => ({ ...rowStyle, opacity: pressed ? 0.7 : 1 })}
    >
      {body}
    </Pressable>
  );
}

/** A month/day tile for a dated row (upcoming bills, repeating expenses). */
export function DateTile({ iso }: { iso: string }) {
  const t = useTheme();
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const month = d.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }).toUpperCase();
  return (
    <View style={{ width: 44, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: t.border, alignItems: "center" }}>
      <View style={{ alignSelf: "stretch", backgroundColor: t.ACCENT.fill, paddingVertical: 1 }}>
        <T style={{ textAlign: "center", fontSize: typeScale.micro, fontFamily: font.sansSemibold, color: t.ACCENT.onFill }}>{month}</T>
      </View>
      <T style={{ fontFamily: font.displayBold, fontSize: typeScale.title, color: t.textPrimary, paddingVertical: 2 }}>
        {String(d.getUTCDate())}
      </T>
    </View>
  );
}
