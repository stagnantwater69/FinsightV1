import { AccountStatus, type User } from "@prisma/client";
import { supabaseAdmin } from "../config/supabase";
import { prisma } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { securityEvent } from "../lib/securityLog";

/**
 * The account state machine, in one file.
 *
 * WHY IT IS CENTRALISED. Registration, verification, suspension and deletion
 * were each going to need to move an account from one state to another, and
 * each of them also needs to revoke sessions, log, and refuse impossible
 * moves. Spread across four services those rules drift within a release: one
 * path bans the auth user and another forgets, one logs and another does not,
 * and the account that is "suspended" in the database is still answering API
 * calls. Every transition goes through `transition()` below; nothing else
 * writes `status`.
 *
 *                     register()
 *                         |
 *                         v
 *               PENDING_VERIFICATION ---- unconfirmed for 72h ----> (purged)
 *                         |
 *                   email confirmed
 *                         |
 *                         v
 *                      ACTIVE <---------------+
 *                      |    |                 |
 *               suspend|    |request deletion |reinstate
 *                      v    v                 |
 *                 SUSPENDED  DELETION_PENDING-+
 *                      |            |
 *                      |            | drained by the deletion worker
 *                      v            v
 *              (login refused)   (row deleted)
 *
 * Note the edge that is NOT drawn: DELETION_PENDING does not go back to ACTIVE
 * on its own. Deletion destroys storage objects before it touches the database,
 * so by the time anyone changes their mind the files are gone; offering a
 * self-service undo would hand back an account whose receipts had already been
 * shredded. Support can reinstate before the worker starts, which is why the
 * edge exists in code at all.
 */
const ALLOWED: Record<AccountStatus, AccountStatus[]> = {
  [AccountStatus.PENDING_VERIFICATION]: [AccountStatus.ACTIVE],
  [AccountStatus.ACTIVE]: [AccountStatus.SUSPENDED, AccountStatus.DELETION_PENDING],
  [AccountStatus.SUSPENDED]: [AccountStatus.ACTIVE, AccountStatus.DELETION_PENDING],
  [AccountStatus.DELETION_PENDING]: [AccountStatus.ACTIVE],
};

/** States in which the account may hold a session and call the API. */
export function isUsable(status: AccountStatus): boolean {
  return status === AccountStatus.ACTIVE;
}

/**
 * What to tell someone whose account is not usable.
 *
 * Each says enough for the owner to know what to do and nothing about anyone
 * else's account — these are only ever reached AFTER a correct password, so
 * they disclose nothing to someone guessing.
 */
export function statusRefusal(status: AccountStatus): string {
  switch (status) {
    case AccountStatus.PENDING_VERIFICATION:
      return "Confirm your email address first — check your inbox for the link we sent when you registered.";
    case AccountStatus.SUSPENDED:
      return "This account has been suspended. Contact support if you think that is a mistake.";
    case AccountStatus.DELETION_PENDING:
      return "This account is being deleted and can no longer be used.";
    default:
      return "This account is not available.";
  }
}

/**
 * Cuts every existing session for an auth user, by user id rather than by token.
 *
 * `admin.signOut()` needs a JWT belonging to the session being ended, which is
 * exactly what suspension and deletion do not have — the owner is not the one
 * making the request. Banning is the mechanism GoTrue offers for "this identity
 * may no longer authenticate", and it takes effect on refresh as well as on new
 * sign-ins, so a stolen access token dies at its next rotation rather than
 * outliving the suspension.
 */
async function revokeAllSessions(authId: string): Promise<void> {
  const { error } = await supabaseAdmin.auth.admin.updateUserById(authId, { ban_duration: "876000h" });
  if (error) throw new ApiError(502, `Could not revoke sessions: ${error.message}`);
}

/** Undoes {@link revokeAllSessions}. */
async function restoreSessions(authId: string): Promise<void> {
  const { error } = await supabaseAdmin.auth.admin.updateUserById(authId, { ban_duration: "none" });
  if (error) throw new ApiError(502, `Could not restore sign-in: ${error.message}`);
}

interface TransitionOptions {
  /** Recorded on the security event — why this happened, for the audit trail. */
  reason: string;
  /** Extra columns to write in the same statement as the status change. */
  data?: Parameters<typeof prisma.user.update>[0]["data"];
}

/**
 * Moves an account to a new state, or refuses.
 *
 * The auth-side effect happens BEFORE the database write on the revoking
 * transitions and AFTER it on the restoring one, so that an interruption always
 * lands on the safe side: sessions revoked but status stale is a locked account
 * someone can ask support about; status changed but sessions live is a
 * suspension that does not suspend.
 */
export async function transition(
  user: Pick<User, "id" | "authId" | "status">,
  to: AccountStatus,
  { reason, data }: TransitionOptions,
): Promise<User> {
  if (user.status === to) {
    return prisma.user.update({ where: { id: user.id }, data: data ?? {} });
  }
  if (!ALLOWED[user.status].includes(to)) {
    throw new ApiError(409, `An account cannot go from ${user.status} to ${to}.`);
  }

  const revoking = to === AccountStatus.SUSPENDED || to === AccountStatus.DELETION_PENDING;
  if (revoking) {
    await revokeAllSessions(user.authId);
    securityEvent("sessions.revoked", { userId: user.id, scope: "all", reason });
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { ...(data ?? {}), status: to },
  });

  if (!revoking && user.status !== AccountStatus.PENDING_VERIFICATION) {
    // Coming back from SUSPENDED or DELETION_PENDING, the ban has to be lifted.
    // PENDING_VERIFICATION was never banned — it was simply never confirmed.
    await restoreSessions(user.authId);
  }

  securityEvent("account.status_changed", { userId: user.id, from: user.status, to, reason });
  return updated;
}
