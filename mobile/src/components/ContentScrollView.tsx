import { forwardRef } from "react";
import { type ScrollViewInstance, ScrollView, type ScrollViewProps } from "react-native";

export const CONTENT_WIDTH = 720;

/** Keeps forms and reading content usable in an expanded window. */
export const ContentScrollView = forwardRef<ScrollViewInstance, ScrollViewProps>(function ContentScrollView(
  { contentContainerStyle, keyboardShouldPersistTaps = "handled", keyboardDismissMode = "on-drag", ...props },
  ref,
) {
  return (
    <ScrollView
      ref={ref}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      keyboardDismissMode={keyboardDismissMode}
      {...props}
      contentContainerStyle={[
        { width: "100%", maxWidth: CONTENT_WIDTH, alignSelf: "center" },
        contentContainerStyle,
      ]}
    />
  );
});
