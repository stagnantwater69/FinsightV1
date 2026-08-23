import type { ReactNode } from "react";
import { Pressable } from "react-native";
import { T } from "../../../components/ui";
import { font, radius, space, typeScale } from "../../../theme/tokens";
import { useTheme } from "../../../context/ThemeContext";

/**
 * One answer to "what is this difference".
 *
 * A single decision with mutually exclusive answers, so it behaves as a radio
 * for assistive tech rather than as three unrelated buttons.
 */
export function GapOption({
  selected,
  onPress,
  title,
  detail,
  children,
}: {
  selected: boolean;
  onPress: () => void;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  const t = useTheme();
  const { brand, ink, paper } = t;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={{
        borderWidth: 1,
        borderColor: selected ? brand[600] : ink[200],
        backgroundColor: selected ? brand[50] : paper.DEFAULT,
        borderRadius: radius.md,
        padding: space.md,
        marginBottom: space.sm,
      }}
    >
      <T style={{ fontSize: typeScale.bodySm, color: ink[900], fontFamily: font.sansMedium }}>{title}</T>
      <T variant="caption" style={{ marginTop: 2 }}>{detail}</T>
      {children}
    </Pressable>
  );
}
