const SIZES = {
  sm: "h-8 w-8",
  md: "h-11 w-11",
  lg: "h-24 w-24",
} as const;

/**
 * Fin's face in a round mint badge: the one avatar the chat uses at every size.
 *
 * The art is a square crop of mobile/assets/greeting.png with the mint baked
 * into its background, so the badge colour belongs to the artwork and stays
 * the same in every theme, like the brand teal.
 *
 * Always decorative: the "Fin" label or the heading beside it says who is
 * speaking, so announcing the picture would only repeat it.
 */
export function FinAvatar({ size = "sm", thinking = false }: { size?: keyof typeof SIZES; thinking?: boolean }) {
  return (
    <span aria-hidden className={`relative inline-flex shrink-0 ${SIZES[size]}`}>
      {/* Pulses only while an answer is being worked out, so movement means "busy". */}
      {thinking ? <span className="absolute -inset-1 rounded-full ring-2 ring-brand-300 motion-safe:animate-pulse" /> : null}
      <img
        src="/mascot/fin-avatar.webp"
        alt=""
        width={256}
        height={256}
        draggable={false}
        className={`h-full w-full select-none rounded-full ring-paper ${size === "lg" ? "shadow-lg ring-4" : "ring-2"}`}
      />
    </span>
  );
}
