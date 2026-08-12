import { useTheme } from "../context/ThemeContext";
import { CATEGORICAL_PALETTE, CATEGORICAL_PALETTE_DARK } from "./chartPalette";

/**
 * The categorical palette for the active theme.
 *
 * Charts must not import CATEGORICAL_PALETTE directly. A palette validated
 * against a white surface is not valid against a near-black one — see the
 * note on CATEGORICAL_PALETTE_DARK — so the choice has to be made at render
 * time, when the theme is known.
 *
 * Both arrays are the same length and in the same hue order, so a category
 * that is slot 2 stays slot 2 across a theme switch: it changes shade, never
 * identity.
 */
export function useCategoricalPalette() {
  const { theme } = useTheme();
  return theme === "dark" ? CATEGORICAL_PALETTE_DARK : CATEGORICAL_PALETTE;
}
