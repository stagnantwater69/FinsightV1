import { Component, type ErrorInfo, type ReactNode } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "../context/ThemeContext";
import { space } from "../theme/tokens";
import { Button, T } from "./ui";

/**
 * Catches a render-time error anywhere below the theme and shows a way back,
 * instead of the red screen in development and an instant close in a release
 * build. React unmounts the whole tree when a render throws, and without a
 * boundary a release build has nothing left to draw.
 *
 * "Try again" remounts the tree: navigation, auth and every screen start
 * fresh. That repeats no write. Records are only sent from a user's press,
 * and a manual record that was in flight is resent only from its recovery
 * notice, under the idempotency key it was first sent with.
 *
 * The message is drawn only in development. In a release build it can carry
 * record text or file paths, and the owner can do nothing with it.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <CrashScreen error={error} onRetry={() => this.setState({ error: null })} />;
  }
}

function CrashScreen({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const t = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.surface }}>
      <View style={{ flex: 1, justifyContent: "center", padding: space.xxl }}>
        <T accessibilityRole="header" variant="title" style={{ color: t.textPrimary }}>
          Something broke on this screen
        </T>
        <T style={{ marginTop: space.sm }}>
          This is a bug in FinSight, not something you did. Anything you already saved is still there.
        </T>
        {__DEV__ ? (
          <T variant="caption" selectable style={{ marginTop: space.md }}>
            {error.message}
          </T>
        ) : null}
        <Button title="Try again" onPress={onRetry} style={{ marginTop: space.xl }} />
      </View>
    </SafeAreaView>
  );
}
