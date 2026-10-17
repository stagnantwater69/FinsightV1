import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert as RNAlert, Image, Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, Callout, Card, ConfirmSheet, EmptyState, ErrorNote, Field, Money, Screen, T } from "../components/ui";
import { PhotoUpload } from "../components/PhotoUpload";
import { ContentScrollView } from "../components/ContentScrollView";
import { SubpageCard, SubpageHeader, SubpageIcon } from "../components/SubpageKit";
import { FormScreen } from "../components/FormScreen";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api, errorMessage } from "../lib/api";
import * as haptics from "../lib/haptics";
import { font, radius, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "../components/touchTarget";
import { useTheme } from "../context/ThemeContext";
import type { BusinessProfile, FinancialPosition } from "../lib/types";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { availableFundsProvenance, latestCompletableMonth, monthlyExpenseBasisProvenance } from "../lib/financialPosition";
import { formatMonthLabel, shiftMonthKey } from "../lib/monthEndReview";
import { useInsight } from "../lib/useInsight";
import {
  EMPTY_DRAFT,
  applyFieldUpdate,
  draftFromProfile,
  hasErrors,
  thresholdDisplayValue,
  toBusinessProfileInput,
  validateDraft,
  type BusinessProfileDraft,
  type BusinessFieldErrors,
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
  const insets = useSafeAreaInsets();
  const [detailsId, setDetailsId] = useState<number | null>(null);
  const { profiles, selected, selectProfile, loading, error: profilesError, refresh, archiveProfile, restoreProfile, listArchived } =
    useBusinessProfiles();
  const [archived, setArchived] = useState<BusinessProfile[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archivedRequest = useRef(0);
  const archivedPending = useRef<object | null>(null);
  const profileMutation = useRef(false);

  useEffect(() => () => { archivedRequest.current += 1; }, []);

  const loadArchived = useCallback(async () => {
    if (archivedPending.current) return;
    const pending = {};
    archivedPending.current = pending;
    const request = ++archivedRequest.current;
    setError(null);
    setArchivedLoading(true);
    try {
      const rows = await listArchived();
      if (request === archivedRequest.current) setArchived(rows);
    } catch (err) {
      if (request === archivedRequest.current) setError(errorMessage(err));
    } finally {
      if (archivedPending.current === pending) archivedPending.current = null;
      if (request === archivedRequest.current) setArchivedLoading(false);
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
            if (profileMutation.current) return;
            profileMutation.current = true;
            setError(null);
            setBusyId(p.id);
            try {
              await archiveProfile(p.id);
              if (archived) await loadArchived();
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              profileMutation.current = false;
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
        <Pressable accessibilityRole="button" accessibilityLabel="Show archived businesses" accessibilityState={{ disabled: busyId !== null || archivedLoading, busy: archivedLoading }} disabled={busyId !== null || archivedLoading} onPress={loadArchived} style={({ pressed }) => ({ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", gap: space.md, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: radius.lg, padding: space.lg, opacity: pressed ? 0.7 : 1 })}>
          <SubpageIcon name="archive-outline" />
          <T style={{ flex: 1, color: t.textSecondary, fontSize: typeScale.body }}>Archived businesses</T>
          {archivedLoading ? <ActivityIndicator color={t.brandText} /> : <Ionicons name="chevron-forward" size={20} color={t.textMuted} accessible={false} />}
        </Pressable>
      ) : (
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, marginBottom: space.md }}>
            <T variant="heading" accessibilityRole="header" style={{ flex: 1 }}>Archived businesses</T>
            <Pressable
              onPress={() => {
                archivedRequest.current += 1;
                archivedPending.current = null;
                setArchivedLoading(false);
                setArchived(null);
              }}
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
          {archivedLoading ? <ActivityIndicator accessibilityLabel="Loading archived businesses" color={t.brandText} style={{ marginBottom: space.md }} /> : null}
          {archived.length === 0 && !archivedLoading ? (
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
                  accessibilityLabel={`Restore ${p.name}`}
                  variant="secondary"
                  disabled={busyId !== null || archivedLoading}
                  loading={busyId === p.id}
                  onPress={async () => {
                    if (profileMutation.current) return;
                    profileMutation.current = true;
                    setError(null);
                    setBusyId(p.id);
                    try {
                      await restoreProfile(p.id);
                      await loadArchived();
                    } catch (err) {
                      setError(errorMessage(err));
                    } finally {
                      profileMutation.current = false;
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

  const currentProfile = profiles.find((p) => p.id === selected?.id);
  const otherProfiles = profiles.filter((p) => p.id !== selected?.id);
  const detailsProfile = profiles.find((p) => p.id === detailsId);
  const editProfile = (p: BusinessProfile) => {
    setDetailsId(null);
    navigation.navigate("BusinessProfileForm", { profile: p });
  };

  return (
    <Screen>
      <SubpageHeader title="Businesses" onBack={() => {
        if (navigation.canGoBack?.() !== false && navigation.goBack) navigation.goBack();
        else navigation.navigate("MoreHome");
      }} />
      <ContentScrollView contentContainerStyle={{ padding: space.lg, paddingTop: space.xs, paddingBottom: Math.max(insets.bottom, space.lg) + space.lg }}>
        <T style={{ color: t.textSecondary, fontSize: typeScale.bodySm, marginBottom: space.md }}>Choose which business you’re working on.</T>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {profilesError ? (
          <View style={{ gap: space.sm, marginBottom: space.md }}>
            <ErrorNote>{profilesError}</ErrorNote>
            <Button title="Retry businesses" variant="secondary" loading={loading} onPress={() => { refresh().catch((err) => setError(errorMessage(err))); }} />
          </View>
        ) : null}
        {loading ? <ActivityIndicator accessibilityLabel="Loading businesses" color={t.brandText} style={{ marginVertical: space.xl }} /> : profiles.length === 0 ? (
          profilesError ? null : <EmptyState title="Let's set up your first business" body="Add a business profile to start tracking its funds, expenses and sales." action={<Button title="Create a business profile" variant="brand" onPress={() => navigation.navigate("BusinessProfileForm", {})} />} />
        ) : (
          <View style={{ gap: space.md }}>
            {currentProfile ? (
              <View>
                <View style={{ backgroundColor: t.brandSolid, borderRadius: radius.lg, padding: space.lg, gap: space.lg }}>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: space.sm }}>
                    <T style={{ color: t.onBrandSolidMuted, fontFamily: font.sansMedium, fontSize: typeScale.label }}>Current business</T>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.full, backgroundColor: t.onBrandSolidMuted }}>
                      <Ionicons name="checkmark" size={17} color={t.brandSolidPressed} accessible={false} />
                      <T style={{ color: t.brandSolidPressed, fontFamily: font.sansSemibold, fontSize: typeScale.label }}>Active</T>
                    </View>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                    <BusinessIdentityImage profile={currentProfile} current />
                    <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
                      <T accessibilityRole="header" style={{ color: t.onBrandSolid, fontFamily: font.sansSemibold, fontSize: typeScale.subpageTitle, lineHeight: 29 }}>{currentProfile.name}</T>
                      <T style={{ color: t.onBrandSolidMuted, fontSize: typeScale.body, lineHeight: 22 }}>{currentProfile.type}</T>
                    </View>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm, paddingTop: space.md, borderTopWidth: 1, borderTopColor: t.onBrandSolidMuted + "50" }}>
                    <Pressable accessibilityRole="button" accessibilityLabel={`Starting details: ${currentProfile.name}`} onPress={() => setDetailsId(currentProfile.id)} style={({ pressed }) => ({ flexGrow: 1, maxWidth: "100%", minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", gap: space.sm, opacity: pressed ? 0.7 : 1 })}>
                      <Ionicons name="chevron-down" size={20} color={t.onBrandSolid} accessible={false} />
                      <T style={{ flexShrink: 1, color: t.onBrandSolid, fontFamily: font.sansMedium, fontSize: typeScale.bodySm }}>Starting details</T>
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${currentProfile.name}`} disabled={busyId !== null} onPress={() => editProfile(currentProfile)} style={({ pressed }) => ({ maxWidth: "100%", minHeight: TAP_FLOOR, paddingHorizontal: space.md, paddingVertical: space.sm, borderWidth: 1, borderColor: t.onBrandSolidMuted, borderRadius: radius.md, flexDirection: "row", alignItems: "center", gap: space.sm, opacity: busyId !== null ? 0.5 : pressed ? 0.7 : 1 })}>
                      <Ionicons name="create-outline" size={18} color={t.onBrandSolid} accessible={false} />
                      <T style={{ flexShrink: 1, color: t.onBrandSolid, fontFamily: font.sansMedium, fontSize: typeScale.bodySm }}>Edit business</T>
                    </Pressable>
                  </View>
                </View>
              </View>
            ) : null}
            {otherProfiles.length > 0 ? (
              <SubpageCard title="Other businesses" icon="storefront-outline">
                  {otherProfiles.map((p, index) => (
                    <View key={p.id} style={{ gap: space.md, paddingTop: index ? space.lg : 0, paddingBottom: space.md, borderTopWidth: index ? 1 : 0, borderTopColor: t.border }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                      <BusinessIdentityImage profile={p} />
                      <View style={{ flex: 1, gap: space.xs }}>
                        <T accessibilityRole="header" style={{ color: t.textPrimary, fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg, lineHeight: 23 }}>{p.name}</T>
                        <T variant="caption">{p.type}</T>
                      </View>
                      </View>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                      <Pressable accessibilityRole="button" accessibilityLabel={`Switch to ${p.name}`} accessibilityState={{ disabled: busyId !== null }} disabled={busyId !== null} onPress={() => { setError(null); try { selectProfile(p.id); } catch (err) { setError(errorMessage(err)); } }} style={({ pressed }) => ({ flexGrow: 1, flexBasis: 120, minHeight: TAP_FLOOR, minWidth: TAP_FLOOR, paddingHorizontal: space.sm, paddingVertical: space.sm, borderWidth: 1, borderColor: t.brandText, borderRadius: radius.sm, justifyContent: "center", alignItems: "center", opacity: busyId !== null ? 0.5 : pressed ? 0.7 : 1 })}>
                        <T style={{ color: t.brandText, fontFamily: font.sansMedium, fontSize: typeScale.bodySm }}>Switch</T>
                      </Pressable>
                      <Button title="Details" accessibilityLabel={`Details for ${p.name}`} variant="secondary" onPress={() => setDetailsId(p.id)} style={{ flexGrow: 1, flexBasis: 120, borderRadius: radius.sm, borderColor: t.brandText }} />
                      </View>
                    </View>
                  ))}
              </SubpageCard>
            ) : null}
            <Pressable accessibilityRole="button" accessibilityLabel="Add another business" accessibilityState={{ disabled: busyId !== null }} disabled={busyId !== null} onPress={() => navigation.navigate("BusinessProfileForm", {})} style={({ pressed }) => ({ minHeight: TAP_FLOOR, padding: space.md, borderRadius: radius.md, backgroundColor: t.ACCENT.fill, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, opacity: busyId !== null ? 0.5 : pressed ? 0.8 : 1 })}>
              <Ionicons name="add" size={24} color={t.ACCENT.onFill} accessible={false} /><T style={{ flexShrink: 1, textAlign: "center", color: t.ACCENT.onFill, fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg }}>Add business</T>
            </Pressable>
            <T variant="caption">Your records stay separate for each business.</T>
          </View>
        )}
        {archivedPanel}
        {archived === null ? <T style={{ color: t.textSecondary, fontSize: typeScale.bodySm, lineHeight: 22, marginTop: space.sm }}>Archived businesses keep their records.</T> : null}
      </ContentScrollView>
      <Modal visible={!!detailsProfile} transparent animationType="slide" onRequestClose={() => setDetailsId(null)} statusBarTranslucent>
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: t.scrim }}>
          <Pressable accessible={false} importantForAccessibility="no-hide-descendants" onPress={() => setDetailsId(null)} style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }} />
          <View accessibilityViewIsModal style={{ width: "100%", maxWidth: 720, alignSelf: "center", maxHeight: "85%", backgroundColor: t.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingBottom: insets.bottom }}>
            <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <T accessibilityRole="header" style={{ flex: 1, color: t.brandHeading, fontFamily: font.sansSemibold, fontSize: typeScale.title, lineHeight: 26 }}>Starting details</T>
                <Pressable accessibilityRole="button" accessibilityLabel="Close business details" onPress={() => setDetailsId(null)} style={{ minHeight: TAP_FLOOR, minWidth: TAP_FLOOR, alignItems: "center", justifyContent: "center" }}><Ionicons name="close" size={22} color={t.textSecondary} accessible={false} /></Pressable>
              </View>
              {detailsProfile ? (
                <>
                  <View style={{ gap: space.xs }}><T style={{ color: t.textPrimary, fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg }}>{detailsProfile.name}</T><T variant="caption">{detailsProfile.type}</T></View>
                  <T style={{ color: t.textSecondary, fontSize: typeScale.bodySm, lineHeight: 22 }}>These are your starting figures and record coverage, not current funds or profit.</T>
                  <View style={{ gap: space.md }}>
                    <RowLine label="Starting funds" value={detailsProfile.availableFunds} />
                    <RowLine label="Starting monthly estimate" value={detailsProfile.expectedMonthlyExpenses} />
                    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md }}><T variant="caption" style={{ flex: 1 }}>Operating days / month</T><T style={{ fontSize: typeScale.label }}>{detailsProfile.operatingDays}</T></View>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md }}><T variant="caption" style={{ flex: 1 }}>Expense records complete through</T><T style={{ flexShrink: 1, textAlign: "right", fontSize: typeScale.label }}>{detailsProfile.expenseRecordsCompleteThroughMonth ? formatMonthLabel(detailsProfile.expenseRecordsCompleteThroughMonth) : "Not confirmed"}</T></View>
                  </View>
                  <Button title="Edit business" accessibilityLabel={`Edit ${detailsProfile.name}`} variant="secondary" disabled={busyId !== null} onPress={() => editProfile(detailsProfile)} />
                  <Button title="Archive business" accessibilityLabel={`Archive ${detailsProfile.name}`} variant="secondary" disabled={busyId !== null} onPress={() => { setDetailsId(null); confirmArchive(detailsProfile); }} loading={busyId === detailsProfile.id} />
                </>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

function BusinessIdentityImage({ profile, current = false }: { profile: Pick<BusinessProfile, "id" | "name" | "logoUrl">; current?: boolean }) {
  const t = useTheme();
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const [loadedImage, setLoadedImage] = useState<string | null>(null);
  const uri = profile.logoUrl?.trim();
  const imageKey = `${profile.id}:${uri}`;
  const size = current ? 68 : 48;
  return (
    <View style={{ width: size, height: size, flexShrink: 0, overflow: "hidden", borderRadius: current ? radius.lg : radius.full, backgroundColor: current ? t.onBrandSolid + "15" : t.brandSurface, alignItems: "center", justifyContent: "center" }}>
      {!uri || failedImage === imageKey || loadedImage !== imageKey ? <Ionicons name="storefront-outline" size={current ? 32 : 25} color={current ? t.onBrandSolidMuted : t.brandText} accessible={false} /> : null}
      {uri && failedImage !== imageKey ? (
        <Image key={imageKey} accessible accessibilityRole="image" accessibilityLabel={`${profile.name} business photo`} source={{ uri }} resizeMode="cover" onLoad={() => setLoadedImage(imageKey)} onError={() => setFailedImage(imageKey)} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }} />
      ) : null}
    </View>
  );
}

function RowLine({ label, value }: { label: string; value: number }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md }}>
      <T variant="caption" style={{ flex: 1 }}>{label}</T>
      <Money value={value} decimals size={typeScale.bodySm} style={{ flexShrink: 1, textAlign: "right" }} />
    </View>
  );
}

// ---------------------------------------------------------------- Create / edit

export function BusinessProfileFormScreen({ navigation, route }: any) {
  const existing: BusinessProfile | undefined = route.params?.profile;
  const { createProfile, updateProfile, refresh } = useBusinessProfiles();
  const [form, setForm] = useState<BusinessProfileDraft>(() =>
    existing ? draftFromProfile(existing) : { ...EMPTY_DRAFT, type: "Sari-sari store" },
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [fieldErrors, setFieldErrors] = useState<BusinessFieldErrors>({});
  // The logo is uploaded on its own, immediately, rather than travelling with
  // the form — so it is held apart from the fields Save writes.
  const [logoUrl, setLogoUrl] = useState<string | null>(existing?.logoUrl ?? null);
  // Through applyFieldUpdate rather than a bare spread: the threshold field
  // carries a touched flag that has to be set with it. See businessProfileDraft.ts.
  const set = (k: BusinessTextField) => (v: string) => {
    setForm((f) => applyFieldUpdate(f, k, v));
    setFieldErrors((errors) => ({ ...errors, [k]: undefined }));
  };
  // One ref per field the return key hands off TO — the first field is never a
  // destination, so it needs none.
  const typeRef = useRef<TextInput>(null);
  const nameRef = useRef<TextInput>(null);
  const fundsRef = useRef<TextInput>(null);
  const monthlyRef = useRef<TextInput>(null);
  const operatingDaysRef = useRef<TextInput>(null);
  const thresholdRef = useRef<TextInput>(null);

  async function submit() {
    if (submitting.current) return;
    /*
     * The rules live in lib/businessProfileDraft.ts so this screen, the setup
     * wizard and the web's form all reject the same things for the same
     * reasons — a rule enforced in one place and not the others is how the
     * same figure comes to be accepted on a phone and refused on a laptop.
     */
    const errors = validateDraft(form);
    setFieldErrors(errors);
    if (hasErrors(errors)) {
      const firstField = errors.name ? nameRef : errors.type ? typeRef : errors.availableFunds ? fundsRef : errors.expectedMonthlyExpenses ? monthlyRef : errors.operatingDays ? operatingDaysRef : thresholdRef;
      firstField.current?.focus();
      return setError(Object.values(errors).find(Boolean) ?? "Please check the fields above.");
    }
    const payload = toBusinessProfileInput(form);

    submitting.current = true;
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
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <FormScreen>
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
                onUploaded={(updated) => {
                  setLogoUrl((updated as BusinessProfile).logoUrl);
                  refresh().catch((err) => setError(errorMessage(err)));
                }}
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
              ref={nameRef}
              label="Business name"
              error={fieldErrors.name}
              editable={!busy}
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
              error={fieldErrors.type}
              editable={!busy}
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
              error={fieldErrors.availableFunds}
              editable={!busy}
              label="Starting available funds (PHP)"
              value={form.availableFunds}
              onChangeText={set("availableFunds")}
              keyboardType="decimal-pad"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => monthlyRef.current?.focus()}
            />
            <T variant="caption" style={{ marginTop: -space.sm, marginBottom: space.md }}>
              {existing
                ? "Changing this amount starts the calculation again from the day you save."
                : "The cash this business has to work with when tracking starts."}
            </T>
            <Field
              ref={monthlyRef}
              error={fieldErrors.expectedMonthlyExpenses}
              editable={!busy}
              label="Starting monthly expense estimate (PHP)"
              value={form.expectedMonthlyExpenses}
              onChangeText={set("expectedMonthlyExpenses")}
              keyboardType="decimal-pad"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => operatingDaysRef.current?.focus()}
            />
            <T variant="caption" style={{ marginTop: -space.sm, marginBottom: space.md }}>
              Used only until you confirm a complete past month of expense records.
            </T>
            <Field
              ref={operatingDaysRef}
              error={fieldErrors.operatingDays}
              editable={!busy}
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
              error={fieldErrors.largeExpenseThresholdPesos}
              editable={!busy}
              label="Flag single expenses over (PHP), optional"
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
              slip past. Suggested from your starting monthly estimate. Change it anytime.
            </T>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button title={existing ? "Save changes" : "Create business"} variant="primary" onPress={submit} loading={busy} style={{ marginTop: space.md }} />
          </Card>

          {existing ? (
            <FinancialPositionCard
              businessProfileId={existing.id}
              onProfileRefresh={refresh}
            />
          ) : null}

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
                onPress={() => navigation.navigate("OperatingSchedule", { businessProfileId: existing.id, from: undefined })}
              />
            </Card>
          ) : null}
    </FormScreen>
  );
}

type CompletenessAction = "confirm" | "clear";

/**
 * Shows the server-owned current figures and lets an owner assert the latest
 * month whose expense records are complete. The client selects a month only;
 * it never recomputes either financial amount.
 */
function FinancialPositionCard({
  businessProfileId,
  onProfileRefresh,
}: {
  businessProfileId: number;
  onProfileRefresh: () => Promise<void>;
}) {
  const t = useTheme();
  const positionState = useInsight<FinancialPosition>(
    `/business-profiles/${businessProfileId}/financial-position`,
    {},
    [businessProfileId],
  );
  const [returnedPosition, setReturnedPosition] = useState<{
    businessProfileId: number;
    value: FinancialPosition;
    queryUpdatedAtBeforeSave: number | null;
  } | null>(null);
  const position =
    returnedPosition?.businessProfileId === businessProfileId
      ? returnedPosition.value
      : positionState.data;
  const maxMonth = position ? latestCompletableMonth(position.asOfDate) : "";
  const completeThrough = position?.monthlyExpenseBasis.recordsCompleteThroughMonth ?? null;
  const [selectedMonth, setSelectedMonth] = useState("");
  const [action, setAction] = useState<CompletenessAction | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const active = useRef(true);
  const savingRequest = useRef(false);

  useEffect(() => () => {
    active.current = false;
  }, []);

  useEffect(() => {
    if (
      returnedPosition?.businessProfileId === businessProfileId &&
      positionState.data &&
      positionState.lastUpdatedAt !== returnedPosition.queryUpdatedAtBeforeSave
    ) {
      setReturnedPosition(null);
    }
  }, [businessProfileId, positionState.data, positionState.lastUpdatedAt, returnedPosition]);

  useEffect(() => {
    if (!position || !maxMonth) return;
    setSelectedMonth(completeThrough ?? maxMonth);
  }, [businessProfileId, completeThrough, maxMonth, position]);

  async function saveCompleteness() {
    if (!action || !position || savingRequest.current) return;
    savingRequest.current = true;
    const nextMonth = action === "confirm" ? selectedMonth : null;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.put<FinancialPosition>(
        `/business-profiles/${businessProfileId}/expense-records-completeness`,
        { completeThroughMonth: nextMonth },
        { cacheScope: { businessProfileId } },
      );
      if (!active.current) return;
      setReturnedPosition({
        businessProfileId,
        value: updated,
        queryUpdatedAtBeforeSave: positionState.lastUpdatedAt,
      });
      setSavedMessage(
        nextMonth
          ? `Expense records confirmed complete through ${formatMonthLabel(nextMonth)}.`
          : "FinSight is using the starting monthly estimate again.",
      );
      setAction(null);
      haptics.succeeded();
      void onProfileRefresh().catch(() => undefined);
    } catch (err) {
      if (!active.current) return;
      setSaveError(errorMessage(err));
      haptics.failed();
    } finally {
      savingRequest.current = false;
      if (active.current) setSaving(false);
    }
  }

  const previousMonth = selectedMonth ? shiftMonthKey(selectedMonth, -1) : "";
  const nextMonth = selectedMonth ? shiftMonthKey(selectedMonth, 1) : "";
  const nextDisabled = !nextMonth || !maxMonth || nextMonth > maxMonth;
  const selectionChanged = Boolean(selectedMonth && selectedMonth !== completeThrough);

  return (
    <>
      <Card style={{ marginTop: space.lg }}>
        <T variant="title" accessibilityRole="header" style={{ marginBottom: 4 }}>
          Financial position
        </T>
        <T variant="caption" style={{ marginBottom: space.md }}>
          Current figures calculated from your starting values and confirmed records.
        </T>

        {positionState.loading && !position ? <T variant="caption">Loading financial position…</T> : null}
        {positionState.error && !position ? (
          <View style={{ gap: space.sm }}>
            <ErrorNote>{positionState.error}</ErrorNote>
            <Button title="Retry" variant="secondary" onPress={() => void positionState.load()} />
          </View>
        ) : null}

        {position ? (
          <>
            {positionState.error ? <ErrorNote>Showing the last result. Refresh failed: {positionState.error}</ErrorNote> : null}
            <T variant="label" style={{ color: t.ink[700] }}>Recorded available funds</T>
            <Money value={position.availableFunds.calculatedAmount} size={24} weight="semibold" style={{ marginTop: 2 }} />
            <T variant="caption" style={{ marginTop: 4, lineHeight: 18 }}>
              {availableFundsProvenance(position.availableFunds)}
            </T>

            <View style={{ height: 1, backgroundColor: t.border, marginVertical: space.lg }} />

            <T variant="label" style={{ color: t.ink[700] }}>Monthly expense basis</T>
            <Money value={position.monthlyExpenseBasis.amount} size={20} weight="semibold" style={{ marginTop: 2 }} />
            <T variant="caption" style={{ marginTop: 4, lineHeight: 18 }}>
              {monthlyExpenseBasisProvenance(position.monthlyExpenseBasis)}
            </T>

            <View style={{ height: 1, backgroundColor: t.border, marginVertical: space.lg }} />

            <T variant="heading" accessibilityRole="header" style={{ marginBottom: 4 }}>
              Expense record coverage
            </T>
            <T variant="caption" style={{ marginBottom: space.md, lineHeight: 18 }}>
              Confirm a month only when every business expense through its end is recorded and reviewed. FinSight will
              use the latest complete month instead of your starting estimate.
            </T>

            <T variant="label" style={{ marginBottom: 4, color: t.ink[700] }}>Complete through</T>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                backgroundColor: t.surfaceMuted,
                borderRadius: radius.md,
                paddingHorizontal: space.sm,
              }}
            >
              <Pressable
                onPress={() => {
                  haptics.tapped();
                  setSelectedMonth(previousMonth);
                  setSavedMessage(null);
                }}
                accessibilityRole="button"
                accessibilityLabel={`Choose previous month, ${formatMonthLabel(previousMonth)}`}
                style={{ minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, alignItems: "center", justifyContent: "center" }}
              >
                <Ionicons name="chevron-back" size={20} color={t.textPrimary} />
              </Pressable>
              <T style={{ flex: 1, textAlign: "center", fontFamily: font.sansSemibold, fontSize: typeScale.body }}>
                {formatMonthLabel(selectedMonth)}
              </T>
              <Pressable
                disabled={nextDisabled}
                onPress={() => {
                  haptics.tapped();
                  setSelectedMonth(nextMonth);
                  setSavedMessage(null);
                }}
                accessibilityRole="button"
                accessibilityLabel={nextMonth ? `Choose next month, ${formatMonthLabel(nextMonth)}` : "Choose next month"}
                accessibilityState={{ disabled: nextDisabled }}
                style={{
                  minWidth: TAP_FLOOR,
                  minHeight: TAP_FLOOR,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: nextDisabled ? 0.35 : 1,
                }}
              >
                <Ionicons name="chevron-forward" size={20} color={t.textPrimary} />
              </Pressable>
            </View>

            {savedMessage ? (
              <Callout tone="info">
                {savedMessage}
              </Callout>
            ) : null}

            <Button
              title="Confirm record coverage"
              variant="primary"
              onPress={() => {
                setSaveError(null);
                setAction("confirm");
              }}
              disabled={!selectionChanged || saving}
              style={{ marginTop: space.md }}
            />
            {completeThrough ? (
              <Button
                title="Use starting estimate again"
                variant="ghost"
                onPress={() => {
                  setSaveError(null);
                  setAction("clear");
                }}
                disabled={saving}
                style={{ marginTop: space.sm }}
              />
            ) : null}
          </>
        ) : null}
      </Card>

      <ConfirmSheet
        visible={action !== null}
        title={action === "clear" ? "Use the starting estimate again?" : `Complete through ${formatMonthLabel(selectedMonth)}?`}
        body={
          action === "clear"
            ? "FinSight will stop using the record-based monthly figure until you confirm a complete past month again. No records will be deleted."
            : `Confirm only if every business expense through ${formatMonthLabel(selectedMonth)} is in FinSight and reviewed.`
        }
        confirmLabel={action === "clear" ? "Use starting estimate" : "Confirm coverage"}
        cancelLabel="Cancel"
        busy={saving}
        error={saveError}
        onConfirm={() => void saveCompleteness()}
        onCancel={() => {
          if (!saving) {
            setAction(null);
            setSaveError(null);
          }
        }}
      />
    </>
  );
}

export { ProfileScreen } from "./AccountScreens";
