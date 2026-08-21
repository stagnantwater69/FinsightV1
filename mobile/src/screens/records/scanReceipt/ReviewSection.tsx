import type { ReactNode } from "react";
import type { ViewStyle } from "react-native";
import { Card, T } from "../../../components/ui";
import { brand, space } from "../../../theme/tokens";

/**
 * A heading for one section of the receipt review.
 *
 * The review used to be a single card holding six warnings, four fields, a
 * row per item, a summary and a reconciliation question — roughly six hundred
 * lines of interface with nothing dividing it. Everything was legible and
 * nothing was findable: an owner looking for "why doesn't this add up"
 * scrolled past the same undifferentiated column every time.
 *
 * Splitting it into titled sections costs a little vertical space and buys
 * the one thing the screen most needed, which is somewhere for the eye to
 * stop.
 */
export function ReviewSection({
  title,
  caption,
  children,
  style,
}: {
  title: string;
  caption?: string;
  children: ReactNode;
  style?: ViewStyle;
}) {
  return (
    <Card style={style}>
      <T variant="heading" accessibilityRole="header" style={{ color: brand[900], marginBottom: caption ? 2 : space.md }}>
        {title}
      </T>
      {caption ? (
        <T variant="caption" style={{ marginBottom: space.md }}>
          {caption}
        </T>
      ) : null}
      {children}
    </Card>
  );
}
