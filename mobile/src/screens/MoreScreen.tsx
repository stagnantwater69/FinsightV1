import { useState } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card, ConfirmSheet, Screen, T } from "../components/ui";
/*
 * The row and section primitives are shared with the Settings screen rather
 * than declared here, which is where they used to live — see
 * components/SettingsList.tsx.
 */
import { Row, Section } from "../components/SettingsList";
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { font, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";

/**
 * Everything that is not a daily task.
 *
 * The bottom bar previously spent one of its four slots on "Business", which
 * put profile settings at the same level as recording an expense — a thing an
 * owner does once next to a thing they do several times a day. Account,
 * businesses and alerts now live behind one "More" tab, which is the
 * convention on both platforms and frees the bar for work.
 *
 * The screen is a list of destinations, so its whole job is being scannable.
 * Three things do that work: a heading over each group, so nobody reads
 * fifteen rows to find the legal ones; a one-line description under each row,
 * because "Terms of use" says nothing about whether it is the thing you want;
 * and a medallion, which is what the eye actually returns to.
 */

/** Initials, for an owner who has not set a photo. */
function initialsOf(first: string, last: string): string {
  return `${first.trim().charAt(0)}${last.trim().charAt(0)}`.toUpperCase() || "?";
}

export function MoreScreen({ navigation }: any) {
  const t = useTheme();
  const { brand, ink } = t;
  const { profile, logout } = useAuth();
  const { selected, profiles } = useBusinessProfiles();
  const [signOutOpen, setSignOutOpen] = useState(false);

  return (
    <Screen safeTop>
      {/*
        No "More" heading. The tab bar's own label already says which tab this
        is, and repeating it as the first line of the screen spent the most
        valuable row on a word the owner just tapped. The profile card leads
        instead — it is the thing they came here to check or change.
      */}
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: space.md, paddingBottom: space.xxl * 2, gap: space.lg }}>
        {/*
          WHO IS SIGNED IN, as a card rather than a caption under the title.
          It was one grey line, which is not enough on the one screen where
          the question is asked — a phone shared between an owner and a helper
          has two accounts on it, and the cost of recording a day's takings
          into the wrong one is a day's books.
        */}
        {profile ? (
          <Pressable
            onPress={() => navigation.navigate("Profile")}
            accessibilityRole="button"
            accessibilityLabel={`Signed in as ${profile.firstName} ${profile.lastName}, ${profile.email}. Open my account.`}
            style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
          >
            <Card>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                <View
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 26,
                    backgroundColor: brand[700],
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                  }}
                >
                  {profile.avatarUrl ? (
                    <Image
                      source={{ uri: profile.avatarUrl }}
                      style={{ width: "100%", height: "100%" }}
                      accessibilityIgnoresInvertColors
                    />
                  ) : (
                    <T style={{ color: "#fff", fontSize: typeScale.title, fontFamily: font.sansSemibold }}>
                      {initialsOf(profile.firstName, profile.lastName)}
                    </T>
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  {/*
                    "Signed in as" is an EYEBROW here, not a line under the
                    name. The reference mockup prints the name, then "Signed in
                    as <the same name>", then the email — which states the name
                    twice and the useful part once. Moving the framing above it
                    keeps what that line was for and drops the repetition.
                  */}
                  <T variant="caption" style={{ fontSize: typeScale.micro, letterSpacing: 0.3, textTransform: "uppercase" }}>
                    Signed in as
                  </T>
                  <T
                    style={{ fontSize: typeScale.bodyLg, color: ink[900], fontFamily: font.sansSemibold, marginTop: 1 }}
                    numberOfLines={1}
                  >
                    {profile.firstName} {profile.lastName}
                  </T>
                  <T variant="caption" numberOfLines={1}>
                    {profile.email}
                  </T>
                </View>
                <Ionicons name="chevron-forward" size={18} color={ink[300]} />
              </View>
            </Card>
          </Pressable>
        ) : null}

        <Section title="Account & business">
          <Row
            first
            icon="person-circle-outline"
            label="My account"
            detail={profile?.email}
            onPress={() => navigation.navigate("Profile")}
          />
          <Row
            icon="storefront-outline"
            label="Businesses"
            detail={
              selected
                ? `${selected.name}${profiles.length > 1 ? ` and ${profiles.length - 1} more` : ""}`
                : "Set one up to get started"
            }
            onPress={() => navigation.navigate("BusinessProfiles")}
          />
          <Row
            icon="notifications-outline"
            label="Alerts"
            detail="Duplicates, large expenses, anything worth a look"
            onPress={() => navigation.navigate("Notifications")}
          />
          {/*
            ONE ROW, NOT A SECTION. What used to sit below this card as
            "Preferences" was two tour switches; it is now three groups — the
            tour, the daily message on Home, and light or dark — which is more
            than a card on the way to Help and legal should be spending. A
            destination keeps this screen a list of places, and puts the
            settings somewhere an owner can be sent to ("open Settings")
            rather than somewhere they have to be scrolled to.

            It sits in this group rather than under Help because these are all
            things about THIS owner's app, and because Settings is where
            someone looks after they have looked at their account.
          */}
          <Row
            icon="settings-outline"
            label="Settings"
            detail="The guided tour, Fin's daily message, and light or dark"
            onPress={() => navigation.navigate("Settings")}
          />
        </Section>

        {/*
          Help and legal, in the app rather than on the website. Most owners
          have a phone and no computer, so for them this is the only place
          these will ever be read.
        */}
        <Section title="Help & support">
          <Row
            first
            icon="help-circle-outline"
            label="Questions & answers"
            detail="What FinSight does, and what it does not"
            onPress={() => navigation.navigate("Faqs")}
          />
          <Row
            icon="school-outline"
            label="Tutorials"
            detail="Step by step, from setup to reading your dashboard"
            onPress={() => navigation.navigate("Tutorials")}
          />
          <Row
            icon="mail-outline"
            label="Contact us"
            detail="Something wrong? We would rather hear about it"
            onPress={() => navigation.navigate("Contact")}
          />
        </Section>

        <Section title="Legal">
          <Row
            first
            icon="lock-closed-outline"
            label="Privacy"
            detail="What is stored, and who can reach it"
            onPress={() => navigation.navigate("Privacy")}
          />
          <Row
            icon="document-text-outline"
            label="Terms of use"
            detail="What FinSight is for, and what it is not"
            onPress={() => navigation.navigate("Terms")}
          />
        </Section>

        {/*
          No heading, because it is not a group — and it sits apart from the
          Legal card above it so a thumb reaching for "Terms of use" does not
          land on it.
        */}
        <Card>
          <Row first destructive icon="log-out-outline" label="Sign out" onPress={() => setSignOutOpen(true)} />
        </Card>

        <T variant="caption" style={{ textAlign: "center" }}>
          FinSight — see smarter, spend wiser.
        </T>
      </ScrollView>

      {/*
        Signing out used to happen on the tap.

        It is not catastrophic — nothing is deleted and the account is still
        there — but it ends the session on a screen whose other nine rows all
        just open something, so it is the one place a mis-tap has a cost. And
        on a phone with the address saved but not the password, "sign in
        again" can mean finding a password nobody has typed in months.
      */}
      <ConfirmSheet
        visible={signOutOpen}
        title="Sign out of FinSight?"
        body="You'll need to sign in again to access your business data."
        confirmLabel="Sign out"
        onConfirm={() => {
          setSignOutOpen(false);
          void logout();
        }}
        onCancel={() => setSignOutOpen(false)}
      />
    </Screen>
  );
}
