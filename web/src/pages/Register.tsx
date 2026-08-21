import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { AuthLayout } from "../components/AuthLayout";
import { Button } from "../components/Button";
import { Field, FormError, TextInput, PasswordInput } from "../components/Field";
import { api } from "../lib/api";
import { getErrorMessage, getFieldErrors } from "../lib/errors";
import { isValid, validateRegister, MIN_PASSWORD_LENGTH, type FieldErrors, type RegisterField } from "../lib/authValidation";

export function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    firstName: "",
    middleName: "",
    lastName: "",
    email: "",
    phoneNumber: "",
    password: "",
    confirmPassword: "",
  });
  const [error, setError] = useState<string | null>(null);
  /**
   * What the server said once the request was accepted.
   *
   * Non-null switches this screen to the "check your email" state. Registration
   * no longer returns a session — the account is pending until its address is
   * confirmed — so there is nothing to navigate into, and the honest end of
   * this form is an instruction rather than a redirect.
   */
  const [acknowledgement, setAcknowledgement] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);
  /**
   * Per-field messages, from this form's checks or from the server's.
   *
   * Populated on submit and cleared per field as it is edited. Checking while
   * someone types would mark an email invalid halfway through typing it,
   * which is a form arguing with a person who is doing nothing wrong.
   */
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<RegisterField>>({});
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    // Once a field has been marked, correcting it clears the mark straight
    // away rather than making the owner submit again to find out.
    setFieldErrors((prev) => (prev[key as RegisterField] ? { ...prev, [key]: undefined } : prev));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const invalid = validateRegister(form);
    if (!isValid(invalid)) {
      setFieldErrors(invalid);
      return;
    }
    setFieldErrors({});

    setSubmitting(true);
    try {
      const { message } = await register({
        email: form.email,
        password: form.password,
        firstName: form.firstName,
        middleName: form.middleName || undefined,
        lastName: form.lastName,
        phoneNumber: form.phoneNumber || undefined,
      });
      setAcknowledgement(message);
    } catch (err) {
      // Fields the server rejected go under those fields; everything else —
      // an address already registered, a network failure — has no field to
      // sit under and stays a form-level message.
      const fromServer = getFieldErrors(err);
      setFieldErrors(fromServer);
      if (!isValid(fromServer)) setError(null);
      else setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function resend() {
    setResending(true);
    try {
      await api.post("/auth/resend-verification", { email: form.email, platform: "web" });
      setResent(true);
    } catch {
      // The endpoint answers the same way whatever happened, so there is
      // nothing here worth putting on screen that "check your inbox" does not
      // already say.
      setResent(true);
    } finally {
      setResending(false);
    }
  }

  /*
   * The end of registration, and it is not the app.
   *
   * Sending someone straight to /business-profiles used to be possible because
   * registration handed back a session — which is precisely how an address
   * nobody owned became a working account. The account now exists in a pending
   * state until the link in that inbox is clicked, and this screen says so
   * rather than pretending otherwise.
   */
  if (acknowledgement) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle="One more step."
        heroTitle="Almost there."
        heroBody="We've sent a confirmation link to your address. Clicking it proves the inbox is yours and activates your FinSight account."
      >
        <p className="text-center text-sm text-ink-600">{acknowledgement}</p>
        <p className="mt-4 text-center text-sm text-ink-500">
          The link expires after a while, and nothing is active until you use it.
        </p>
        <div className="mt-6 space-y-3">
          <Button variant="primary" fullWidth onClick={() => navigate("/login")}>
            Go to log in
          </Button>
          <Button variant="ghost" fullWidth disabled={resending || resent} onClick={() => void resend()}>
            {resent ? "Link sent — check your inbox" : resending ? "Sending…" : "Didn't arrive? Send it again"}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Track your business finances with FinSight."
      heroTitle="Set up your account in minutes."
      heroBody="Create your FinSight account, then add your first business profile — a store, a branch, or any income source you want to monitor."
      points={[
        "Create your owner account",
        "Add a business profile and set your available funds",
        "Start recording expenses and sales reference",
      ]}
      footnote="Your records stay organised per business profile."
      showBack
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Stacks below `sm`: at 320px two side-by-side name fields leave
            about 130px each, which is not enough for a long surname to be
            readable while typing. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name" htmlFor="firstName" required error={fieldErrors.firstName}>
            <TextInput
              autoComplete="given-name"
              value={form.firstName}
              onChange={(e) => update("firstName", e.target.value)}
            />
          </Field>
          <Field label="Last name" htmlFor="lastName" required error={fieldErrors.lastName}>
            <TextInput
              autoComplete="family-name"
              value={form.lastName}
              onChange={(e) => update("lastName", e.target.value)}
            />
          </Field>
        </div>
        <Field label="Middle name" htmlFor="middleName" optional error={fieldErrors.middleName}>
          <TextInput
            autoComplete="additional-name"
            value={form.middleName}
            onChange={(e) => update("middleName", e.target.value)}
          />
        </Field>
        <Field label="Email" htmlFor="email" required error={fieldErrors.email}>
          <TextInput
            type="email"
            autoComplete="email"
            value={form.email}
            onChange={(e) => update("email", e.target.value)}
          />
        </Field>
        <Field label="Phone number" htmlFor="phoneNumber" optional error={fieldErrors.phoneNumber}>
          <TextInput
            type="tel"
            autoComplete="tel"
            value={form.phoneNumber}
            onChange={(e) => update("phoneNumber", e.target.value)}
          />
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          required
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. A short phrase works well.`}
          error={fieldErrors.password}
        >
          <PasswordInput
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => update("password", e.target.value)}
          />
        </Field>
        {/* A mistyped password here is not a small mistake: the account it
            creates cannot be logged into, and the way out is a reset link sent
            to an address that may have been mistyped in the same sitting. */}
        <Field label="Confirm password" htmlFor="confirmPassword" required error={fieldErrors.confirmPassword}>
          <PasswordInput
            autoComplete="new-password"
            value={form.confirmPassword}
            onChange={(e) => update("confirmPassword", e.target.value)}
          />
        </Field>
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" fullWidth disabled={submitting}>
          {submitting ? "Creating account…" : "Create account"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-500">
        Already have an account?{" "}
        <Link to="/login" className="tap-inline font-medium text-brand-700 hover:text-brand-800">
          Log in
        </Link>
      </p>
    </AuthLayout>
  );
}
