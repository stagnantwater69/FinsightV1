import type { Request, Response } from "express";
import { z } from "zod";
import * as authService from "../services/auth.service";
import { ApiError } from "../middleware/error.middleware";
import { normalizeEmail } from "../lib/emailPolicy";

/*
 * The auth schemas are EXPORTED for the same reason `confirmSchema` is: the
 * contract tests check real client validation against the real server rules
 * rather than against a copy of them. Both clients now refuse input before
 * sending it, and a client that is stricter than this file locks people out
 * of accounts the server would have created — a copy in a test would drift
 * exactly the way the clients would.
 */
/**
 * The minimum length for any password this system creates.
 *
 * Twelve rather than eight. Eight characters is inside the reach of an offline
 * attack on a leaked hash, and this is a financial record system whose owners
 * will reuse a password they already have. Length is also the only rule here:
 * no character-class requirements, because they reliably produce `Password1!`
 * and stop nobody, and no maximum, because a capped length is what breaks
 * passphrases and password managers.
 *
 * MIRRORED, NOT COPIED, by both clients — `MIN_PASSWORD_LENGTH` in
 * web/src/lib/authValidation.ts and mobile/src/lib/authValidation.ts, with
 * tests asserting the figure. A client stricter than this locks people out of
 * accounts the server would have made; one looser sends requests it knows fail.
 */
export const MIN_PASSWORD_LENGTH = 12;

const passwordField = z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);

/**
 * An address, in the one shape the rest of the system may see it.
 *
 * The transform is not cosmetic: Supabase lowercases addresses on its side, so
 * without it the profile row and the auth identity it mirrors drift apart, and
 * `User_Email`'s case-sensitive unique index stops meaning what it looks like it
 * means. Normalising in the schema puts it before every handler, every service
 * and every lookup, rather than at whichever call sites remembered.
 */
/**
 * The widest address the database can hold.
 *
 * `User_Email` is `VARCHAR(150)`, and without this the schema accepted longer
 * ones: registration then created the Supabase Auth user, failed on the Prisma
 * insert, rolled the auth user back, and answered 500. A too-long address is a
 * validation error and has to be refused as one — before anything is created,
 * with a message under the field, not as a server error after the fact.
 *
 * 150 rather than the RFC's 254 because the column is the binding constraint;
 * the two only need to be reconciled if that column ever widens.
 */
export const MAX_EMAIL_LENGTH = 150;

const emailField = z
  // The ORDER IS LOAD-BEARING, and zod checks left to right:
  //   `.trim()` first, so a pasted address with a trailing space — routine on a
  //   phone keyboard, and what a client that forgot to trim would send — is
  //   cleaned rather than rejected as malformed;
  //   `.email()` next, so the length message below is only ever shown for
  //   something that is otherwise a real address;
  //   `.max()` on the TRIMMED value, so surrounding space cannot push a legal
  //   address over the limit.
  // The transform lowercases last; it cannot run before validation at all.
  .string()
  .trim()
  .email()
  .max(MAX_EMAIL_LENGTH, `Email must be ${MAX_EMAIL_LENGTH} characters or fewer`)
  .transform(normalizeEmail);

/**
 * Which app is asking, so auth emails link back to the right one.
 *
 * A discriminator, deliberately, and not a URL. The redirect target is chosen
 * from configuration in the service; accepting an address here would make this
 * an open redirect carrying a live password-reset token.
 */
const platformField = z.enum(["web", "mobile"]).default("web");

export const registerSchema = z.object({
  /*
   * NO DISPOSABLE-DOMAIN REFUSAL HERE, deliberately — it was tried and removed.
   *
   * The coverage maths kills it in both directions at once. Someone signing up
   * in earnest is not using a throwaway; they want their records back tomorrow,
   * so a blocklist never fires on them. Someone farming accounts to burn the AI
   * and OCR budget uses one of the thousands of services no hand-kept list
   * contains, so it never fires on them either. What is left is a narrow middle
   * that barely exists — set against a false positive that is silent and
   * expensive: an owner whose business email runs on a small provider is turned
   * away, tells nobody, and we never find out.
   *
   * The controls that actually bound the exposure are elsewhere and already
   * hold: confirmation gates every route (PENDING_VERIFICATION reaches no API
   * at all), the per-user limiters bound AI spend, and the paired IP/email
   * limiters bound signup velocity. `isDisposableEmail` survives as a LOGGED
   * SIGNAL in registerUser — see there.
   */
  email: emailField,
  password: passwordField,
  firstName: z.string().min(1).max(100),
  middleName: z.string().max(100).optional(),
  lastName: z.string().min(1).max(100),
  phoneNumber: z.string().max(20).optional(),
  platform: platformField,
});

export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1),
});

export const recoverPasswordSchema = z.object({
  email: emailField,
  platform: platformField,
});

export const resendVerificationSchema = z.object({
  email: emailField,
  platform: platformField,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordField,
});

const deleteAccountSchema = z.object({ currentPassword: z.string().min(1) }).strict();

const updateProfileSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  middleName: z.string().max(100).nullable().optional(),
  lastName: z.string().min(1).max(100).optional(),
  phoneNumber: z.string().max(20).nullable().optional(),
});

/** The caller's own access token, for operations that act on their sessions. */
function bearerToken(req: Request): string {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) throw new ApiError(401, "Missing bearer token");
  return token;
}

/**
 * 202, not 201, and no session.
 *
 * Nothing usable has been created yet: an account exists only once its address
 * is confirmed, so "accepted, go and check your email" is the accurate status.
 * Returning a session here was the reason an address nobody owned could become
 * a working account.
 */
export async function register(req: Request, res: Response) {
  const { platform, ...input } = registerSchema.parse(req.body);
  const result = await authService.registerUser(input, platform);
  res.status(202).json(result);
}

export async function resendVerification(req: Request, res: Response) {
  const { email, platform } = resendVerificationSchema.parse(req.body);
  const result = await authService.resendVerification(email, platform);
  res.status(200).json(result);
}

export async function confirmEmail(req: Request, res: Response) {
  const result = await authService.confirmEmail(bearerToken(req));
  res.status(200).json(result);
}

export async function completePasswordReset(req: Request, res: Response) {
  const result = await authService.completePasswordReset(bearerToken(req));
  res.status(200).json(result);
}

export async function login(req: Request, res: Response) {
  const input = loginSchema.parse(req.body);
  const result = await authService.loginUser(input);
  res.status(200).json(result);
}

/**
 * Ends this device's session. `/logout-all` below ends every device's.
 *
 * They were one endpoint with global scope, which meant the ordinary "Log out"
 * on a phone also signed the owner out of the shop's tablet, silently. Two
 * endpoints so the two intentions can be told apart, and so the destructive one
 * has to be chosen.
 */
export async function logout(req: Request, res: Response) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (token) {
    await authService.logoutUser(token, "local");
  }
  res.status(204).send();
}

export async function logoutEverywhere(req: Request, res: Response) {
  await authService.logoutUser(bearerToken(req), "global");
  res.status(204).send();
}

export async function recoverPassword(req: Request, res: Response) {
  const { email, platform } = recoverPasswordSchema.parse(req.body);
  await authService.requestPasswordRecovery(email, platform);
  // Identical whatever happened inside, including a mail-delivery failure —
  // that is logged rather than shown, because the visitor is not entitled to
  // learn whether this address has an account from the shape of the answer.
  res.status(200).json({ message: "If that email is registered, a reset link has been sent." });
}

export async function changePassword(req: Request, res: Response) {
  const input = changePasswordSchema.parse(req.body);
  await authService.changePassword(req.user!.id, input.currentPassword, input.newPassword, bearerToken(req));
  res.status(200).json({
    message: "Password changed. You're still signed in here; any other devices have been signed out.",
  });
}

export async function getMe(req: Request, res: Response) {
  const profile = await authService.getProfile(req.user!.id);
  res.status(200).json(profile);
}

export async function updateMe(req: Request, res: Response) {
  const input = updateProfileSchema.parse(req.body);
  const profile = await authService.updateProfile(req.user!.id, input);
  res.status(200).json(profile);
}

export async function uploadAvatar(req: Request, res: Response) {
  if (!req.file) {
    throw new ApiError(400, "Photo file is required");
  }
  const profile = await authService.updateAvatar(req.user!.id, req.file.buffer, req.file.mimetype, req.file.originalname);
  res.status(200).json(profile);
}

/**
 * 202: the deletion has been accepted and access has already ended, but the
 * data is destroyed by a background worker. A 204 would claim the erasure was
 * finished at the moment the response was written, which was never true even
 * when it ran inline — it just had nowhere to admit otherwise.
 */
export async function deleteAccount(req: Request, res: Response) {
  const { currentPassword } = deleteAccountSchema.parse(req.body);
  const result = await authService.deleteAccount(req.user!.id, currentPassword);
  res.status(202).json(result);
}
