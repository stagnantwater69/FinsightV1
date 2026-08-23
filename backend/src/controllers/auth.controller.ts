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

/**
 * The guided tour's four states, as the clients actually name them.
 *
 * NOT A FREE STRING. The value is written by web's TourContext and mobile's
 * tourContextValue.ts and read back by both, so a typo'd status stored here
 * would present as a tour that never starts on one client and never stops on
 * the other, with nothing in the request to say which end was wrong. The union
 * is the same one `TourStatus` declares in web/src/lib/tourStorage.ts and
 * mobile/src/lib/tourStorage.ts; its longest member is 11 characters, which is
 * why `User_TourStatus` is VARCHAR(20) rather than something tighter.
 *
 * EXPORTED for the reason the auth schemas above are: the contract tests check
 * the clients against the real rule here rather than a restated copy, which
 * would agree with itself forever.
 */
export const TOUR_STATUSES = ["not_started", "in_progress", "completed", "skipped"] as const;

/**
 * The furthest step index this will store.
 *
 * `tourStep` is an index into each client's own TOUR_STEPS array (11 entries on
 * web today), saved so an interrupted tour resumes where it stopped. The cap is
 * deliberately well above that rather than pinned to it: the two clients add and
 * reorder steps independently of the API, and a bound that tracked the current
 * step count would start rejecting a legitimate save the moment either client
 * grew a step. What this has to stop is a value that is not a step index at all
 * — negative, fractional, or large enough to look like an id — not an off-by-one.
 */
export const MAX_TOUR_STEP = 100;

/**
 * Account-level preferences, all of them optional.
 *
 * THE OPTIONALITY IS THE FEATURE. These are written from two unrelated places —
 * a settings toggle and the tour overlay advancing a step — and neither knows
 * what the other last stored. A whole-object write from the settings screen
 * would restart an interrupted tour; one from the overlay would silently
 * un-dismiss the mascot. An absent key means "leave it alone".
 *
 * `tourStatus` and `tourStep` additionally accept null, which is how a client
 * resets the tour to "the server has never been told" — distinct from not
 * mentioning it.
 *
 * THEME IS ABSENT ON PURPOSE. It is a per-device choice and stays in client
 * storage; a phone in dark mode at night should not drag a desktop with it.
 */
export const updatePreferencesSchema = z
  .object({
    showDashboardMascotMessage: z.boolean().optional(),
    tourStatus: z.enum(TOUR_STATUSES).nullable().optional(),
    tourStep: z.number().int().min(0).max(MAX_TOUR_STEP).nullable().optional(),
    tourAlwaysShow: z.boolean().optional(),
  })
  // `.strict()` because a misspelled key here is a client bug that would
  // otherwise look like a preference which silently refuses to stick, and the
  // refine catches the same bug's other shape: an empty body, where answering
  // 200 would report success for a write that never happened.
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one preference to update",
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

/**
 * Preferences are their own surface rather than more keys on PATCH /auth/me,
 * because they are a different kind of thing: the identity fields there are the
 * account's record of who the owner is, these are how the app should behave for
 * them. Someone toggling the mascot off should not be sending a name change.
 *
 * Scoped by `req.user!.id` and nothing else. There is no id in the path, the
 * query or the body — `.strict()` would reject one — so this route has no way to
 * name another account's row, which is why there is no ownership check beyond
 * requireAuth: there is no other row it could reach. Reads come back with the
 * profile from GET /auth/me, which both clients already fetch on sign-in.
 */
export async function updateMyPreferences(req: Request, res: Response) {
  const input = updatePreferencesSchema.parse(req.body);
  const preferences = await authService.updatePreferences(req.user!.id, input);
  res.status(200).json(preferences);
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
