import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useTourOptional } from "../context/TourContext";
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
import { Button } from "../components/Button";
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
        <PageHead eyebrow="Account" title="My Profile" subtitle="Manage your personal account details." />
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
      <PageHead eyebrow="Account" title="My Profile" subtitle="Manage your personal account details." />

      <Card className="mb-6 flex flex-wrap items-center justify-between gap-4 p-6">
        <AvatarUpload photoUrl={profile.avatarUrl} label={fullName} onUpload={uploadAvatar} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-bold text-ink-900">{fullName}</h2>
          <p className="text-sm text-ink-500">
            Small Business Owner · {businessCount} business {businessCount === 1 ? "profile" : "profiles"}
          </p>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6 sm:p-7">
          <h2 className="mb-4 text-base font-semibold text-ink-900">Personal Details</h2>
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

        <div className="space-y-6">
          <GuidedTourPanel />
          <SecurityPanel />
          <SessionsPanel onLogOutEverywhere={logoutEverywhere} />
          <DeleteAccountPanel onDeleted={logout} />
        </div>
      </div>
    </div>
  );
}

/**
 * The guided tour's own settings.
 *
 * WHY THIS EXISTS AT ALL. The tour is deliberately once-per-account: it starts
 * itself for a new owner and never interrupts again. That is right for a real
 * owner and impossible for everyone else — showing the tour to someone, or
 * re-checking a change to it, meant registering a fresh account or clearing
 * browser storage by hand. The toggle is the supported way to keep it on.
 *
 * It sits on Profile rather than in the account menu because a menu is for
 * actions and this is a preference — and it keeps the one-shot "Restart" next
 * to the standing "Always show" so the two are read together rather than
 * hunted for in different places.
 *
 * Renders nothing when the tour provider is absent (the public pages, tests
 * that mount Profile alone), so it can never be the reason a page fails.
 */
function GuidedTourPanel() {
  const tour = useTourOptional();
  const navigate = useNavigate();
  if (!tour) return null;

  return (
    <Card className="p-6 sm:p-7">
      <h2 className="mb-1 text-base font-semibold text-ink-900">Guided tour</h2>
      <p className="mb-5 text-xs text-ink-500">
        The walkthrough that introduces the dashboard, records, receipt scanning and insights.
      </p>

      {/*
        A real checkbox with `role="switch"`, not a styled div: it arrives in
        the tab order, answers the space bar, and reports its own state to a
        screen reader without any of that having to be re-implemented. The
        visual track is drawn from the peer's checked state.
      */}
      <label className="flex min-h-tap cursor-pointer items-start justify-between gap-4 rounded-xl border border-paper-200 p-3.5">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink-900">Always show the tour when I sign in</span>
          <span className="mt-0.5 block text-xs text-ink-500">
            Replays the walkthrough on every sign-in instead of only the first. Useful for demonstrating FinSight or
            setting it up for someone else — turn it off and the tour goes back to appearing once.
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={tour.alwaysShow}
          onChange={(e) => tour.setAlwaysShow(e.target.checked)}
        />
        <span
          aria-hidden
          className="relative mt-0.5 h-6 w-11 shrink-0 rounded-full bg-ink-200 transition-colors peer-checked:bg-brand-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2"
        >
          <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-paper shadow-sm transition-transform peer-checked:translate-x-5" />
        </span>
      </label>

      <div className="mt-4 flex justify-end">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            // Rewind first, then land on the dashboard — the tour's targets
            // are that page and its chrome, so it opens once the data is in.
            tour.restart();
            navigate("/dashboard");
          }}
        >
          Start the tour now
        </Button>
      </div>
    </Card>
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
      <p className="mb-6 text-xs text-ink-500">
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
    <Card className="border border-edge-danger p-6 sm:p-7">
      <h2 className="mb-1 text-base font-semibold text-tone-danger">Delete account</h2>
      <p className="mb-4 text-xs text-ink-500">Permanently removes every business, record, receipt image, import, and sign-in credential.</p>
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
      <h2 className="mb-1 text-base font-semibold text-ink-900">Security</h2>
      <p className="mb-6 text-xs text-ink-500">
        Change your password. You'll need your current password to confirm it's you.
      </p>

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
