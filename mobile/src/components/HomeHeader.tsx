import { useState } from "react";
import { Image, Modal, Pressable, ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { T } from "./ui";
import { useTourTarget } from "./tour/targets";
import { brand, font, ink, paper, radius, space, statusText, TAP, typeScale } from "../theme/tokens";
import type { BusinessProfile } from "../lib/types";
import * as haptics from "../lib/haptics";

/**
 * A business's identity: its logo if one was uploaded, otherwise a circle in
 * the brand colour carrying the name's first letter. Never a blank space —
 * this is the thing a switcher's rows are told apart by.
 */
function Avatar({ profile, size = 40 }: { profile: BusinessProfile; size?: number }) {
  if (profile.logoUrl) {
    return (
      <Image
        source={{ uri: profile.logoUrl }}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: paper[200] }}
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: brand[600],
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <T style={{ color: "#fff", fontFamily: font.displayBold, fontSize: size * 0.42 }}>
        {profile.name.trim().charAt(0).toUpperCase() || "?"}
      </T>
    </View>
  );
}

/**
 * Home's own header, in place of the shared `ScreenHeader`.
 *
 * Replaces the native stack header (turned off for this screen — see
 * App.tsx) as well as the eyebrow/title pattern every other screen uses,
 * because this screen needs two things no other screen does: a way to
 * switch business without a trip through More, and the unread-alerts count
 * at a glance rather than a tap away.
 *
 * The switcher is a plain bottom sheet, not a full picker screen — switching
 * business from Home is meant to be as cheap as switching a filter, since an
 * owner running two stalls checks both in the same visit.
 */
export function HomeHeader({
  selected,
  profiles,
  onSwitch,
  unreadCount,
  onBellPress,
}: {
  selected: BusinessProfile;
  profiles: BusinessProfile[];
  onSwitch: (id: number) => void;
  unreadCount: number;
  onBellPress: () => void;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const canSwitch = profiles.length > 1;

  /*
   * The two elements the product tour spotlights on this header. Registering
   * them costs a ref and `collapsable: false`; nothing else about either
   * control changes, and neither knows the tour exists beyond the key.
   */
  const switcherTourTarget = useTourTarget("business-switcher", { scrolls: true });
  const bellTourTarget = useTourTarget("notifications", { scrolls: true, radius: radius.full });

  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <Pressable
          {...switcherTourTarget}
          onPress={() => {
            if (!canSwitch) return;
            haptics.tapped();
            setSwitcherOpen(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={canSwitch ? `${selected.name}. Switch business.` : selected.name}
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            opacity: pressed && canSwitch ? 0.75 : 1,
          })}
        >
          <Avatar profile={selected} />
          {/*
            The name and its chevron are one group, not two things pushed to
            opposite ends. The name used to carry `flex: 1`, which made it
            claim every spare pixel in the row and stranded the chevron out at
            the far edge — so a short business name left a wide gap that read
            as a layout bug. `flexShrink` instead: the group is only as wide as
            the name needs, and a long name truncates rather than shoving the
            chevron off the row.
          */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 1 }}>
            <T accessibilityRole="header" variant="title" numberOfLines={1} style={{ flexShrink: 1 }}>
              {selected.name}
            </T>
            {canSwitch ? <Ionicons name="chevron-down" size={18} color={ink[500]} /> : null}
          </View>
          <View style={{ flex: 1 }} />
        </Pressable>

        <Pressable
          {...bellTourTarget}
          onPress={onBellPress}
          accessibilityRole="button"
          accessibilityLabel={unreadCount > 0 ? `Alerts, ${unreadCount} unread` : "Alerts"}
          hitSlop={8}
          style={({ pressed }) => ({
            width: TAP,
            height: TAP,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.7 : 1,
          })}
        >
          {/*
            Sized to the icon itself (24x24), not the 44x44 tap target — the
            badge is pinned to ITS corner. Anchoring to the Pressable's own
            corner instead put the badge in the padding, well clear of the
            bell it's meant to be reporting on.
          */}
          <View style={{ width: 24, height: 24 }}>
            <Ionicons name="notifications-outline" size={24} color={ink[700]} />
            {unreadCount > 0 ? (
              <View
                style={{
                  position: "absolute",
                  top: -4,
                  right: -4,
                  minWidth: 16,
                  height: 16,
                  borderRadius: 8,
                  paddingHorizontal: 3,
                  backgroundColor: statusText.critical,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: 1.5,
                  borderColor: paper.DEFAULT,
                }}
              >
                <T style={{ color: "#fff", fontSize: 9, fontFamily: font.sansSemibold, lineHeight: 11 }}>
                  {unreadCount > 9 ? "9+" : unreadCount}
                </T>
              </View>
            ) : null}
          </View>
        </Pressable>
      </View>

      <Modal
        visible={switcherOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setSwitcherOpen(false)}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(10,16,17,0.5)" }}>
          <Pressable
            style={{ flex: 1 }}
            onPress={() => setSwitcherOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close business switcher"
          />
          <View
            style={{
              backgroundColor: paper.DEFAULT,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              paddingTop: space.lg,
              paddingBottom: space.xxl,
              maxHeight: "70%",
            }}
          >
            <T
              variant="label"
              accessibilityRole="header"
              style={{ paddingHorizontal: space.lg, marginBottom: space.sm, color: ink[500] }}
            >
              Switch business
            </T>
            <ScrollView>
              {profiles.map((p) => (
                <Pressable
                  key={p.id}
                  onPress={() => {
                    haptics.tapped();
                    onSwitch(p.id);
                    setSwitcherOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: p.id === selected.id }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.md,
                    paddingHorizontal: space.lg,
                    minHeight: TAP + 8,
                    backgroundColor: pressed ? paper[100] : "transparent",
                  })}
                >
                  <Avatar profile={p} size={32} />
                  <T style={{ flex: 1, fontSize: typeScale.body, color: ink[900] }} numberOfLines={1}>
                    {p.name}
                  </T>
                  {p.id === selected.id ? <Ionicons name="checkmark" size={18} color={brand[600]} /> : null}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}
