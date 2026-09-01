import { useCallback, useRef, useState } from "react";
import { Alert as RNAlert, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Button, Callout, Card, EmptyState, ErrorNote, Field, Money, Screen, T } from "../components/ui";
import { PhotoUpload } from "../components/PhotoUpload";
import { SignOutSheet } from "../components/SignOutSheet";
import { useAuth } from "../context/AuthContext";
import {
  isValid,
  validateChangePassword,
  type ChangePasswordField,
  type FieldErrors,
} from "../lib/authValidation";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api, errorMessage, getFieldErrors } from "../lib/api";
import * as haptics from "../lib/haptics";
import { font, radius, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "../components/touchTarget";
import { useTheme } from "../context/ThemeContext";
import type { BusinessProfile, Profile } from "../lib/types";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import {
  EMPTY_DRAFT,
  applyFieldUpdate,
  draftFromProfile,
  hasErrors,
  thresholdDisplayValue,
  toBusinessProfileInput,
  validateDraft,
  type BusinessProfileDraft,
  type BusinessTextField,
} from "../lib/businessProfileDraft";

/**
 * The archived-panel "Hide" link: what it looks like, and the slop that makes
 * it reach the platform tap floor. Written as a pair so the two can never
 * drift — the second is computed from the first and TAP_FLOOR, so raising the
 * floor raises the slop rather than silently leaving a 32-point target.
 */
const HIDE_LINK_HEIGHT = 32;
const HIDE_LINK_SLOP = Math.ceil((TAP_FLOOR - HIDE_LINK_HEIGHT) / 2);


// ---------------------------------------------------------------- List / switcher

export function BusinessProfilesScreen({ navigation }: any) {
  const t = useTheme();
  const { brand } = t;
  const { profiles, selected, selectProfile, loading, archiveProfile, restoreProfile, listArchived } =
    useBusinessProfiles();
  const [archived, setArchived] = useState<BusinessProfile[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadArchived = useCallback(async () => {
    setError(null);
    try {
      setArchived(await listArchived());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [listArchived]);

  // Refocusing this screen should refresh the archived panel if — and only
  // if — it is currently expanded. Read through refs rather than closing
  // over `archived`/`loadArchived` directly: both are recreated on every
  // provider render (the context doesn't memoize `listArchived`), so an
  // exhaustive-deps array here would refire the effect on unrelated
  // re-renders instead of only on refocus.
  const archivedRef = useRef(archived);
  archivedRef.current = archived;
  const loadArchivedRef = useRef(loadArchived);
  loadArchivedRef.current = loadArchived;

  useFocusEffect(
    useCallback(() => {
      if (archivedRef.current !== null) loadArchivedRef.current();
    }, []),
  );

  function confirmArchive(p: BusinessProfile) {
    // Archive is reversible but still pulls a business out of the switcher, so
    // it gets a confirmation that says plainly that nothing is deleted.
    RNAlert.alert(
      `Archive "${p.name}"?`,
      "It will be hidden from your list of businesses. Nothing is deleted — all its records, insights and " +
        "conversations are kept, and you can restore it at any time.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Archive",
          style: "destructive",
          onPress: async () => {
            setBusyId(p.id);
            try {
              await archiveProfile(p.id);
              if (archived) await loadArchived();
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusyId(null);
            }
          },
        },
      ]
    );
  }

  /**
   * The archived panel renders in BOTH the empty and populated states — an
   * owner who archives their only business must still be able to find it.
   * Same fix the web app needed.
   */
  const archivedPanel = (
    <View style={{ marginTop: space.xl }}>
      {archived === null ? (
        <Button title="Show archived businesses" variant="ghost" onPress={loadArchived} />
      ) : (
        <Card>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: space.md }}>
            <T variant="heading" accessibilityRole="header">Archived businesses</T>
            <Pressable
              onPress={() => setArchived(null)}
              /*
               * hitSlop rather than height, and the slop is DERIVED from the
               * floor rather than guessed at 10. This is a caption-sized link
               * sitting opposite a heading in a card header row: laying it out
               * to 48 would drag that header twenty-odd points taller for a
               * secondary control, which is exactly the dense-layout case the
               * audit allows slop for. HIDE_LINK_HEIGHT is the visual size and
               * the slop makes up the rest, on both platforms.
               */
              hitSlop={HIDE_LINK_SLOP}
              accessibilityRole="button"
              accessibilityLabel="Hide archived businesses"
              style={{ minHeight: HIDE_LINK_HEIGHT, justifyContent: "center" }}
            >
              <T variant="caption">Hide</T>
            </Pressable>
          </View>
          {archived.length === 0 ? (
            <T variant="caption">You have no archived businesses.</T>
          ) : (
            archived.map((p) => (
              <View
                key={p.id}
                style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: space.sm, gap: space.sm }}
              >
                <View style={{ flex: 1 }}>
                  <T style={{ fontSize: typeScale.bodySm }}>{p.name}</T>
                  <T variant="caption">{p.type}{p.archivedAt ? ` · archived ${p.archivedAt.slice(0, 10)}` : ""}</T>
                </View>
                <Button
                  title="Restore"
                  variant="secondary"
                  loading={busyId === p.id}
                  onPress={async () => {
                    setBusyId(p.id);
                    try {
                      await restoreProfile(p.id);
                      await loadArchived();
                    } finally {
                      setBusyId(null);
                    }
                  }}
                />
              </View>
            ))
          )}
          <T variant="caption" style={{ marginTop: space.md }}>
            Archived businesses keep all their records. Restoring one brings it back exactly as it was.
          </T>
        </Card>
      )}
    </View>
  );

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
        <T variant="title" style={{ marginBottom: space.md }}>Your businesses</T>
        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {loading ? null : profiles.length === 0 ? (
          <EmptyState
            title="Let's set up your first business"
            body="Add a business profile to start tracking its funds, expenses and sales."
            action={<Button title="Create a business profile" variant="primary" onPress={() => navigation.navigate("BusinessProfileForm", {})} />}
          />
        ) : (
          <>
            {profiles.map((p) => {
              const isActive = p.id === selected?.id;
              return (
                <Card key={p.id} style={{ marginBottom: space.md, borderColor: isActive ? brand[500] : brand[100], borderWidth: isActive ? 2 : 1 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
                    <View style={{ flex: 1 }}>
                      <T style={{ fontFamily: font.sansMedium, fontSize: typeScale.body }}>{p.name}</T>
                      <T variant="caption">{p.type}</T>
                    </View>
                    {isActive ? (
                      <View style={{ backgroundColor: brand[100], borderRadius: radius.full, paddingHorizontal: space.sm, height: 22, justifyContent: "center" }}>
                        <T style={{ fontSize: typeScale.micro, color: brand[700] }}>Active</T>
                      </View>
                    ) : null}
                  </View>

                  <View style={{ marginTop: space.md, gap: 4 }}>
                    <RowLine label="Available funds" value={p.availableFunds} />
                    <RowLine label="Expected monthly expenses" value={p.expectedMonthlyExpenses} />
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <T variant="caption">Operating days / month</T>
                      <T style={{ fontSize: typeScale.label }}>{p.operatingDays}</T>
                    </View>
                  </View>

                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.md }}>
                    {!isActive ? <Button title="Switch to this" variant="secondary" onPress={() => selectProfile(p.id)} /> : null}
                    <Button title="Edit" variant="ghost" onPress={() => navigation.navigate("BusinessProfileForm", { profile: p })} />
                    <Button title="Archive" variant="ghost" onPress={() => confirmArchive(p)} loading={busyId === p.id} />
                  </View>
                </Card>
              );
            })}
            <Button title="+ Add another business" variant="secondary" onPress={() => navigation.navigate("BusinessProfileForm", {})} />
          </>
        )}

        {archivedPanel}
      </ScrollView>
    </Screen>
  );
}

function RowLine({ label, value }: { label: string; value: number }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      <T variant="caption">{label}</T>
      <Money value={value} size={13} />
    </View>
  );
}

// ---------------------------------------------------------------- Create / edit

export function BusinessProfileFormScreen({ navigation, route }: any) {
  const existing: BusinessProfile | undefined = route.params?.profile;
  const { createProfile, updateProfile } = useBusinessProfiles();
  const [form, setForm] = useState<BusinessProfileDraft>(() =>
    existing ? draftFromProfile(existing) : { ...EMPTY_DRAFT, type: "Sari-sari store" },
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The logo is uploaded on its own, immediately, rather than travelling with
  // the form — so it is held apart from the fields Save writes.
  const [logoUrl, setLogoUrl] = useState<string | null>(existing?.logoUrl ?? null);
  // Through applyFieldUpdate rather than a bare spread: the threshold field
  // carries a touched flag that has to be set with it. See businessProfileDraft.ts.
  const set = (k: BusinessTextField) => (v: string) => setForm((f) => applyFieldUpdate(f, k, v));
  // One ref per field the return key hands off TO — the first field is never a
  // destination, so it needs none.
  const typeRef = useRef<TextInput>(null);
  const fundsRef = useRef<TextInput>(null);
  const monthlyRef = useRef<TextInput>(null);
  const operatingDaysRef = useRef<TextInput>(null);
  const thresholdRef = useRef<TextInput>(null);

  async function submit() {
    /*
     * The rules live in lib/businessProfileDraft.ts so this screen, the setup
     * wizard and the web's form all reject the same things for the same
     * reasons — a rule enforced in one place and not the others is how the
     * same figure comes to be accepted on a phone and refused on a laptop.
     */
    const errors = validateDraft(form);
    if (hasErrors(errors)) {
      return setError(Object.values(errors).find(Boolean) ?? "Please check the fields above.");
    }
    const payload = toBusinessProfileInput(form);

    setError(null);
    setBusy(true);
    try {
      if (existing) {
        await updateProfile(existing.id, payload);
      } else {
        await createProfile(payload);
      }
      navigation.goBack();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      {/*
        Six chained fields on one screen: without this, the return key can hand
        focus to a field the keyboard is already covering, which is worse than
        no chaining. `padding` is iOS-only — Android resizes the window itself
        via windowSoftInputMode, and adding padding on top of that double-counts
        the keyboard.
      */}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
          <Card>
            <T variant="title" style={{ marginBottom: space.md }}>
              {existing ? "Edit business" : "Add a business"}
            </T>
            {/*
              Only on an existing business: the upload endpoint is scoped to a
              profile id, which does not exist until the business is created.
              Offering it on the create form would be a control that cannot work
              yet.
            */}
            {existing ? (
              <PhotoUpload
                url={logoUrl}
                endpoint={`/business-profiles/${existing.id}/logo`}
                label="Business logo"
                shape="square"
                onUploaded={(updated) => setLogoUrl((updated as BusinessProfile).logoUrl)}
              />
            ) : null}
            {/*
              The return key walks the six fields in order and submits from the
              last, the same chain the auth forms use. The four numeric fields
              below are wired identically, but a phone keypad has no return key
              on iOS — there the chain simply ends at the last text keyboard and
              the owner taps the next field. Android's number pads do carry one.
            */}
            <Field
              label="Business name"
              value={form.name}
              maxLength={FIELD_LIMITS.businessName}
              onChangeText={set("name")}
              placeholder="e.g. Aling Nena's Store"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => typeRef.current?.focus()}
            />
            <Field
              ref={typeRef}
              label="Type"
              value={form.type}
              maxLength={FIELD_LIMITS.businessType}
              onChangeText={set("type")}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => fundsRef.current?.focus()}
            />
            <Field
              ref={fundsRef}
              label="Available business funds (PHP)"
              value={form.availableFunds}
              onChangeText={set("availableFunds")}
              keyboardType="decimal-pad"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => monthlyRef.current?.focus()}
            />
            <T variant="caption" style={{ marginTop: -space.sm, marginBottom: space.md }}>
              The money you have on hand for the business right now.
            </T>
            <Field
              ref={monthlyRef}
              label="Expected monthly expenses (PHP)"
              value={form.expectedMonthlyExpenses}
              onChangeText={set("expectedMonthlyExpenses")}
              keyboardType="decimal-pad"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => operatingDaysRef.current?.focus()}
            />
            <T variant="caption" style={{ marginTop: -space.sm, marginBottom: space.md }}>
              Roughly what a normal month costs you. This drives your daily sales target.
            </T>
            <Field
              ref={operatingDaysRef}
              label="Operating days per month"
              value={form.operatingDays}
              onChangeText={set("operatingDays")}
              keyboardType="number-pad"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => thresholdRef.current?.focus()}
            />
            {/*
              ASKED IN PESOS, STORED AS A PERCENT — see lib/largeExpenseThreshold.ts
              for why the two representations differ. Asking "what share of your
              expected monthly expenses counts as large?" made an owner do
              arithmetic against a figure they had just estimated; "flag anything
              over PHP X" is a question they can answer from experience.
            */}
            <Field
              ref={thresholdRef}
              label="Flag single expenses over (PHP) — optional"
              value={thresholdDisplayValue(form)}
              onChangeText={set("largeExpenseThresholdPesos")}
              keyboardType="decimal-pad"
              returnKeyType="done"
              // Mirrors the button's own `loading` guard: a second submit while
              // the first is in flight would create two businesses.
              onSubmitEditing={() => {
                if (!busy) submit();
              }}
            />
            <T variant="caption" style={{ marginTop: -space.sm, marginBottom: space.md }}>
              Expenses this big get set aside for you to review, so a large or mistaken one doesn't
              slip past. Suggested from your monthly expenses — change it anytime.
            </T>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button title={existing ? "Save changes" : "Create business"} variant="primary" onPress={submit} loading={busy} style={{ marginTop: space.md }} />
          </Card>

          {/*
            Only on an existing business, for the same reason the logo upload
            above is: the schedule endpoints are scoped to a business profile
            id that does not exist until the business is created.
            Recovery Target Improvement Plan §11 Phase 2.
          */}
          {existing ? (
            <Card style={{ marginTop: space.lg }}>
              <T variant="title" style={{ marginBottom: 4 }}>Operating schedule</T>
              <T variant="caption" style={{ marginBottom: space.md }}>
                Which days of the week this business is normally open, plus any holidays or one-off closures. FinSight
                uses this to calculate exact operating days for your Recovery Target instead of an estimate.
              </T>
              <Button
                title="Edit operating schedule"
                variant="secondary"
                onPress={() => navigation.navigate("OperatingSchedule")}
              />
            </Card>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

// ---------------------------------------------------------------- Profile / account

export function ProfileScreen() {
  const t = useTheme();
  const { brand, ink } = t;
  const { profile, updateProfile, logout, logoutEverywhere, changePassword, setProfileFromServer } = useAuth();
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [form, setForm] = useState({
    firstName: profile?.firstName ?? "",
    lastName: profile?.lastName ?? "",
    phoneNumber: profile?.phoneNumber ?? "",
  });
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwErrors, setPwErrors] = useState<FieldErrors<ChangePasswordField>>({});

  /** Updates one password box and clears whatever was flagged on it. */
  const setPwField = (key: "current" | "next" | "confirm", field: ChangePasswordField) => (v: string) => {
    setPw((p) => ({ ...p, [key]: v }));
    setPwErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  };
  const [deletePassword, setDeletePassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Two separate chains, because this screen holds two independent forms with
   * two submit handlers. The profile card's last field must NOT hand focus to
   * the security card — jumping from a phone number into "Current password"
   * would suggest the two are saved together, and they are not.
   */
  const lastNameRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  const nextPwRef = useRef<TextInput>(null);
  const confirmPwRef = useRef<TextInput>(null);

  if (!profile) return null;

  async function saveProfile() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await updateProfile({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        phoneNumber: form.phoneNumber.trim() || null,
      });
      setMsg("Changes saved.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword() {
    setError(null);
    setMsg(null);

    /*
      Through `validateChangePassword` rather than the two `if`s that used to
      sit here.

      Those returned one sentence at the bottom of a three-box form, so "these
      do not match" appeared nowhere near the box that did not match — and
      they duplicated rules the server already owns, which is how the two end
      up disagreeing. The shared validator is checked against the real server
      schema in backend/tests/contract/authValidation.test.ts.
    */
    const invalid = validateChangePassword({
      currentPassword: pw.current,
      newPassword: pw.next,
      confirmPassword: pw.confirm,
    });
    if (!isValid(invalid)) {
      setPwErrors(invalid);
      haptics.failed();
      return;
    }
    setPwErrors({});

    setBusy(true);
    try {
      await changePassword(pw.current, pw.next);
      /*
       * This phone STAYS SIGNED IN; every other device is signed out.
       *
       * It used to sign out here, on the belief that Supabase invalidates
       * sessions when the password is rotated. It does not — so the effect was
       * the reverse of the intention: the other devices stayed signed in and
       * the only session ended was the one belonging to the person who had just
       * proved they knew the current password. The server now revokes the
       * others explicitly, and web says and does the same thing.
       */
      setPw({ current: "", next: "", confirm: "" });
      setPasswordChanged(true);
    } catch (err) {
      // A wrong current password comes back as a message rather than a field
      // error — the server does not say which box it meant, so neither does
      // this.
      const fromServer = getFieldErrors(err);
      setPwErrors(fromServer);
      setError(isValid(fromServer) ? errorMessage(err) : null);
    } finally {
      setBusy(false);
    }
  }

  function confirmAccountDeletion() {
    if (!deletePassword) return setError("Enter your current password before deleting the account.");
    RNAlert.alert(
      "Permanently delete account?",
      "Every business, record, receipt image, and import will be removed. This cannot be undone.",
      [
        { text: "Keep account", style: "cancel" },
        {
          text: "Delete everything",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            setError(null);
            try {
              await api.delete("/auth/me", { currentPassword: deletePassword });
              await logout();
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  return (
    <Screen>
      {/*
        Both cards on this screen are forms, so the keyboard is avoided for
        the whole scroll view rather than per card. `padding` is iOS-only;
        Android already resizes the window for the keyboard on its own.
      */}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.lg }}>
          <Card>
            <T variant="title" style={{ marginBottom: space.md }}>My profile</T>
            {/*
              The upload endpoint existed long before mobile had any way to
              reach it, so a phone could display a photo set on the web app but
              never set one — the wrong way round, since the phone is where the
              camera and the photo library are.
            */}
            <PhotoUpload
              url={profile.avatarUrl}
              endpoint="/auth/me/avatar"
              label="Profile photo"
              onUploaded={(updated) => setProfileFromServer(updated as Profile)}
            />
            <Field
              label="First name"
              value={form.firstName}
              onChangeText={(v) => setForm((f) => ({ ...f, firstName: v }))}
              autoComplete="given-name"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => lastNameRef.current?.focus()}
            />
            <Field
              ref={lastNameRef}
              label="Last name"
              value={form.lastName}
              onChangeText={(v) => setForm((f) => ({ ...f, lastName: v }))}
              autoComplete="family-name"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => phoneRef.current?.focus()}
            />
            {/*
              The chain ends here rather than continuing into the security card
              below. A phone pad also has no return key on iOS, so this one is
              reached by tap there and the button is the only way out.
            */}
            <Field
              ref={phoneRef}
              label="Phone number"
              value={form.phoneNumber}
              onChangeText={(v) => setForm((f) => ({ ...f, phoneNumber: v }))}
              keyboardType="phone-pad"
              autoComplete="tel"
              returnKeyType="done"
              onSubmitEditing={() => {
                if (!busy) saveProfile();
              }}
            />
            <View style={{ marginBottom: space.md }}>
              <T variant="label" style={{ marginBottom: 4 }}>Email</T>
              <T style={{ fontSize: typeScale.bodySm, color: ink[500] }}>{profile.email}</T>
            </View>
            {msg ? <T style={{ color: brand[700], fontSize: typeScale.bodySm, marginBottom: space.sm }}>{msg}</T> : null}
            <Button title="Save changes" variant="primary" onPress={saveProfile} loading={busy} />
          </Card>

          <Card>
            <T variant="title" style={{ marginBottom: 4 }}>Security</T>
            <T variant="caption" style={{ marginBottom: space.md }}>
              Changing your password signs you out on every device, including this one.
            </T>
            <Field
              label="Current password"
              value={pw.current}
              onChangeText={setPwField("current", "currentPassword")}
              error={pwErrors.currentPassword}
              secureTextEntry
              autoComplete="password"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => nextPwRef.current?.focus()}
            />
            <Field
              ref={nextPwRef}
              label="New password"
              value={pw.next}
              onChangeText={setPwField("next", "newPassword")}
              error={pwErrors.newPassword}
              secureTextEntry
              autoComplete="new-password"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => confirmPwRef.current?.focus()}
            />
            <Field
              ref={confirmPwRef}
              label="Confirm new password"
              value={pw.confirm}
              onChangeText={setPwField("confirm", "confirmPassword")}
              error={pwErrors.confirmPassword}
              secureTextEntry
              autoComplete="new-password"
              returnKeyType="done"
              onSubmitEditing={() => {
                if (!busy) submitPassword();
              }}
            />
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            {/*
              States the session policy, because the owner cannot otherwise tell
              what just happened to their other devices — and the policy is the
              same on web, so the wording is too.
            */}
            {passwordChanged ? (
              <Callout>
                Password changed. You're still signed in here, and any other devices have been signed out.
              </Callout>
            ) : null}
            <Button title="Change password" onPress={submitPassword} loading={busy} style={{ marginTop: space.sm }} />
          </Card>

          {/*
            "Log out everywhere", as its own deliberate action.

            It used to be the ONLY behaviour: every ordinary log-out was global,
            so tapping "Log out" on this phone silently ended the session on the
            shop's tablet too. Ordinary log-out is now local, and the sweeping
            version lives here — where someone who has just realised a phone was
            stolen can find it, and where there is room to say what it does.
          */}
          <Card>
            <T variant="title" style={{ marginBottom: 4 }}>Devices</T>
            <T variant="caption" style={{ marginBottom: space.md }}>
              Logging out normally signs out this phone only. If you've lost a device, or used one you don't trust,
              sign out everywhere instead.
            </T>
            <Button
              title="Log out on all devices"
              variant="secondary"
              loading={busy}
              onPress={() =>
                RNAlert.alert(
                  "Log out on all devices?",
                  "Every device signed in to this account — including this one — will be signed out. You'll need your password to get back in.",
                  [
                    { text: "Cancel", style: "cancel" },
                    { text: "Log out everywhere", style: "destructive", onPress: () => void logoutEverywhere() },
                  ],
                )
              }
            />
          </Card>

          <Card>
            {/* `statusText.critical`, not the one-off #b42318 this carried — a second
                independent red beside the token the app already has for
                "critical" is exactly the drift the design system forbids. */}
            <T variant="title" style={{ marginBottom: 4, color: t.statusText.critical }}>Delete account</T>
            <T variant="caption" style={{ marginBottom: space.md }}>
              Permanently removes every business, record, receipt image, import, and sign-in credential.
            </T>
            <Field
              label="Current password"
              value={deletePassword}
              onChangeText={setDeletePassword}
              secureTextEntry
              autoComplete="password"
            />
            <Button title="Delete my account" variant="danger" onPress={confirmAccountDeletion} loading={busy} />
          </Card>

          {/*
            OPENS THE SHARED CONFIRMATION — it does not sign out on the tap.
            It used to (`onPress={logout}`), which made this the one sign-out
            in the app with no confirmation, no progress state and no guard
            against a second tap, while More's row had all three. The sheet
            they now share is components/SignOutSheet.tsx.
          */}
          <Button title="Sign out" variant="danger" onPress={() => setSignOutOpen(true)} />
        </ScrollView>
      </KeyboardAvoidingView>

      <SignOutSheet visible={signOutOpen} onClose={() => setSignOutOpen(false)} />
    </Screen>
  );
}
