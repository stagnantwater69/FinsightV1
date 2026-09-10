import { ActivityIndicator, Image, ScrollView, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, space, typeScale } from "../theme/tokens";

/** Matches the native splash plate, then shows real session-loading feedback. */
export function LaunchScreen({ fontsReady }: { fontsReady: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: "#052624" }}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={{
        flexGrow: 1,
        justifyContent: "center",
        alignItems: "center",
        paddingHorizontal: space.xxl,
        paddingTop: insets.top + space.xxl,
        paddingBottom: insets.bottom + space.xxl,
      }}>
        <Image
          source={require("../../assets/splash-icon.png")}
          style={{ width: 160, height: 160 }}
          resizeMode="contain"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
        {fontsReady ? (
          <View style={{ alignItems: "center", gap: space.sm, marginTop: space.lg, width: "100%", maxWidth: 320 }}>
            <Text accessibilityRole="header" style={{ fontFamily: font.displayBold, fontSize: typeScale.titleLg, color: "#FFFFFF", textAlign: "center" }}>FinSight</Text>
            <Text style={{ fontFamily: font.sans, fontSize: typeScale.body, color: "#C0D8D0", textAlign: "center" }}>A clearer view of your business.</Text>
            <View accessible accessibilityRole="progressbar" accessibilityLabel="Opening FinSight" accessibilityState={{ busy: true }} style={{ alignItems: "center", gap: space.md, marginTop: space.xxl }}>
              <ActivityIndicator color="#92D8B7" />
              <Text style={{ fontFamily: font.sansMedium, fontSize: typeScale.bodySm, color: "#C0D8D0", textAlign: "center" }}>Opening your workspace…</Text>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
