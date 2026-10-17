/**
 * The fixed deep-teal "coach" panel used at the top of Home, Recovery,
 * Expenses, Spending Impact and More. Fixed in both themes, for the same
 * reason web's RecoveryHero and the mobile `brandSolid` chrome are: a brand
 * surface that flips with the theme stops reading as the brand. Everything
 * drawn on it therefore uses these fixed inks too.
 */
export const HERO = {
  from: "#14625a",
  mid: "#0f504b",
  to: "#052624",
  ink: "#ffffff",
  muted: "#a7e9dc",
  soft: "#c8f7ec",
  amber: "#fbd894",
  /** Fin's speech bubble is white on the panel; its text is the light theme's ink. */
  bubble: "#ffffff",
  bubbleInk: "#1a2022",
  /** Amber words inside the bubble: the light theme's accent text, since the bubble is always white. */
  bubbleAccent: "#94520b",
  /** Translucent fills for chips and tiles that sit on the panel. */
  wash: "rgba(255,255,255,0.08)",
  washStrong: "rgba(255,255,255,0.14)",
  hairline: "rgba(255,255,255,0.16)",
  /** Money in / money out bars, and good / bad figures, on the panel. */
  inFill: "#2ec2ac",
  outFill: "#f08080",
  goodInk: "#92eeda",
  badInk: "#f8b4b4",
  amberWash: "rgba(245,165,36,0.2)",
  /** Category slices drawn on the panel (largest first); the last is "Others". */
  series: ["#2ec2ac", "#f5a524", "#8aa6f0", "#e79ac3", "#b0bbbe"],
} as const;
