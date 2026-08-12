/**
 * What the auth forms check before they ask the server.
 *
 * WHY CLIENT-SIDE AT ALL, given the server validates everything anyway. Two
 * reasons, and neither is "so the server can trust it" — it cannot, and it
 * still checks:
 *
 *   1. A round trip to be told an email is missing an "@" is a round trip an
 *      owner on a phone tether pays for. The answer is already knowable.
 *   2. The server answers with `{ error: "Validation failed", details }`, and
 *      both clients collapsed that into "Please check the highlighted fields
 *      and try again" while highlighting nothing at all. A message that
 *      refers to a highlight the screen does not draw is worse than no
 *      message: it tells the owner to look for something that is not there.
 *
 * PINNED TO THE SERVER'S SCHEMA, not invented alongside it. Every rule below
 * mirrors `registerSchema` / `loginSchema` / `changePasswordSchema` in
 * backend/src/controllers/auth.controller.ts, and the tests state the figures
 * so the two cannot drift silently. A client that is STRICTER than the server
 * rejects accounts the server would have accepted; one that is LOOSER sends a
 * request it knows will fail.
 *
 * Mirrored by mobile/src/lib/authValidation.ts, deliberately rather than
 * shared — the two apps have no build-time relationship, and the note at the
 * top of theme/tokens.ts explains why a package to share this would couple
 * their release cycles for very little.
 */

/** Field name → the one message to show under it. */
export type FieldErrors<Field extends string> = Partial<Record<Field, string>>;

/**
 * `MIN_PASSWORD_LENGTH` in backend/src/controllers/auth.controller.ts, for
 * every password the server creates.
 *
 * Twelve, raised from eight. Eight is within reach of an offline attack on a
 * leaked hash, and this app holds a business's financial history. Length is the
 * only rule: no character classes, which produce `Password1!` and stop nobody,
 * and no maximum, which is what breaks passphrases and password managers.
 *
 * MUST match the server exactly. Stricter here locks people out of accounts the
 * server would create; looser sends a request already known to fail.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** `z.string().max(100)` on names, `.max(20)` on the phone number. */
export const MAX_NAME_LENGTH = 100;
export const MAX_PHONE_LENGTH = 20;

/**
 * `MAX_EMAIL_LENGTH` on the server, which exists because `User_Email` is
 * `VARCHAR(150)`.
 *
 * Checked here as well so the refusal lands under the field before the round
 * trip — the server rejects it either way, but a form that says nothing until
 * the request comes back is the round trip this file exists to save.
 */
export const MAX_EMAIL_LENGTH = 150;

/**
 * Whether an address is worth sending.
 *
 * DELIBERATELY PERMISSIVE, and it has to be. `z.string().email()` accepts
 * plenty that a "clever" regex rejects — plus-addressing, long TLDs, hyphens
 * and digits in the domain — and a client that refuses one of those blocks a
 * real person from an account the server would have created. So this catches
 * only the shapes that cannot be an address at all: nothing before the @,
 * nothing after it, no dot in the domain, or whitespace anywhere. Everything
 * subtler is the server's call.
 */
export function isPlausibleEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed !== value || /\s/.test(trimmed)) return false;
  const at = trimmed.indexOf("@");
  if (at <= 0 || at !== trimmed.lastIndexOf("@")) return false;
  const domain = trimmed.slice(at + 1);
  if (domain.length < 3 || !domain.includes(".")) return false;
  // A trailing or leading dot in the domain, or an empty label between dots.
  return !domain.startsWith(".") && !domain.endsWith(".") && !domain.includes("..");
}

function emailError(email: string): string | undefined {
  if (!email.trim()) return "Enter your email address.";
  if (!isPlausibleEmail(email)) return "That doesn't look like an email address.";
  // After the shape check, so something that is not an address at all is told
  // so rather than being told it is too long.
  if (email.trim().length > MAX_EMAIL_LENGTH) return `Keep this under ${MAX_EMAIL_LENGTH} characters.`;
  return undefined;
}

// ============================================================
// Log in
// ============================================================

export type LoginField = "email" | "password";

/**
 * Login checks that the boxes are FILLED, and nothing more.
 *
 * The server's `loginSchema` asks for `password: z.string().min(1)` — it does
 * not re-apply the eight-character rule, and neither should this. Telling
 * someone their existing password is "too short" at the login screen would be
 * both wrong and alarming: the password is whatever it is, and the only thing
 * this form can know is whether they typed one.
 */
export function validateLogin(input: { email: string; password: string }): FieldErrors<LoginField> {
  const errors: FieldErrors<LoginField> = {};
  const email = emailError(input.email);
  if (email) errors.email = email;
  if (!input.password) errors.password = "Enter your password.";
  return errors;
}

// ============================================================
// Register
// ============================================================

export type RegisterField =
  | "firstName"
  | "lastName"
  | "middleName"
  | "email"
  | "password"
  | "confirmPassword"
  | "phoneNumber";

/**
 * `confirmPassword` has no server counterpart and is not sent to it.
 *
 * It exists because registration is now the one moment a mistyped password
 * cannot be recovered from cheaply: the account it creates cannot be logged
 * into, and the reset link goes to an inbox the person may have mistyped in the
 * same sitting. Change-password has had this field all along; registration, the
 * higher-stakes of the two, did not.
 */
export function validateRegister(input: {
  firstName: string;
  lastName: string;
  middleName?: string;
  email: string;
  password: string;
  confirmPassword: string;
  phoneNumber?: string;
}): FieldErrors<RegisterField> {
  const errors: FieldErrors<RegisterField> = {};

  if (!input.firstName.trim()) errors.firstName = "Enter your first name.";
  else if (input.firstName.trim().length > MAX_NAME_LENGTH) {
    errors.firstName = `Keep this under ${MAX_NAME_LENGTH} characters.`;
  }

  if (!input.lastName.trim()) errors.lastName = "Enter your last name.";
  else if (input.lastName.trim().length > MAX_NAME_LENGTH) {
    errors.lastName = `Keep this under ${MAX_NAME_LENGTH} characters.`;
  }

  if ((input.middleName ?? "").trim().length > MAX_NAME_LENGTH) {
    errors.middleName = `Keep this under ${MAX_NAME_LENGTH} characters.`;
  }

  const email = emailError(input.email);
  if (email) errors.email = email;

  if (!input.password) errors.password = "Choose a password.";
  else if (input.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  if (!input.confirmPassword) errors.confirmPassword = "Type the password again.";
  else if (input.confirmPassword !== input.password) {
    errors.confirmPassword = "These do not match.";
  }

  if ((input.phoneNumber ?? "").trim().length > MAX_PHONE_LENGTH) {
    errors.phoneNumber = `Keep this under ${MAX_PHONE_LENGTH} characters.`;
  }

  return errors;
}

// ============================================================
// Set a new password, from a reset link
// ============================================================

export type ResetPasswordField = "newPassword" | "confirmPassword";

/**
 * The reset screen, which has no current password to check against.
 *
 * That absence is the whole difference from `validateChangePassword`: someone
 * arriving from a reset link is there precisely because they do not know the
 * old password, so there is nothing to compare with and no "that's the one you
 * already use" to warn about.
 */
export function validateResetPassword(input: {
  newPassword: string;
  confirmPassword: string;
}): FieldErrors<ResetPasswordField> {
  const errors: FieldErrors<ResetPasswordField> = {};

  if (!input.newPassword) errors.newPassword = "Choose a new password.";
  else if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
    errors.newPassword = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  if (!input.confirmPassword) errors.confirmPassword = "Type the new password again.";
  else if (input.confirmPassword !== input.newPassword) {
    errors.confirmPassword = "These do not match.";
  }

  return errors;
}

// ============================================================
// Recover, and change
// ============================================================

export function validateRecoverPassword(input: { email: string }): FieldErrors<"email"> {
  const email = emailError(input.email);
  return email ? { email } : {};
}

export type ChangePasswordField = "currentPassword" | "newPassword" | "confirmPassword";

/**
 * `confirmPassword` has no server counterpart, deliberately.
 *
 * The server never sees it — it is not in `changePasswordSchema` and there is
 * nothing for it to check. It exists only so that a typo in a field nobody
 * can read is caught before it becomes a password the owner cannot reproduce,
 * which is a lockout rather than an error message.
 */
export function validateChangePassword(input: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}): FieldErrors<ChangePasswordField> {
  const errors: FieldErrors<ChangePasswordField> = {};

  if (!input.currentPassword) errors.currentPassword = "Enter your current password.";

  if (!input.newPassword) errors.newPassword = "Choose a new password.";
  else if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
    errors.newPassword = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  } else if (input.newPassword === input.currentPassword) {
    errors.newPassword = "That is the password you are already using.";
  }

  if (!input.confirmPassword) errors.confirmPassword = "Type the new password again.";
  else if (input.confirmPassword !== input.newPassword) {
    errors.confirmPassword = "These do not match.";
  }

  return errors;
}

/** True when nothing is wrong — the form may be submitted. */
export function isValid(errors: Record<string, string | undefined>): boolean {
  return Object.keys(errors).length === 0;
}
