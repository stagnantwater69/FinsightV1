import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Platform, Pressable, TextInput, useWindowDimensions, View } from "react-native";
import { useFocusEffect, usePreventRemove } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, Callout, ErrorNote, Field, Screen, T } from "../components/ui";
import { ContentScrollView, CONTENT_WIDTH } from "../components/ContentScrollView";
import { PhotoUpload } from "../components/PhotoUpload";
import { TAP_FLOOR } from "../components/touchTarget";
import { SubpageCard, SubpageHeader, SubpageIcon } from "../components/SubpageKit";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { api, errorMessage, getFieldErrors } from "../lib/api";
import { clearManualRecordRecoveryForOwner } from "../lib/manualRecordRecovery";
import { digitsOnly, isValid, MAX_NAME_LENGTH, MAX_PHONE_LENGTH, MIN_PASSWORD_LENGTH, phoneNumberError, validateChangePassword, type ChangePasswordField, type FieldErrors } from "../lib/authValidation";
import { setFlash, takeFlash } from "../lib/flash";
import * as haptics from "../lib/haptics";
import type { Profile } from "../lib/types";
import { font, radius, space, typeScale } from "../theme/tokens";
import type { MoreScreenProps } from "../navigation/types";

type ProfileField = "firstName" | "lastName" | "phoneNumber";
type ProfileDraft = Record<ProfileField, string>;

function initialsOf(profile: Profile) {
  return `${profile.firstName.trim().charAt(0)}${profile.lastName.trim().charAt(0)}`.toUpperCase() || "?";
}

type AccountNavigation = MoreScreenProps<"EditProfile">["navigation"];

function returnToAccount(navigation: Pick<AccountNavigation, "canGoBack" | "goBack" | "navigate">) {
  if (navigation.canGoBack()) navigation.goBack();
  else navigation.navigate("Profile");
}

function AccountHeader({ title, onBack, disabled = false, cancel = false }: {
  title: string;
  onBack: () => void;
  disabled?: boolean;
  cancel?: boolean;
}) {
  const t = useTheme();
  return (
    <SubpageHeader title={title} onBack={onBack} disabled={disabled} right={cancel ? (
        <Pressable onPress={onBack} disabled={disabled} accessibilityRole="button" accessibilityLabel="Cancel editing profile" accessibilityState={{ disabled }}
          style={({ pressed }) => ({ minHeight: TAP_FLOOR, flexShrink: 0, justifyContent: "center", paddingHorizontal: space.sm, opacity: disabled ? 0.5 : pressed ? 0.65 : 1 })}>
          <T style={{ color: t.brandText, fontFamily: font.sansSemibold }}>Cancel</T>
        </Pressable>
      ) : undefined} />
  );
}

function AccountUnavailable() {
  const { loading } = useAuth();
  const t = useTheme();
  return (
    <Screen safeTop>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxl, gap: space.md }}>
        {loading ? <ActivityIndicator color={t.brandText} accessibilityLabel="Loading account" /> : null}
        <T>{loading ? "Loading your account..." : "Your account details are unavailable. Sign in again to continue."}</T>
      </View>
    </Screen>
  );
}

function ContactRow({ label, value, divider = false }: { label: string; value: string; divider?: boolean }) {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  return (
    <View style={{ flexDirection: fontScale >= 1.3 ? "column" : "row", gap: space.sm, alignItems: "flex-start", paddingVertical: space.md, borderBottomWidth: divider ? 1 : 0, borderBottomColor: t.border }}>
      <T style={{ flex: fontScale >= 1.3 ? undefined : 1, color: t.textPrimary }}>{label}</T>
      <T selectable style={{ flex: fontScale >= 1.3 ? undefined : 1, textAlign: fontScale >= 1.3 ? "left" : "right", color: t.textSecondary }}>{value}</T>
    </View>
  );
}

function AccountAction({ icon, label, detail, onPress, destructive = false }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  detail: string;
  onPress: () => void;
  destructive?: boolean;
}) {
  const t = useTheme();
  const color = destructive ? t.statusText.critical : t.textPrimary;
  return (
    <Pressable
      onPress={() => { haptics.tapped(); onPress(); }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={detail}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TAP_FLOOR, paddingVertical: space.md, borderRadius: radius.sm, backgroundColor: pressed ? t.surfaceMuted : "transparent" })}
    >
      <SubpageIcon name={icon} tone={destructive ? "danger" : "default"} />
      <View style={{ flex: 1, gap: space.xs }}>
        <T style={{ color, fontFamily: font.sansSemibold }}>{label}</T>
        <T variant="caption">{detail}</T>
      </View>
      <Ionicons name="chevron-forward" size={20} color={t.textMuted} accessibilityElementsHidden importantForAccessibility="no" />
    </Pressable>
  );
}

export function ProfileScreen({ navigation }: MoreScreenProps<"Profile">) {
  const t = useTheme();
  const { profile } = useAuth();
  const insets = useSafeAreaInsets();
  const { fontScale, width } = useWindowDimensions();
  const stacked = width < 360 || fontScale >= 1.3;
  const avatarSize = Math.max(76, Math.ceil(typeScale.titleLg * fontScale * 1.7));
  const [flash, setMessage] = useState<string | null>(null);
  useFocusEffect(useCallback(() => { setMessage(takeFlash()); }, []));
  if (!profile) return <AccountUnavailable />;

  return (
    <Screen>
        <AccountHeader title="My account" onBack={() => {
          if (navigation.canGoBack()) navigation.goBack();
          else navigation.navigate("MoreHome");
        }} />
      <ContentScrollView contentContainerStyle={{ padding: space.lg, paddingTop: space.xs, paddingBottom: Math.max(insets.bottom, space.lg) + space.lg, gap: space.md }}>
        {flash ? <View accessibilityLiveRegion="polite"><Callout>{flash}</Callout></View> : null}
        <SubpageCard tone="mint" style={{ flexDirection: stacked ? "column" : "row", alignItems: stacked ? "stretch" : "center", gap: space.lg }}>
          <View style={{ width: avatarSize, height: avatarSize, flexShrink: 0, borderRadius: radius.full, backgroundColor: t.brandSolid, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
            {profile.avatarUrl ? (
              <Image source={{ uri: profile.avatarUrl }} style={{ width: "100%", height: "100%" }} accessible accessibilityRole="image" accessibilityLabel="Profile photo" accessibilityIgnoresInvertColors />
            ) : <T style={{ fontSize: typeScale.titleLg, fontFamily: font.displayBold, color: t.onBrandSolid }}>{initialsOf(profile)}</T>}
          </View>
          <View style={{ flex: stacked ? undefined : 1, minWidth: 0, gap: space.xs }}>
            <T variant="title" style={{ color: t.textPrimary }}>{`${profile.firstName} ${profile.lastName}`.trim()}</T>
            <T style={{ color: t.textSecondary, fontSize: typeScale.bodySm, marginBottom: space.sm }}>{profile.email}</T>
            <Button title="Edit profile" variant="secondary" onPress={() => navigation.navigate("EditProfile")} style={{ borderColor: t.brandText }} />
          </View>
        </SubpageCard>
        <SubpageCard title="Personal details" icon="person-outline">
          <ContactRow label="First name" value={profile.firstName} divider />
          <ContactRow label="Last name" value={profile.lastName} divider />
          <ContactRow label="Phone number" value={profile.phoneNumber || "Not added"} />
        </SubpageCard>
        <SubpageCard title="Sign-in & security" icon="lock-closed-outline">
          <View style={{ gap: space.xs, paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: t.border }}>
            <T style={{ color: t.textPrimary }}>Sign-in email</T>
            <T selectable style={{ fontSize: typeScale.bodySm }}>{profile.email}</T>
            <T variant="caption">Your sign-in email cannot be changed here.</T>
          </View>
          <AccountAction icon="lock-closed-outline" label="Change password" detail="Update your sign-in password" onPress={() => navigation.navigate("ChangePassword")} />
        </SubpageCard>
        <SubpageCard title="Account management" icon="trash-outline" tone="danger">
          <AccountAction icon="trash-outline" label="Delete account" detail="Permanently remove your account and data" destructive onPress={() => navigation.navigate("DeleteAccount")} />
        </SubpageCard>
      </ContentScrollView>
    </Screen>
  );
}

function AccountForm({ title, onBack, busy, cancel, children, footer }: {
  title: string;
  onBack: () => void;
  busy: boolean;
  cancel?: boolean;
  children: ReactNode;
  footer: ReactNode;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Screen>
      <AccountHeader title={title} onBack={onBack} disabled={busy} cancel={cancel} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ContentScrollView contentContainerStyle={{ padding: space.xl, paddingTop: space.xxl, paddingBottom: space.xxl }}>
          {children}
        </ContentScrollView>
        <View style={{ backgroundColor: t.surface, borderTopWidth: 1, borderTopColor: t.border, paddingHorizontal: space.xl, paddingTop: space.md, paddingBottom: Math.max(insets.bottom, space.md) }}>
          <View style={{ width: "100%", maxWidth: CONTENT_WIDTH, alignSelf: "center" }}>{footer}</View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function useAccountGuard(navigation: Pick<AccountNavigation, "dispatch">, busy: boolean, dirty: boolean) {
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

function useCurrentAccount() {
  const { profile } = useAuth();
  const ownerId = useRef(profile?.id);
  const currentId = useRef(profile?.id);
  const mounted = useRef(true);
  currentId.current = profile?.id;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return () => mounted.current && ownerId.current !== undefined && currentId.current === ownerId.current;
}

export function EditProfileScreen({ navigation }: MoreScreenProps<"EditProfile">) {
  const t = useTheme();
  const { profile, updateProfile, setProfileFromServer } = useAuth();
  const [form, setForm] = useState<ProfileDraft>({ firstName: profile?.firstName ?? "", lastName: profile?.lastName ?? "", phoneNumber: profile?.phoneNumber ?? "" });
  const initial = useRef(form);
  const [errors, setErrors] = useState<FieldErrors<ProfileField>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoSaved, setPhotoSaved] = useState(false);
  const request = useRef(false);
  const uploading = useRef(false);
  const current = useCurrentAccount();
  const firstRef = useRef<TextInput>(null);
  const lastRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  const saved = useAccountGuard(navigation, busy || photoBusy, JSON.stringify(form) !== JSON.stringify(initial.current));

  const set = (key: ProfileField) => (value: string) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => ({ ...previous, [key]: undefined }));
    setError(null);
  };

  async function saveProfile() {
    if (request.current || uploading.current || !current()) return;
    const invalid: FieldErrors<ProfileField> = {};
    for (const field of ["firstName", "lastName"] as const) {
      if (!form[field].trim()) invalid[field] = `Enter your ${field === "firstName" ? "first" : "last"} name.`;
      else if (form[field].trim().length > MAX_NAME_LENGTH) invalid[field] = `Keep this under ${MAX_NAME_LENGTH} characters.`;
    }
    const phoneError = phoneNumberError(form.phoneNumber);
    if (phoneError) invalid.phoneNumber = phoneError;
    setErrors(invalid);
    setError(null);
    if (!isValid(invalid)) {
      haptics.failed();
      (invalid.firstName ? firstRef : invalid.lastName ? lastRef : phoneRef).current?.focus();
      return;
    }
    request.current = true;
    setBusy(true);
    try {
      await updateProfile({ firstName: form.firstName.trim(), lastName: form.lastName.trim(), phoneNumber: form.phoneNumber.trim() || null });
      if (!current()) return;
      saved.current = true;
      setFlash("Profile changes saved.");
      haptics.succeeded();
      returnToAccount(navigation);
    } catch (err) {
      if (!current()) return;
      setErrors(getFieldErrors(err));
      setError(errorMessage(err));
      haptics.failed();
    } finally {
      request.current = false;
      if (current()) setBusy(false);
    }
  }

  if (!profile || !current()) return <AccountUnavailable />;
  return (
    <AccountForm title="Edit profile" onBack={() => returnToAccount(navigation)} busy={busy || photoBusy} cancel footer={<Button title="Save changes" variant="primary" loading={busy} disabled={photoBusy} onPress={() => void saveProfile()} />}>
      <T variant="titleLg" accessibilityRole="header" style={{ color: t.textPrimary, marginBottom: space.sm }}>Your profile details</T>
      <T style={{ marginBottom: space.xl }}>Update your name and phone number.</T>
      <PhotoUpload url={profile.avatarUrl} endpoint="/auth/me/avatar" label="Profile photo" appearance="account" initials={initialsOf(profile)} disabled={busy}
        onBusyChange={(value) => { uploading.current = value; if (current()) setPhotoBusy(value); }}
        onUploaded={(updated) => {
          if (!current()) return;
          setProfileFromServer(updated as Profile);
          setPhotoSaved(true);
          haptics.succeeded();
        }} />
      <T variant="caption" style={{ marginBottom: space.xxl }}>Photo changes save after upload.</T>
      {photoSaved ? <View accessibilityLiveRegion="polite" style={{ marginBottom: space.lg }}><Callout>Profile photo updated.</Callout></View> : null}
      <Field ref={firstRef} label="First name" value={form.firstName} onChangeText={set("firstName")} maxLength={MAX_NAME_LENGTH} error={errors.firstName} editable={!busy} autoComplete="given-name" placeholder="Your first name" returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => lastRef.current?.focus()} />
      <Field ref={lastRef} label="Last name" value={form.lastName} onChangeText={set("lastName")} maxLength={MAX_NAME_LENGTH} error={errors.lastName} editable={!busy} autoComplete="family-name" placeholder="Your last name" returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => phoneRef.current?.focus()} />
      <Field ref={phoneRef} label="Phone number (optional)" value={form.phoneNumber} onChangeText={(value) => set("phoneNumber")(digitsOnly(value))} maxLength={MAX_PHONE_LENGTH} error={errors.phoneNumber} editable={!busy} keyboardType="phone-pad" autoComplete="tel" placeholder="09XXXXXXXXX" returnKeyType="done" onSubmitEditing={() => void saveProfile()} />
      <View style={{ marginTop: space.sm, flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: space.lg, backgroundColor: t.surfaceMuted, borderRadius: radius.md }}>
        <Ionicons name="lock-closed-outline" size={22} color={t.textSecondary} accessibilityElementsHidden importantForAccessibility="no" />
        <View style={{ flex: 1, gap: space.xs }}><T variant="label">Sign-in email</T><T selectable style={{ color: t.textPrimary }}>{profile.email}</T><T variant="caption">Your sign-in email cannot be changed here.</T></View>
      </View>
      {error ? <View style={{ marginTop: space.lg }}><ErrorNote>{error}</ErrorNote></View> : null}
    </AccountForm>
  );
}

export function ChangePasswordScreen({ navigation }: MoreScreenProps<"ChangePassword">) {
  const t = useTheme();
  const { profile, changePassword } = useAuth();
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [errors, setErrors] = useState<FieldErrors<ChangePasswordField>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(false);
  const current = useCurrentAccount();
  const currentRef = useRef<TextInput>(null);
  const nextRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);
  const saved = useAccountGuard(navigation, busy, Object.values(form).some(Boolean));
  const set = (key: ChangePasswordField) => (value: string) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => ({ ...previous, [key]: undefined }));
    setError(null);
  };

  async function submit() {
    if (request.current || !current()) return;
    const invalid = validateChangePassword(form);
    setErrors(invalid);
    setError(null);
    if (!isValid(invalid)) {
      haptics.failed();
      (invalid.currentPassword ? currentRef : invalid.newPassword ? nextRef : confirmRef).current?.focus();
      return;
    }
    request.current = true;
    setBusy(true);
    try {
      await changePassword(form.currentPassword, form.newPassword);
      if (!current()) return;
      saved.current = true;
      setForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setFlash("Password changed. You're still signed in here. Other devices will need to sign in again after their current access expires.");
      haptics.succeeded();
      returnToAccount(navigation);
    } catch (err) {
      if (!current()) return;
      const fromServer = getFieldErrors(err);
      setErrors(fromServer);
      setError(isValid(fromServer) ? errorMessage(err) : null);
      haptics.failed();
    } finally {
      request.current = false;
      if (current()) setBusy(false);
    }
  }

  if (!profile || !current()) return <AccountUnavailable />;
  return (
    <AccountForm title="Change password" onBack={() => returnToAccount(navigation)} busy={busy} footer={<Button title="Update password" variant="primary" loading={busy} onPress={() => void submit()} />}>
      <View style={{ width: 56, height: 56, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: t.brandSurface, marginBottom: space.lg }}><Ionicons name="lock-closed-outline" size={30} color={t.brandText} accessibilityElementsHidden importantForAccessibility="no" /></View>
      <T variant="titleLg" accessibilityRole="header" style={{ color: t.textPrimary, marginBottom: space.sm }}>Choose a new password</T>
      <T style={{ marginBottom: space.xxl }}>You will stay signed in on this phone.</T>
      <Field ref={currentRef} label="Current password" value={form.currentPassword} onChangeText={set("currentPassword")} error={errors.currentPassword} editable={!busy} secureTextEntry autoComplete="password" placeholder="Enter current password" returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => nextRef.current?.focus()} />
      <Field ref={nextRef} label="New password" value={form.newPassword} onChangeText={set("newPassword")} error={errors.newPassword} editable={!busy} secureTextEntry autoComplete="new-password" placeholder="Enter new password" returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => confirmRef.current?.focus()} />
      <T variant="caption" style={{ marginTop: -space.xs, marginBottom: space.xl }}>{`Use at least ${MIN_PASSWORD_LENGTH} characters.`}</T>
      <Field ref={confirmRef} label="Confirm new password" value={form.confirmPassword} onChangeText={set("confirmPassword")} error={errors.confirmPassword} editable={!busy} secureTextEntry autoComplete="new-password" placeholder="Enter new password again" returnKeyType="done" onSubmitEditing={() => void submit()} />
      <View style={{ marginTop: space.lg }}><Callout>Other devices will need to sign in again after their current access expires.</Callout></View>
      {error ? <View style={{ marginTop: space.lg }}><ErrorNote>{error}</ErrorNote></View> : null}
    </AccountForm>
  );
}

export function DeleteAccountScreen({ navigation }: MoreScreenProps<"DeleteAccount">) {
  const t = useTheme();
  const { profile, logout } = useAuth();
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(false);
  const confirmation = useRef(false);
  const current = useCurrentAccount();
  const passwordRef = useRef<TextInput>(null);
  useAccountGuard(navigation, busy, false);

  function confirmDeletion() {
    if (request.current || confirmation.current || !current()) return;
    setError(null);
    if (!password) {
      setPasswordError("Enter your current password before deleting the account.");
      passwordRef.current?.focus();
      haptics.failed();
      return;
    }
    const submittedPassword = password;
    const deletedOwnerId = profile!.id;
    confirmation.current = true;
    Alert.alert("Permanently delete account?", "Every business, record, receipt image, and import will be removed. This cannot be undone.", [
      { text: "Keep account", style: "cancel", onPress: () => { confirmation.current = false; } },
      { text: "Delete everything", style: "destructive", onPress: async () => {
        confirmation.current = false;
        if (request.current || !current()) return;
        request.current = true;
        setBusy(true);
        setError(null);
        try {
          await api.delete("/auth/me", { currentPassword: submittedPassword });
          // Confirmed deletion must finish even if device cleanup is unavailable.
          await clearManualRecordRecoveryForOwner(deletedOwnerId).catch(() => undefined);
          if (!current()) return;
          await logout();
        } catch (err) {
          if (!current()) return;
          setError(errorMessage(err));
          haptics.failed();
        } finally {
          request.current = false;
          if (current()) setBusy(false);
        }
      } },
    ], { cancelable: true, onDismiss: () => { confirmation.current = false; } });
  }

  if (!profile || !current()) return <AccountUnavailable />;
  return (
    <AccountForm title="Delete account" onBack={() => returnToAccount(navigation)} busy={busy} footer={<Button title="Delete my account" variant="danger" loading={busy} onPress={confirmDeletion} />}>
      <T variant="titleLg" accessibilityRole="header" style={{ color: t.textPrimary, marginBottom: space.md }}>Delete your account?</T>
      <T style={{ marginBottom: space.xl }}>This permanently removes every business, record, receipt image, import, and sign-in credential.</T>
      <Callout tone="warn">This cannot be undone. Keep any records you need before continuing.</Callout>
      <View style={{ marginTop: space.xxl }}>
        <Field ref={passwordRef} label="Current password" value={password} onChangeText={(value) => { setPassword(value); setPasswordError(null); setError(null); }} error={passwordError} editable={!busy} secureTextEntry autoComplete="password" placeholder="Enter current password" returnKeyType="done" onSubmitEditing={confirmDeletion} />
      </View>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </AccountForm>
  );
}
