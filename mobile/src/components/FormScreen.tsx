import { useContext, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, type ScrollViewProps } from "react-native";
import { HeaderHeightContext } from "@react-navigation/elements";
import { Screen } from "./ui";
import { ContentScrollView } from "./ContentScrollView";
import { space } from "../theme/tokens";

export function FormScreen({ children, safeTop = false, keyboardVerticalOffset, ...scrollProps }: ScrollViewProps & {
  children: ReactNode;
  safeTop?: boolean;
  keyboardVerticalOffset?: number;
}) {
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  return (
    <Screen safeTop={safeTop}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={keyboardVerticalOffset ?? headerHeight}
        style={{ flex: 1 }}
      >
        <ContentScrollView
          {...scrollProps}
          contentContainerStyle={[
            { padding: space.lg, paddingBottom: space.xxl * 2 },
            scrollProps.contentContainerStyle,
          ]}
        >
          {children}
        </ContentScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
