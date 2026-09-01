import { useState, type FormEvent } from "react";
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { getErrorMessage, getFieldErrors } from "../lib/errors";
import {
  isValid,
  validateChangePassword,
  MIN_PASSWORD_LENGTH,
  type ChangePasswordField,
  type FieldErrors,
} from "../lib/authValidation";
import { Callout, Card, PageHead } from "../components/ui";
import { Button, ButtonLink } from "../components/Button";
import { Field, FormError, TextInput, PasswordInput } from "../components/Field";
import { AvatarUpload } from "../components/Avatar";
import { useConfirm } from "../components/ConfirmDialog";
import { SkeletonPanel } from "../components/Skeleton";

export function Profile() {
  const { profile, updateProfile, uploadAvatar, logout, logoutEverywhere } = useAuth();
  const { profiles } = useBusinessProfiles();
  const [form, setForm] = useState({
    firstName: profile?.firstName ?? "",
    middleName: profile?.middleName ?? "",
    lastName: profile?.lastName ?? "",
    phoneNumber: profile?.phoneNumber ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!profile) {
    return (
      <div>
        <PageHead title="My Profile" subtitle="Manage your personal account details and sign-in security." />
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

  const fullName = [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(" ");
  const businessCount = profiles.length;

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      await updateProfile({
        firstName: form.firstName,
        middleName: form.middleName || null,
        lastName: form.lastName,
        phoneNumber: form.phoneNumber || null,
      });
      setSaved(true);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHead title="My Profile" subtitle="Manage your personal account details and sign-in security." />

      <Card className="mb-6 flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <AvatarUpload
          photoUrl={profile.avatarUrl}
          label={fullName}
          onUpload={uploadAvatar}
          details={
            <>
              <h2 className="truncate text-lg font-bold text-ink-900">{fullName}</h2>
              <p className="mt-0.5 text-sm text-ink-500">
                Small Business Owner · {businessCount} business {businessCount === 1 ? "profile" : "profiles"}
              </p>
            </>
          }
        />
        {/*
          The guided tour, the dashboard greeting and the theme used to be
          reachable from this page. Someone who learned them here will come
          back here looking, so the page says where they went rather than
          leaving them to find the sidebar entry.
        */}
        <ButtonLink to="/account-settings" variant="secondary" className="w-full sm:w-auto">
          Account settings
        </ButtonLink>
      </Card>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.08fr)_minmax(24rem,0.92fr)]">
        <Card className="p-6 sm:p-7">
          <div className="mb-5 border-b border-paper-200 pb-4">
            <h2 className="text-base font-semibold text-ink-900">Personal Details</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">Keep your contact information accurate and up to date.</p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="First name" htmlFor="firstName" required>
                <TextInput
                  required
                  autoComplete="given-name"
                  value={form.firstName}
                  onChange={(e) => update("firstName", e.target.value)}
                />
              </Field>
              <Field label="Middle name" htmlFor="middleName" optional>
                <TextInput
                  autoComplete="additional-name"
                  value={form.middleName}
                  onChange={(e) => update("middleName", e.target.value)}
                />
              </Field>
            </div>
            <Field label="Last name" htmlFor="lastName" required>
              <TextInput
                required
                autoComplete="family-name"
                value={form.lastName}
                onChange={(e) => update("lastName", e.target.value)}
              />
            </Field>
            <Field label="Email" htmlFor="email" hint="Contact support to change the email on your account.">
              <TextInput id="email" value={profile.email} disabled readOnly />
            </Field>
            <Field label="Phone number" htmlFor="phoneNumber" optional>
              <TextInput
                type="tel"
                autoComplete="tel"
                value={form.phoneNumber}
                onChange={(e) => update("phoneNumber", e.target.value)}
              />
            </Field>
            {error ? <FormError>{error}</FormError> : null}
            {saved ? <Callout tone="brand">Profile updated.</Callout> : null}
            <div className="flex justify-end">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving…" : "Update Profile"}
              </Button>
            </div>
          </form>
        </Card>

        <SecurityPanel />
      </div>

      <section className="mt-8" aria-labelledby="account-access-heading">
        <div className="mb-4">
          <h2 id="account-access-heading" className="text-lg font-semibold text-ink-900">Account access</h2>
          <p className="mt-1 text-sm text-ink-500">Manage signed-in devices or permanently close your account.</p>
        </div>
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <SessionsPanel onLogOutEverywhere={logoutEverywhere} />
          <DeleteAccountPanel onDeleted={logout} />
        </div>
      </section>
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
function SessionsPanel({ onLogOutEverywhere }: { onLogOutEverywhere: () => Promise<void> }) {
  const confirm = useConfirm();
  const [submitting, setSubmitting] = useState(false);

  async function handleClick() {
    const confirmed = await confirm({
      title: "Log out on all devices?",
      body: "Every device signed in to this account — including this one — will be signed out. You'll need your password to get back in.",
      confirmLabel: "Log out everywhere",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    setSubmitting(true);
    await onLogOutEverywhere();
  }

  return (
    <Card className="p-6 sm:p-7">
      <h2 className="mb-1 text-base font-semibold text-ink-900">Devices</h2>
      <p className="mb-6 max-w-[65ch] text-xs leading-relaxed text-ink-500">
        Logging out normally only signs out this browser. If you've lost a phone, or used a computer you don't trust,
        sign out everywhere instead.
      </p>
      <div className="flex justify-end">
        <Button variant="secondary" disabled={submitting} onClick={() => void handleClick()}>
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
          This permanently removes <strong>every business, record, receipt image, import, and sign-in
          credential</strong> on this account. It cannot be undone and nothing can be recovered afterwards.
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
    <Card className="border-edge-danger p-6 sm:p-7">
      <h2 className="mb-1 text-base font-semibold text-tone-danger">Delete account</h2>
      <p className="mb-4 max-w-[65ch] text-xs leading-relaxed text-ink-500">Permanently removes every business, record, receipt image, import, and sign-in credential.</p>
      {/*
        No client-side rule beyond "type something": the only thing that can
        judge this password is the server, and the button is already disabled
        until the box has content. Inventing a length check here would refuse
        to attempt a deletion that would have worked.
      */}
      <Field label="Current password" htmlFor="deletePassword" required>
        <PasswordInput id="deletePassword" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </Field>
      {error ? <FormError>{error}</FormError> : null}
      <div className="mt-4 flex justify-end">
        <Button type="button" variant="danger" disabled={!password || submitting} onClick={removeAccount}>
          {submitting ? "Deleting…" : "Delete my account"}
        </Button>
      </div>
    </Card>
  );
}

const emptyPasswordForm = { currentPassword: "", newPassword: "", confirmPassword: "" };

function SecurityPanel() {
  const [form, setForm] = useState(emptyPasswordForm);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<ChangePasswordField>>({});
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setSuccess(false);
    setFieldErrors((prev) => (prev[key as ChangePasswordField] ? { ...prev, [key]: undefined } : prev));
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
    <Card className="p-6 sm:p-7">
      <div className="mb-5 border-b border-paper-200 pb-4">
        <h2 className="text-base font-semibold text-ink-900">Security</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          Choose a new password. You'll need your current password to confirm it's you.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Current password" htmlFor="currentPassword" required error={fieldErrors.currentPassword}>
          <PasswordInput
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
            autoComplete="new-password"
            value={form.newPassword}
            onChange={(e) => update("newPassword", e.target.value)}
          />
        </Field>
        <Field label="Confirm new password" htmlFor="confirmPassword" required error={fieldErrors.confirmPassword}>
          <PasswordInput
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
        {success ? (
          <Callout tone="brand">
            Password changed. You're still signed in here, and any other devices have been signed out.
          </Callout>
        ) : null}

        <div className="flex justify-end">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Changing…" : "Change Password"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
