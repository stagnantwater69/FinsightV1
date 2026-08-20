import { AccountStatus, Prisma, type User } from "@prisma/client";
import { supabaseAdmin, createAnonAuthClient, createPasswordAuthClient } from "../config/supabase";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { ApiError } from "../middleware/error.middleware";
import { securityEvent } from "../lib/securityLog";
import { isDisposableEmail } from "../lib/emailPolicy";
import { isUsable, statusRefusal, transition } from "./accountLifecycle.service";
import { uploadUserAvatar } from "./storage.service";

interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  phoneNumber?: string;
}

interface LoginInput {
  email: string;
  password: string;
}

interface UpdateProfileInput {
  firstName?: string;
  middleName?: string | null;
  lastName?: string;
  phoneNumber?: string | null;
}

/** Which client an auth email should send the recipient back to. */
export type ClientPlatform = "web" | "mobile";

function toProfile(user: User) {
  return {
    id: user.id,
    firstName: user.firstName,
    middleName: user.middleName,
    lastName: user.lastName,
    email: user.email,
    phoneNumber: user.phoneNumber,
    status: user.status,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt,
  };
}

/**
 * Where Supabase should send someone after they click a link in an auth email.
 *
 * BUILT HERE FROM CONFIGURATION, never from the request. A `redirectTo` echoed
 * back from a client is an open redirect with a live credential attached to it:
 * the reset token travels in the URL, so anyone who could steer the redirect
 * could have the token delivered to themselves. The client says only which of
 * two apps it is, and this picks the address.
 *
 * These must also be registered in the Supabase dashboard under Authentication
 * → URL Configuration → Redirect URLs. Supabase silently falls back to the Site
 * URL for anything not on that list, which presents as "the reset link goes to
 * the wrong page" rather than as an error.
 */
function redirectFor(platform: ClientPlatform, path: "auth/confirm" | "auth/reset-password"): string {
  const base = platform === "mobile" ? env.MOBILE_APP_URL : `${env.WEB_APP_URL.replace(/\/+$/, "")}/`;
  return `${base}${path}`;
}

/**
 * Checks a password without leaving a session behind.
 *
 * Every re-authentication in this file goes through here. The `signOut` in the
 * `finally` is the part that is easy to omit and was omitted: each verification
 * mints a real session with a refresh token, and one discarded per password
 * change accumulates indefinitely on the account — sessions the owner never
 * created, cannot see, and cannot end. Verifying a password must not be a way
 * of creating one.
 */
async function verifyPassword(email: string, password: string): Promise<boolean> {
  const client = createPasswordAuthClient();
  try {
    const { error } = await client.auth.signInWithPassword({ email, password });
    return !error;
  } finally {
    await client.auth.signOut({ scope: "local" }).catch(() => undefined);
  }
}

/**
 * The single answer registration gives, whatever actually happened.
 *
 * It is the same for a brand-new address, an address that is already
 * registered, and an address Supabase rejected — because any difference between
 * those is a way to ask this endpoint whether a given person banks with us.
 * The real outcome goes to the security log against the request id.
 *
 * This wording is only honest because confirmation is real: nothing below
 * issues a session, so "we've sent a confirmation email" is the whole of what
 * happened in every branch.
 */
const REGISTRATION_ACKNOWLEDGEMENT = {
  message: "If that address can be registered, we've sent it a confirmation link. Check your inbox to finish setting up your account.",
} as const;

export async function registerUser(input: RegisterInput, platform: ClientPlatform = "web") {
  securityEvent("register.started", { email: input.email });

  /*
   * OBSERVED, NOT REFUSED. See the note on `registerSchema` for why blocking on
   * this was removed: a hand-kept list misses anyone actually trying and
   * silently turns away the occasional real owner on a small provider.
   *
   * It stays as a tripwire because the signal is free and the alternative is
   * having no idea. One of these a month is noise. A hundred in an afternoon is
   * account farming, and the response to that is a rate limit or a CAPTCHA —
   * decisions that need evidence, which this is.
   */
  if (isDisposableEmail(input.email)) {
    securityEvent("register.disposable_domain", { email: input.email });
  }

  /*
   * OUR OWN ANSWER to "is this address taken", asked before Supabase is.
   *
   * Everything below used to rest on GoTrue's empty-`identities` convention
   * (see the note further down) — a behaviour of a hosted service, undocumented
   * as a contract, and one that changes shape with a DASHBOARD SETTING this
   * repository cannot see or enforce. With confirmation switched off it stops
   * being the signal at all. Depending on it alone meant our uniqueness was
   * enforced by somebody else's configuration, and the failure mode was silent:
   * a duplicate registration that looked like it worked.
   *
   * The profile mirror is a fact we own, backed by the unique index on
   * `User_Email`. Checking it first is not a replacement for that index — a
   * check-then-insert always has a window, and the constraint is what closes it
   * (handled below) — it is what makes the ORDINARY case decidable here rather
   * than remotely.
   *
   * Note the answer is the neutral acknowledgement, not an error. "That email
   * is already registered" is a working oracle for whether a given person banks
   * with us, and the whole endpoint is built to refuse that question.
   */
  const alreadyRegistered = await prisma.user.findUnique({ where: { email: input.email } });
  if (alreadyRegistered) {
    securityEvent("register.rejected", { email: input.email, reason: "address already has a profile" });
    return REGISTRATION_ACKNOWLEDGEMENT;
  }

  const { data, error } = await createAnonAuthClient().auth.signUp({
    email: input.email,
    password: input.password,
    options: { emailRedirectTo: redirectFor(platform, "auth/confirm") },
  });

  if (error || !data.user) {
    /*
     * A weak-password rejection is surfaced; everything else is swallowed.
     *
     * The distinction is whether the message says anything about the ADDRESS.
     * "Password should be at least N characters" describes what the person just
     * typed and is useless to someone probing for accounts — hiding it behind
     * the neutral acknowledgement would strand them on a form that silently
     * never works. "User already registered" describes someone else's account
     * and is exactly what must not come back.
     */
    securityEvent("register.rejected", { email: input.email, reason: error?.message ?? "no user returned" });
    if (error?.code === "weak_password" || /password/i.test(error?.message ?? "")) {
      throw new ApiError(400, error?.message ?? "Choose a stronger password.");
    }
    return REGISTRATION_ACKNOWLEDGEMENT;
  }

  /*
   * How GoTrue says "that address is already taken" without saying it.
   *
   * Signing up an existing address returns 200 with a user-shaped object whose
   * `identities` array is empty, and sends the real owner a "someone tried to
   * register your address" email. Reading it is what lets us skip creating a
   * second profile row without ever branching visibly to the caller.
   */
  if ((data.user.identities?.length ?? 0) === 0) {
    securityEvent("register.rejected", { email: input.email, reason: "address already registered" });
    return REGISTRATION_ACKNOWLEDGEMENT;
  }

  /*
   * `email_confirmed_at` already set means the PROJECT has email confirmation
   * switched off in the dashboard — a setting this repository cannot enforce.
   * Rather than mint accounts that are stuck at PENDING_VERIFICATION forever
   * because no confirmation email will ever arrive, the account is created
   * usable and the misconfiguration is logged loudly.
   */
  const confirmationDisabled = Boolean(data.user.email_confirmed_at);
  if (confirmationDisabled) {
    securityEvent("register.rejected", {
      email: input.email,
      reason:
        "Supabase returned an already-confirmed user: email confirmation appears to be DISABLED for this project. " +
        "Enable Authentication → Providers → Email → Confirm email, or registration does not prove ownership.",
    });
  }

  try {
    await prisma.user.create({
      data: {
        authId: data.user.id,
        firstName: input.firstName,
        middleName: input.middleName,
        lastName: input.lastName,
        email: input.email,
        phoneNumber: input.phoneNumber,
        status: confirmationDisabled ? AccountStatus.ACTIVE : AccountStatus.PENDING_VERIFICATION,
      },
    });
  } catch (err) {
    /*
     * COMPENSATION, and it has to cover both systems.
     *
     * The previous version deleted the Supabase user and left the Prisma row,
     * whose unique email then blocked every retry — an account that could
     * neither be used nor recreated without someone opening a database console.
     * Here the Prisma insert is the last thing to happen, so there is only ever
     * the auth user to undo; `deleteMany` is belt-and-braces for the case where
     * the failure was a timeout on a write that actually landed.
     */
    await prisma.user.deleteMany({ where: { authId: data.user.id } }).catch(() => undefined);
    await supabaseAdmin.auth.admin.deleteUser(data.user.id).catch(() => undefined);
    securityEvent("register.rolled_back", {
      email: input.email,
      reason: err instanceof Error ? err.message : "profile insert failed",
    });

    /*
     * P2002 on this insert means the unique index caught a duplicate the
     * lookup above did not — the window between the two, or a profile whose
     * auth identity had been removed from Supabase separately. Either way the
     * address IS registered, so the answer has to be the one every other
     * "already registered" branch gives.
     *
     * Answering 500 here, as this used to, put the enumeration oracle back
     * regardless of everything else in this function: a taken address got a
     * server error and a free one got the acknowledgement, which is a reliable
     * way to ask this endpoint about any address you like. The rollback above
     * has already run, so nothing is left behind by returning quietly.
     */
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      securityEvent("register.rejected", { email: input.email, reason: "address already registered (unique constraint)" });
      return REGISTRATION_ACKNOWLEDGEMENT;
    }

    throw new ApiError(500, "Could not finish creating your account. Please try again.");
  }

  return REGISTRATION_ACKNOWLEDGEMENT;
}

/**
 * Sends the confirmation email again.
 *
 * Answers identically whether or not there is anything to resend, for the same
 * reason registration does — and resending is otherwise a cleaner enumeration
 * oracle than registration itself, since it has no side effect to hide behind.
 */
export async function resendVerification(email: string, platform: ClientPlatform = "web") {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user?.status === AccountStatus.PENDING_VERIFICATION) {
    const { error } = await createAnonAuthClient().auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: redirectFor(platform, "auth/confirm") },
    });
    if (error) {
      securityEvent("recovery.delivery_failed", { email, kind: "verification", reason: error.message });
    } else {
      securityEvent("verification.resent", { userId: user.id, email });
    }
  }
  return REGISTRATION_ACKNOWLEDGEMENT;
}

/**
 * Turns a confirmed email into a usable account.
 *
 * The client sends the access token it got from the confirmation link rather
 * than any identifier of its own choosing: the token is the only part of that
 * exchange the client cannot forge, and `getUser` verifies it against Supabase.
 * Trusting a user id in the body would let anyone activate any pending account.
 */
export async function confirmEmail(accessToken: string) {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data.user) {
    throw new ApiError(400, "That confirmation link has expired or has already been used. Request a new one below.");
  }
  if (!data.user.email_confirmed_at) {
    throw new ApiError(400, "That link did not confirm your email address. Request a new one below.");
  }

  const user = await prisma.user.findUnique({ where: { authId: data.user.id } });
  if (!user) {
    throw new ApiError(404, "There is no FinSight profile for this account.");
  }

  if (user.status === AccountStatus.PENDING_VERIFICATION) {
    await transition(user, AccountStatus.ACTIVE, { reason: "email confirmed" });
    securityEvent("register.verified", { userId: user.id, email: user.email });
  }

  // Idempotent on purpose: mail clients pre-fetch links, and a second click
  // should say "you're all set", not "that link is invalid".
  return { message: "Your email address is confirmed. You can log in now." };
}

export async function loginUser(input: LoginInput) {
  const { data, error } = await createPasswordAuthClient().auth.signInWithPassword({
    email: input.email,
    password: input.password,
  });

  if (error || !data.session) {
    securityEvent("login.failed", { email: input.email, reason: error?.message ?? "no session" });
    throw new ApiError(401, "Invalid email or password");
  }

  // `let` because the reconciliation below may re-read it after a status change.
  let user = await prisma.user.findUnique({ where: { authId: data.user.id } });
  if (!user) {
    securityEvent("login.failed", { email: input.email, reason: "no FinSight profile for auth user" });
    throw new ApiError(401, "Invalid email or password");
  }

  /*
   * SELF-HEAL: Supabase says the address is confirmed, our mirror says it is not.
   *
   * `status` is a CACHE of a fact that lives in GoTrue, and the only thing that
   * normally refreshes it is `confirmEmail` — which runs in the browser, after
   * the confirmation link redirects back into the app. Every step of that
   * return trip can fail without the address being any less confirmed: the
   * redirect URL not on Supabase's allow-list (it silently falls back to the
   * Site URL), the web app not running at WEB_APP_URL, a mail scanner spending
   * the one-time token before the owner clicks, a closed tab.
   *
   * When that happened the account was UNRECOVERABLE by design. Resending does
   * nothing, because GoTrue will not re-send a signup confirmation to an
   * address it already considers confirmed; re-registering does nothing, because
   * an existing address returns the neutral acknowledgement without sending
   * mail. Both silences are deliberate and correct, and together they left the
   * owner locked out with no path back and nothing on screen to explain it.
   *
   * Trusting `email_confirmed_at` here weakens nothing: it is the same
   * authority `confirmEmail` consults, delivered over the same admin channel,
   * and it is only read after a correct password. This is the cache catching up
   * with the truth, not a new way to become confirmed.
   */
  if (user.status === AccountStatus.PENDING_VERIFICATION && data.user.email_confirmed_at) {
    await transition(user, AccountStatus.ACTIVE, { reason: "email confirmed (reconciled at login)" });
    securityEvent("register.verified", { userId: user.id, email: user.email, via: "login reconciliation" });
    user = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  }

  /*
   * The status gate. Reached only after a correct password, so the specific
   * reason can be given — the person on the other end has already proved the
   * account is theirs.
   */
  if (!isUsable(user.status)) {
    securityEvent("login.refused_status", { userId: user.id, email: user.email, status: user.status });
    throw new ApiError(403, statusRefusal(user.status));
  }

  securityEvent("login.succeeded", { userId: user.id, email: user.email });
  return { profile: toProfile(user), session: data.session };
}

/**
 * Ends sessions for the token's owner.
 *
 * `local` is the default because "Log out" means this device. Global sign-out
 * was the old behaviour and it meant that logging out at the shop counter also
 * signed the owner out of the phone in their pocket, with nothing on screen to
 * say so. "Log out everywhere" is now a separate, deliberate action.
 */
export async function logoutUser(accessToken: string, scope: "local" | "global" = "local") {
  await supabaseAdmin.auth.admin.signOut(accessToken, scope).catch(() => undefined);
  securityEvent("sessions.revoked", { scope });
}

export async function requestPasswordRecovery(email: string, platform: ClientPlatform = "web") {
  securityEvent("recovery.requested", { email });

  /*
   * The CALLER is always told the same thing — see the controller — but the
   * failure is no longer thrown away.
   *
   * Swallowing it silently meant an expired SMTP credential or a project over
   * its mail quota looked exactly like a working system: every owner asking for
   * a reset got "check your inbox", nothing arrived, and no signal existed
   * anywhere that anything was wrong. Anonymity is owed to the visitor, not to
   * our own operations.
   */
  const { error } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
    redirectTo: redirectFor(platform, "auth/reset-password"),
  });
  if (error) {
    securityEvent("recovery.delivery_failed", { email, kind: "password-reset", reason: error.message });
  }
}

/**
 * Finishes a reset: the new password is already set, this cleans up after it.
 *
 * The password change itself happens on the client, against the recovery token,
 * because that token is the only credential in play and it must not be sent to
 * us. What the client cannot do is revoke the sessions that existed before —
 * the whole point of a reset is often that somebody else is holding one.
 */
export async function completePasswordReset(accessToken: string) {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data.user) {
    throw new ApiError(401, "That reset link is no longer valid.");
  }

  const user = await prisma.user.findUnique({ where: { authId: data.user.id } });
  if (!user) {
    throw new ApiError(404, "There is no FinSight profile for this account.");
  }

  /*
   * A reset also confirms the address: the link only arrives in the inbox, so
   * completing one proves the same thing the confirmation email asks for.
   * Without this, anyone who registered and then used "forgot password" instead
   * of the confirmation link would be stuck at PENDING_VERIFICATION with a
   * working password and no way in.
   */
  if (user.status === AccountStatus.PENDING_VERIFICATION) {
    await transition(user, AccountStatus.ACTIVE, { reason: "email proven by password reset" });
    securityEvent("register.verified", { userId: user.id, email: user.email });
  }

  await supabaseAdmin.auth.admin.signOut(accessToken, "global").catch(() => undefined);
  securityEvent("password.changed", { userId: user.id, email: user.email, via: "reset" });
  securityEvent("sessions.revoked", { userId: user.id, scope: "global", reason: "password reset" });

  return { message: "Your password has been changed. Log in with it to continue." };
}

/**
 * Changes a password for someone who is already signed in.
 *
 * SESSION POLICY, applied identically here and on both clients: the session
 * doing the changing survives, every other session is revoked. The person who
 * just proved they know the current password should not be thrown back to a
 * login form for having done the right thing; anyone else holding a token
 * should be gone by the time this returns.
 *
 * `others` is passed explicitly rather than relied upon as a side effect of the
 * password update. The mobile client used to sign itself out on the belief that
 * Supabase revoked sessions automatically on an admin password change — it does
 * not, so that belief left every other device signed in while inconveniencing
 * the only device that was entitled to stay.
 */
export async function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
  accessToken: string,
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new ApiError(404, "Profile not found");
  }

  // A valid access token alone isn't enough — a leaked or borrowed token
  // shouldn't be able to lock the real owner out of their own account.
  if (!(await verifyPassword(user.email, currentPassword))) {
    securityEvent("login.failed", { userId, email: user.email, reason: "wrong current password on change" });
    throw new ApiError(400, "Current password is incorrect");
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(user.authId, { password: newPassword });
  if (error) {
    throw new ApiError(400, error.message);
  }

  await supabaseAdmin.auth.admin.signOut(accessToken, "others").catch(() => undefined);
  securityEvent("password.changed", { userId, email: user.email, via: "profile" });
  securityEvent("sessions.revoked", { userId, scope: "others", reason: "password changed" });
}

export async function getProfile(userId: number) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new ApiError(404, "Profile not found");
  }
  return toProfile(user);
}

export async function updateProfile(userId: number, input: UpdateProfileInput) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: input,
  });
  return toProfile(user);
}

export async function updateAvatar(userId: number, buffer: Buffer, mimetype: string, originalname: string) {
  const avatarUrl = await uploadUserAvatar(userId, buffer, mimetype, originalname);
  const user = await prisma.user.update({ where: { id: userId }, data: { avatarUrl } });
  return toProfile(user);
}

/**
 * Starts a deletion. Does not perform one.
 *
 * WHY THIS RETURNS BEFORE ANYTHING IS DESTROYED. Deletion used to run inline:
 * storage objects, then the auth user, then the database row. Each step is
 * irreversible and the request could end between any two of them, so a dropped
 * connection or a Supabase blip left an account whose receipts had been shredded
 * but which still logged in, or an unreachable pile of records with no way to
 * sign in and remove them. Neither state is one an owner can get themselves out
 * of.
 *
 * Now the request does the two things that must be synchronous and immediate —
 * prove it is the owner, and end their access — and a retryable worker does the
 * destroying, recording how far it got so a crash resumes rather than restarts.
 */
export async function deleteAccount(userId: number, currentPassword: string): Promise<{ message: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, "Profile not found");

  if (!(await verifyPassword(user.email, currentPassword))) {
    securityEvent("login.failed", { userId, email: user.email, reason: "wrong password on account deletion" });
    throw new ApiError(400, "Current password is incorrect");
  }

  await transition(user, AccountStatus.DELETION_PENDING, {
    reason: "owner requested deletion",
    data: { deletionRequestedAt: new Date(), deletionStage: "REQUESTED", deletionAttempts: 0, deletionLastError: null },
  });
  securityEvent("account.deletion_requested", { userId, email: user.email });

  return { message: "Your account is being deleted. You have been signed out and can no longer sign in." };
}
