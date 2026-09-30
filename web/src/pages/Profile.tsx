import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  Building2,
  Camera,
  KeyRound,
  Mail,
  MonitorSmartphone,
  Pencil,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { getErrorMessage, getFieldErrors } from "../lib/errors";
import {
  isValid,
  validateChangePassword,
  validateProfileDetails,
  MIN_PASSWORD_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PHONE_LENGTH,
  type ChangePasswordField,
  type FieldErrors,
  type ProfileDetailsField,
} from "../lib/authValidation";
import { Callout, Card, PageHead } from "../components/ui";
import { Button, ButtonLink } from "../components/Button";
import {
  Field,
  FormError,
  TextInput,
  PasswordInput,
} from "../components/Field";
import { AvatarUpload } from "../components/Avatar";
import { useConfirm } from "../components/ConfirmDialog";
import { SkeletonPanel } from "../components/Skeleton";

export function Profile() {
  const { profile, updateProfile, uploadAvatar, logout, logoutEverywhere } =
    useAuth();
  const {
    profiles,
    loading: businessesLoading,
    error: businessesError,
  } = useBusinessProfiles();
  const [form, setForm] = useState({
    firstName: profile?.firstName ?? "",
    middleName: profile?.middleName ?? "",
    lastName: profile?.lastName ?? "",
    phoneNumber: profile?.phoneNumber ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [profileFieldErrors, setProfileFieldErrors] = useState<
    FieldErrors<ProfileDetailsField>
  >({});
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const profileFormRef = useRef<HTMLFormElement>(null);

  if (!profile) {
    return (
      <div>
        <PageHead
          title="My profile"
          subtitle="Manage your personal account details and sign-in security."
        />
        <div className="skeleton mb-6 h-24 rounded-2xl" aria-hidden />
        <div className="grid gap-6 lg:grid-cols-2">
          <SkeletonPanel lines={5} />
          <SkeletonPanel lines={5} />
        </div>
        <span className="sr-only" aria-live="polite">
          Loading your profile…
        </span>
      </div>
    );
  }

  const fullName = [profile.firstName, profile.middleName, profile.lastName]
    .filter(Boolean)
    .join(" ");
  const businessCount = profiles.length;

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
    setProfileFieldErrors((current) =>
      current[key as ProfileDetailsField]
        ? { ...current, [key]: undefined }
        : current,
    );
  }

  function beginEditing() {
    setForm({
      firstName: profile!.firstName,
      middleName: profile!.middleName ?? "",
      lastName: profile!.lastName,
      phoneNumber: profile!.phoneNumber ?? "",
    });
    setError(null);
    setSaved(false);
    setProfileFieldErrors({});
    setIsEditing(true);
  }

  function cancelEditing() {
    setError(null);
    setProfileFieldErrors({});
    setIsEditing(false);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);

    const invalid = validateProfileDetails(form);
    if (!isValid(invalid)) {
      setProfileFieldErrors(invalid);
      requestAnimationFrame(() => {
        profileFormRef.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus();
      });
      return;
    }
    setProfileFieldErrors({});

    setSubmitting(true);
    try {
      await updateProfile({
        firstName: form.firstName.trim(),
        middleName: form.middleName.trim() || null,
        lastName: form.lastName.trim(),
        phoneNumber: form.phoneNumber.trim() || null,
      });
      setSaved(true);
      setIsEditing(false);
      requestAnimationFrame(() => editButtonRef.current?.focus());
    } catch (err) {
      const fromServer = getFieldErrors(err) as FieldErrors<ProfileDetailsField>;
      setProfileFieldErrors(fromServer);
      setError(isValid(fromServer) ? getErrorMessage(err) : null);
      if (!isValid(fromServer)) {
        requestAnimationFrame(() => {
          profileFormRef.current
            ?.querySelector<HTMLElement>('[aria-invalid="true"]')
            ?.focus();
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full">
      <PageHead
        title="My profile"
        subtitle="Manage your personal account details and sign-in security."
      />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(17rem,19rem)_minmax(0,1fr)] xl:gap-6">
        {/* `min-w-0`: as a grid item this defaults to min-width:auto and would
            not shrink below the identity card's min-content width, scrolling
            the page sideways at a 200px viewport (400px at 200% zoom). */}
        <aside className="min-w-0 xl:sticky xl:top-[calc(var(--topbar-h)+1.5rem)]">
          <Card className="p-5 sm:p-6">
            <div className="border-b border-paper-200 pb-6">
              <AvatarUpload
                photoUrl={profile.avatarUrl}
                label={fullName}
                onUpload={uploadAvatar}
                layout="stacked"
                shape="circle"
                size="xl"
                buttonIcon={<Camera size={16} aria-hidden />}
                details={
                  <div>
                    <h2 className="break-words font-display text-xl font-semibold leading-snug text-ink-900">
                      {fullName}
                    </h2>
                    <p className="mt-1 break-all text-sm text-ink-500">
                      {profile.email}
                    </p>
                  </div>
                }
              />
            </div>

              <dl className="divide-y divide-paper-200">
                <div className="flex items-start gap-3 py-4">
                  <Mail
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-brand-700"
                  />
                  <div className="min-w-0">
                    <dt className="text-xs font-semibold text-ink-500">
                      Email address
                    </dt>
                    <dd className="mt-1 break-all text-sm font-medium text-ink-800">
                      {profile.email}
                    </dd>
                  </div>
                </div>
                <div className="flex items-start gap-3 py-4">
                  <Building2
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-brand-700"
                  />
                  <div>
                    <dt className="text-xs font-semibold text-ink-500">
                      Businesses
                    </dt>
                    <dd className="mt-1 text-sm font-medium text-ink-800">
                      {businessesLoading
                        ? "Loading…"
                        : businessesError
                          ? "Unavailable"
                          : `${businessCount} active business ${businessCount === 1 ? "profile" : "profiles"}`}
                    </dd>
                  </div>
                </div>
              </dl>

              {/* Account preferences live on their own screen so identity and
                  security actions stay focused here. */}
              <ButtonLink
                to="/account-settings"
                variant="secondary"
                fullWidth
                className="mt-5 justify-between"
              >
                <span className="inline-flex items-center gap-2">
                  <Settings2 size={16} aria-hidden />
                  Account settings
                </span>
                <ArrowUpRight size={16} aria-hidden />
              </ButtonLink>
          </Card>
        </aside>

        <div className="min-w-0 space-y-8">
          <Card className="flex min-w-0 flex-col p-5 sm:p-6">
            <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-paper-200 pb-5">
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-tint-brand text-tone-brand">
                  <UserRound size={19} aria-hidden />
                </span>
                <div>
                  <h2 className="text-lg font-semibold text-ink-900">
                    Personal details
                  </h2>
                  <p className="mt-1 text-sm leading-relaxed text-ink-500">
                    {isEditing
                      ? "Update the details associated with your account."
                      : "Your contact information and account identity."}
                  </p>
                </div>
              </div>
              <Button
                ref={editButtonRef}
                type="button"
                variant="secondary"
                size="sm"
                onClick={isEditing ? cancelEditing : beginEditing}
              >
                {isEditing ? null : <Pencil size={15} aria-hidden />}
                {isEditing ? "Cancel" : "Edit profile"}
              </Button>
            </div>
            {isEditing ? (
              <form
                ref={profileFormRef}
                onSubmit={handleSubmit}
                className="flex flex-1 flex-col gap-5"
                noValidate
              >
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field
                    label="First name"
                    htmlFor="firstName"
                    required
                    error={profileFieldErrors.firstName}
                  >
                    <TextInput
                      id="firstName"
                      required
                      maxLength={MAX_NAME_LENGTH}
                      autoComplete="given-name"
                      value={form.firstName}
                      onChange={(e) => update("firstName", e.target.value)}
                    />
                  </Field>
                  <Field
                    label="Last name"
                    htmlFor="lastName"
                    required
                    error={profileFieldErrors.lastName}
                  >
                    <TextInput
                      id="lastName"
                      required
                      maxLength={MAX_NAME_LENGTH}
                      autoComplete="family-name"
                      value={form.lastName}
                      onChange={(e) => update("lastName", e.target.value)}
                    />
                  </Field>
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field
                    label="Middle name"
                    htmlFor="middleName"
                    optional
                    error={profileFieldErrors.middleName}
                  >
                    <TextInput
                      id="middleName"
                      maxLength={MAX_NAME_LENGTH}
                      autoComplete="additional-name"
                      value={form.middleName}
                      onChange={(e) => update("middleName", e.target.value)}
                    />
                  </Field>
                  <Field
                    label="Phone number"
                    htmlFor="phoneNumber"
                    optional
                    error={profileFieldErrors.phoneNumber}
                  >
                    <TextInput
                      id="phoneNumber"
                      type="tel"
                      maxLength={MAX_PHONE_LENGTH}
                      autoComplete="tel"
                      value={form.phoneNumber}
                      onChange={(e) => update("phoneNumber", e.target.value)}
                    />
                  </Field>
                </div>
                <div className="rounded-xl bg-paper-100 px-4 py-3">
                  <p className="text-xs font-semibold text-ink-600">
                    Email address
                  </p>
                  <p className="mt-1 break-all text-sm font-medium text-ink-800">
                    {profile.email}
                  </p>
                  <p className="mt-1 text-xs text-ink-600">
                    Contact support to change your sign-in email.
                  </p>
                </div>
                {error ? <FormError>{error}</FormError> : null}
                <div className="mt-auto flex justify-end border-t border-paper-200 pt-5">
                  <Button
                    type="submit"
                    disabled={submitting}
                    className="w-full sm:w-auto"
                  >
                    {submitting ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              </form>
            ) : (
              <div>
                {saved ? (
                  <Callout tone="brand">Profile updated.</Callout>
                ) : null}
                <span className="sr-only" aria-live="polite">
                  {saved ? "Profile updated." : ""}
                </span>
                <dl
                  className={`grid gap-x-8 sm:grid-cols-2 ${saved ? "mt-5" : ""}`}
                >
                  <ProfileDetail label="First name" value={profile.firstName} />
                  <ProfileDetail label="Last name" value={profile.lastName} />
                  <ProfileDetail
                    label="Middle name"
                    value={profile.middleName}
                  />
                  <ProfileDetail
                    label="Phone number"
                    value={profile.phoneNumber}
                  />
                  <ProfileDetail
                    label="Email address"
                    value={profile.email}
                    wide
                  />
                </dl>
              </div>
            )}
          </Card>

          <section aria-labelledby="account-security-heading">
            <div className="mb-5 flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-tint-brand text-tone-brand">
                <ShieldCheck size={20} aria-hidden />
              </span>
              <div>
                <h2
                  id="account-security-heading"
                  className="text-lg font-semibold text-ink-900"
                >
                  Account security
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-ink-500">
                  Update your password and control access from other devices.
                </p>
              </div>
            </div>
            <div className="grid items-stretch gap-5 [grid-template-columns:repeat(auto-fit,minmax(min(22rem,100%),1fr))]">
              <SecurityPanel />
              <SessionsPanel onLogOutEverywhere={logoutEverywhere} />
            </div>
          </section>

          <section
            aria-labelledby="danger-zone-heading"
            className="overflow-hidden rounded-2xl border border-edge-danger bg-tint-danger"
          >
            <div className="flex items-start gap-3 p-5 sm:px-6">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-paper text-tone-danger ring-1 ring-edge-danger">
                <Trash2 size={19} aria-hidden />
              </span>
              <div>
                <h2
                  id="danger-zone-heading"
                  className="text-base font-semibold text-tone-danger"
                >
                  Danger zone
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-ink-600">
                  Actions here permanently affect your account and its data.
                </p>
              </div>
            </div>
            <DeleteAccountPanel onDeleted={logout} />
          </section>
        </div>
      </div>
    </div>
  );
}

function ProfileDetail({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string | null | undefined;
  wide?: boolean;
}) {
  const hasValue = Boolean(value?.trim());

  return (
    <div
      className={`border-b border-paper-200 py-4 ${wide ? "sm:col-span-2" : ""}`}
    >
      <dt className="text-xs font-semibold text-ink-500">{label}</dt>
      <dd
        className={`mt-1 break-words text-sm font-medium ${hasValue ? "text-ink-900" : "text-ink-500"}`}
      >
        {hasValue ? value : "Not provided"}
      </dd>
    </div>
  );
}

/**
 * "Log out on all devices", as its own deliberate action.
 *
 * It used to be the ONLY behaviour: every ordinary log-out signed the owner out
 * globally, so tapping "Log out" on a phone at the market silently ended the
 * session on the tablet behind the counter, with nothing on either screen to
 * explain it. Ordinary log-out is now local, and the destructive version lives
 * here where it has room to say what it does — and where someone who has just
 * realised a device was stolen can find it.
 */
function SessionsPanel({
  onLogOutEverywhere,
}: {
  onLogOutEverywhere: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestPending = useRef(false);

  async function handleClick() {
    if (requestPending.current) return;
    requestPending.current = true;
    const confirmed = await confirm({
      title: "Log out on all devices?",
      body: "This browser will sign out now. Other devices will need your password again after their current access expires.",
      confirmLabel: "Log out everywhere",
      cancelLabel: "Cancel",
    });
    if (!confirmed) {
      requestPending.current = false;
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onLogOutEverywhere();
    } catch {
      setError(
        "FinSight couldn't confirm that your other devices' refresh sessions were revoked. You're still signed in here. Check your connection and try again.",
      );
    } finally {
      requestPending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Card className="flex h-full flex-col p-5 sm:p-6">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-tint-neutral text-tone-neutral">
          <MonitorSmartphone size={19} aria-hidden />
        </span>
        <div>
          <h3 className="text-base font-semibold text-ink-900">
            Sessions and devices
          </h3>
          <p className="max-w-[65ch] text-sm leading-relaxed text-ink-500">
            Protect your account when a phone or computer is no longer in your
            control.
          </p>
        </div>
      </div>

      <div className="mt-5 rounded-xl bg-paper-100 p-4">
        <p className="text-sm font-medium text-ink-800">
          This browser stays signed in
        </p>
        <p className="mt-1 text-sm leading-relaxed text-ink-600">
          Logging out normally only ends this session. Use the action below to
          stop other devices from renewing their sessions and sign out this browser.
        </p>
      </div>

      {error ? (
        <div className="mt-5">
          <FormError>{error}</FormError>
        </div>
      ) : null}

      <div className="flex shrink-0 justify-end pt-5">
        <Button
          variant="primary"
          className="w-full sm:w-auto"
          disabled={submitting}
          onClick={() => void handleClick()}
        >
          {submitting ? "Signing out…" : "Log out on all devices"}
        </Button>
      </div>
    </Card>
  );
}

function DeleteAccountPanel({ onDeleted }: { onDeleted: () => Promise<void> }) {
  const confirm = useConfirm();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  /*
   * The last native window.confirm() in the app, and the one that mattered
   * most: an OS-grey box was carrying the only irreversible decision FinSight
   * offers. ConfirmDialog focuses Cancel by default on a danger tone, so a
   * hurried Enter keypress no longer lands on "delete everything".
   */
  async function removeAccount() {
    if (!password) return;
    const confirmed = await confirm({
      title: "Delete your account?",
      body: (
        <>
          This permanently removes{" "}
          <strong>
            every business, record, receipt image, import, and sign-in
            credential
          </strong>{" "}
          on this account. It cannot be undone and nothing can be recovered
          afterwards.
        </>
      ),
      confirmLabel: "Delete my account",
      cancelLabel: "Keep my account",
      tone: "danger",
    });
    if (!confirmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.delete("/auth/me", { data: { currentPassword: password } });
      await onDeleted();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="border-t border-edge-danger bg-paper/75 p-5 sm:px-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="mb-1 text-base font-semibold text-tone-danger">
            Delete account
          </h2>
          <p className="max-w-[65ch] text-sm leading-relaxed text-ink-500">
            Permanently removes every business, record, receipt image, import,
            and sign-in credential.
          </p>
        </div>
        <Button
          type="button"
          variant="danger"
          className="w-full shrink-0 sm:w-auto"
          onClick={() => {
            setIsExpanded((open) => !open);
            setError(null);
            if (isExpanded) setPassword("");
          }}
        >
          {isExpanded ? "Cancel" : "Delete account"}
        </Button>
      </div>

      {isExpanded ? (
        <form
          className="mt-6 border-t border-edge-danger pt-6"
          onSubmit={(event) => {
            event.preventDefault();
            void removeAccount();
          }}
        >
          <div className="ml-auto max-w-xl space-y-4">
            {/*
            No client-side rule beyond "type something": the only thing that can
            judge this password is the server, and the button is already disabled
            until the box has content. Inventing a length check here would refuse
            to attempt a deletion that would have worked.
          */}
            <Field label="Current password" htmlFor="deletePassword" required>
              <PasswordInput
                id="deletePassword"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Field>
            {error ? <FormError>{error}</FormError> : null}
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="danger"
                className="w-full sm:w-auto"
                disabled={!password || submitting}
              >
                {submitting ? "Deleting…" : "Delete my account"}
              </Button>
            </div>
          </div>
        </form>
      ) : null}
    </div>
  );
}

const emptyPasswordForm = {
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
};

function SecurityPanel() {
  const [form, setForm] = useState(emptyPasswordForm);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    FieldErrors<ChangePasswordField>
  >({});
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const changePasswordButtonRef = useRef<HTMLButtonElement>(null);
  const passwordFormRef = useRef<HTMLFormElement>(null);
  const restoreTriggerFocusRef = useRef(false);

  useEffect(() => {
    if (isEditing) {
      passwordFormRef.current
        ?.querySelector<HTMLInputElement>("#currentPassword")
        ?.focus();
      return;
    }

    if (restoreTriggerFocusRef.current) {
      restoreTriggerFocusRef.current = false;
      changePasswordButtonRef.current?.focus();
    }
  }, [isEditing]);

  function beginEditing() {
    setSuccess(false);
    setIsEditing(true);
  }

  function cancelEditing() {
    setForm(emptyPasswordForm);
    setError(null);
    setFieldErrors({});
    restoreTriggerFocusRef.current = true;
    setIsEditing(false);
  }

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setSuccess(false);
    setFieldErrors((prev) =>
      prev[key as ChangePasswordField] ? { ...prev, [key]: undefined } : prev,
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    /*
      Through `validateChangePassword` rather than the two `if`s that used to
      sit here.
      
      Those checked the confirmation and the same-as-current case and showed
      both as one line at the bottom of the form — so "these do not match"
      appeared nowhere near the box that did not match. They also missed the
      length rule entirely, which meant a seven-character password cost a
      round trip that re-verifies the CURRENT password before failing.
    */
    const invalid = validateChangePassword(form);
    if (!isValid(invalid)) {
      setFieldErrors(invalid);
      return;
    }
    setFieldErrors({});

    setSubmitting(true);
    try {
      await api.post("/auth/change-password", {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });
      setForm(emptyPasswordForm);
      setSuccess(true);
      restoreTriggerFocusRef.current = true;
      setIsEditing(false);
    } catch (err) {
      // A wrong current password comes back as a message, not a field error —
      // the server will not say which field it was about, so it stays at form
      // level where it does not claim to.
      const fromServer = getFieldErrors(err);
      setFieldErrors(fromServer);
      setError(isValid(fromServer) ? getErrorMessage(err) : null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="flex h-full min-w-0 flex-col p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-tint-brand text-tone-brand">
            <KeyRound size={19} aria-hidden />
          </span>
          <div>
            <h3 className="text-base font-semibold text-ink-900">Password</h3>
            <p className="mt-1 text-sm leading-relaxed text-ink-500">
              Change your password securely using your current password.
            </p>
          </div>
        </div>
      </div>

      {success ? (
        <div className="mt-5">
          <Callout tone="brand">
            Password changed. You're still signed in here, and any other devices
            have been signed out.
          </Callout>
          <span className="sr-only" aria-live="polite">
            Password changed successfully.
          </span>
        </div>
      ) : null}

      {!isEditing && !success ? (
        <div className="mt-5 rounded-xl bg-paper-100 p-4">
          <p className="text-sm font-medium text-ink-800">
            Password protection
          </p>
          <p className="mt-1 text-sm leading-relaxed text-ink-600">
            Changing your password keeps this browser signed in and signs out
            your other devices.
          </p>
        </div>
      ) : null}

      {!isEditing ? (
        <div className="mt-auto flex justify-end pt-5">
          <Button
            ref={changePasswordButtonRef}
            type="button"
            variant="primary"
            onClick={beginEditing}
          >
            Change password
          </Button>
        </div>
      ) : null}

      {isEditing ? (
        <form
          ref={passwordFormRef}
          onSubmit={handleSubmit}
          className="mt-6 flex flex-col gap-5 border-t border-paper-200 pt-6"
        >
          <Field
            label="Current password"
            htmlFor="currentPassword"
            required
            error={fieldErrors.currentPassword}
          >
            <PasswordInput
              id="currentPassword"
              autoComplete="current-password"
              value={form.currentPassword}
              onChange={(e) => update("currentPassword", e.target.value)}
            />
          </Field>
          <Field
            label="New password"
            htmlFor="newPassword"
            required
            hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
            error={fieldErrors.newPassword}
          >
            <PasswordInput
              id="newPassword"
              autoComplete="new-password"
              value={form.newPassword}
              onChange={(e) => update("newPassword", e.target.value)}
            />
          </Field>
          <Field
            label="Confirm new password"
            htmlFor="confirmPassword"
            required
            error={fieldErrors.confirmPassword}
          >
            <PasswordInput
              id="confirmPassword"
              autoComplete="new-password"
              value={form.confirmPassword}
              onChange={(e) => update("confirmPassword", e.target.value)}
            />
          </Field>

          {error ? <FormError>{error}</FormError> : null}
          {/*
          States the session policy, because the owner cannot otherwise tell
          what just happened to their other devices — and the policy is the
          same on mobile, so the wording is too. This browser keeps its session
          deliberately: the person who just proved they know the current
          password should not be thrown back to a login form for it.
        */}
          <div className="flex flex-col-reverse justify-end gap-3 border-t border-paper-200 pt-5 sm:flex-row">
            <Button type="button" variant="ghost" onClick={cancelEditing}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting}
              className="w-full sm:w-auto"
            >
              {submitting ? "Changing…" : "Change password"}
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
