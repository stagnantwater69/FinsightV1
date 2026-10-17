import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { HeaderHeightContext } from "@react-navigation/elements";
import { Keyboard, KeyboardAvoidingView, Platform, View } from "react-native";

/** Apply only the Android keyboard overlap left after any system resize. */
export function CsvKeyboardFrame({ children }: { children: ReactNode }) {
  const frame = useRef<View>(null);
  const keyboardTop = useRef<number | null>(null);
  const mounted = useRef(true);
  const [overlap, setOverlap] = useState(0);
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const measureOverlap = useCallback(() => {
    if (Platform.OS !== "android") return;
    frame.current?.measureInWindow((_x, y, _width, height) => {
      if (!mounted.current) return;
      setOverlap(keyboardTop.current === null ? 0 : Math.max(0, Math.round(y + height - keyboardTop.current)));
    });
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (Platform.OS !== "android") return () => { mounted.current = false; };
    const show = Keyboard.addListener("keyboardDidShow", (event) => {
      keyboardTop.current = event.endCoordinates.screenY;
      measureOverlap();
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      keyboardTop.current = null;
      setOverlap(0);
    });
    const metrics = Keyboard.metrics();
    if (metrics) { keyboardTop.current = metrics.screenY; measureOverlap(); }
    return () => { mounted.current = false; show.remove(); hide.remove(); };
  }, [measureOverlap]);
  return (
    <View ref={frame} style={{ flex: 1 }} onLayout={measureOverlap} testID="csv-keyboard-frame">
      <KeyboardAvoidingView
        style={{ flex: 1, paddingBottom: overlap }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={headerHeight}
      >
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}
