import { useRef } from "react";
import { Alert } from "react-native";
import { usePreventRemove, type NavigationAction } from "@react-navigation/native";

/**
 * Asks before a form with unsaved edits is left by back, a swipe or the header.
 *
 * `busy` blocks leaving outright while a save the screen cannot abandon is in
 * flight. Set the returned ref to true just before leaving on purpose (after a
 * save or delete), so that exit is not questioned.
 */
export function useDiscardGuard(navigation: { dispatch: (action: NavigationAction) => void }, busy: boolean, dirty: boolean) {
  const saved = useRef(false);
  usePreventRemove(busy || dirty, ({ data }) => {
    if (saved.current) { navigation.dispatch(data.action); return; }
    if (busy) return;
    Alert.alert("Discard changes?", "Your unsaved changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard changes", style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });
  return saved;
}
