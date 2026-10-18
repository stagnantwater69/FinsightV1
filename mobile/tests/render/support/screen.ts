import type { ComponentType } from "react";

/**
 * A screen with its navigation props loosened for a render test.
 *
 * Screens are typed with their real navigator props (src/navigation/types.ts),
 * which the app checks. A render test drives a screen with a fake that has
 * only the methods it asserts on, and usually no route, so those props are
 * relaxed here rather than at every call site. Nothing else about the
 * screen's props changes.
 */
export function testScreen<Props extends object>(
  Screen: ComponentType<Props>,
): ComponentType<Omit<Props, "navigation" | "route"> & { navigation?: unknown; route?: unknown }> {
  return Screen as unknown as ComponentType<Omit<Props, "navigation" | "route"> & { navigation?: unknown; route?: unknown }>;
}
