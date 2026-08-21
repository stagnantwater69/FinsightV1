# Auth & Account Lifecycle Hardening Plan

Status: **implemented, 2026-08-11.** Every phase below is in the codebase; this
document is kept as the record of what was done and why, not as a to-do list.

Two things it describes are deliberately still open, and both are recorded in
place rather than quietly dropped:

- **CAPTCHA** (Phase 6) — deferred by decision, with the reasoning under that
  bullet. A disposable-domain blocklist ships in its place.
- **MFA** (Phase 7) — deferred as scope creep for this stage.

The configuration that lives in the Supabase dashboard and in deployment
environment variables — none of which a migration or a test can enforce — is in
[AUTH-CONFIGURATION.md](AUTH-CONFIGURATION.md). **The work here is not complete
until that checklist has been worked through**; in particular, email
confirmation is a dashboard switch, and `TRUST_PROXY_HOPS` must be set or the
backend will refuse to start in production.

This plan replaces a set of independently-reported auth findings with one ordered
programme of work. The ordering is deliberate: several of the reported fixes
conflict with each other unless the account state machine is settled first, and
two unreported issues outrank most of the reported ones.

---

## 0. The account state machine (settle this before writing code)

Every phase below is an implementation of one edge in this graph. Where a phase
and this diagram disagree, the diagram wins.

```
                    register()
                        |
                        v
              PENDING_VERIFICATION ------ expires (72h) ----> (purged)
                        |
                  email confirmed
                        |
                        v
                     ACTIVE <-----------------+
                     |    |                   |
              suspend|    |request delete     |reinstate
                     v    v                   |
                SUSPENDED  DELETION_PENDING --+
                     |            |
                     |            | background job drains storage,
                     |            | then Auth, then relational rows
                     v            v
                  (login refused)  DELETED (row gone)
```

Rules that fall out of it, to be enforced in exactly one place each:

| Rule | Enforced in |
| --- | --- |
| Only `ACTIVE` may hold an API session | `requireAuth` |
| Only `ACTIVE` may log in | `loginUser` |
| `PENDING_VERIFICATION` has no Prisma-visible profile surface | `toProfile` / `getProfile` |
| Entering `SUSPENDED` or `DELETION_PENDING` revokes all sessions | the transition function |
| Only the background worker may reach `DELETED` | deletion worker |

Transitions live in a single `accountLifecycle.service.ts`. No controller mutates
`status` directly.

---

## Phase 1 — Stop the bleeding (launch blockers)

These are independent of the state machine and can land immediately, in parallel.

### 1.1 Proxy-aware rate limiting

*Problem:* `req.ip` is nginx's fixed container address for every external request
(`backend/src/app.ts` sets no `trust proxy`). The limiter is Postgres-backed and
shared across replicas, so production limits are effectively **10 logins / 15 min
and 5 registrations / hour for the entire product**. One person with a wrong
password locks out every user.

- Set the narrowest correct policy in `app.ts` — `app.set("trust proxy", 1)` for
  the current single-nginx topology, not `true`.
- Add a startup assertion that `env.NODE_ENV === "production"` implies a
  configured proxy policy, so this cannot silently regress.
- Add an integration test asserting two distinct `X-Forwarded-For` values get
  independent buckets, and one asserting a client-supplied
  `X-Forwarded-For: 1.2.3.4, <real>` cannot claim a fresh bucket.
- Layer an email-keyed limiter alongside the IP one on `/auth/login` and
  `/auth/recover-password` (an IP limit alone is either useless or a DoS).

### 1.2 Rate-limit the password oracles

`/auth/change-password` and `DELETE /auth/me` both verify the current password
via `signInWithPassword` and neither carries a limiter. A stolen access token
gets unlimited guesses, with account deletion as the payoff.

- Add `AUTH_REAUTH: { limit: 5, windowMs: 15 * 60_000 }`, keyed per user, to both
  routes.
- On exhaustion, treat it as a security event (Phase 6) — a burst here is not a
  retry loop, it is an attack.

### 1.3 Close the recovery-link session leak

`web/src/lib/supabaseClient.ts` uses `createClient` defaults, so
`detectSessionInUrl` is `true`, and `web/src/lib/api.ts` takes its bearer token
from `supabase.auth.getSession()`. With no redirect configured, a password-reset
link lands on the Site URL and is silently exchanged for a full session — the
recovery email is a working passwordless login.

- Interim (ship today): set `detectSessionInUrl: false` on the web client.
- Permanent: Phase 3 re-enables URL detection only on the dedicated
  `/auth/reset-password` route, via a second client instance scoped to that page.

### 1.4 Revoke the throwaway re-auth sessions

`changePassword` and `deleteAccount` each call
`createPasswordAuthClient().auth.signInWithPassword(...)` and discard the result,
leaving a live refresh token behind every time.

- Hold the client, `await client.auth.signOut()` in a `finally`.
- Better: extract `verifyPassword(email, password)` so there is one place this
  can be got wrong.

**Exit criteria:** two external IPs get independent login quotas; a spoofed
`X-Forwarded-For` does not; the 6th re-auth attempt in 15 minutes is refused; a
recovery link opened in a browser leaves the user signed out; no orphan refresh
tokens after a password change.

---

## Phase 2 — Verified-email registration

*Problem:* `registerUser` sets `email_confirm: true` and issues a session
immediately (`auth.service.ts:42`). Any valid-looking but unowned address becomes
an active account.

- Add the `AccountStatus` enum to Prisma (`PENDING_VERIFICATION`, `ACTIVE`,
  `SUSPENDED`, `DELETION_PENDING`) with a data migration mapping the existing
  free-form `"Active"` string. The column is currently written nowhere and read
  only by `toProfile`, so the migration is cheap — do it now, while it is.
- Drop `email_confirm: true`. Create the Prisma row in `PENDING_VERIFICATION`.
- Registration returns `201` with **no session** and no profile — only a
  "check your email" acknowledgement.
- Add `POST /auth/resend-verification`, rate limited per email.
- Add a confirmation callback that flips `PENDING_VERIFICATION → ACTIVE`
  (see Phase 3 for the shared redirect infrastructure).
- Purge `PENDING_VERIFICATION` rows older than 72h on the existing cleanup job,
  so an abandoned registration frees its email.
- Neutral registration response: *"If this address can be registered, we've sent
  a confirmation email."* Log the real Supabase error against the request ID.
  This is only honest once confirmation is real — it is part of this phase, not a
  separate one.

**Client work:** web `Register.tsx` and mobile register screen both stop calling
`applySession` and render a check-your-email state with a resend affordance.

**Exit criteria:** a registration for an address you do not own yields no session
and no usable account; the confirm link activates it exactly once; an unconfirmed
account cannot log in; registering an already-taken address is indistinguishable
from a fresh one.

---

## Phase 3 — Complete password recovery

*Problem:* neither client can finish a reset. Web stops at "check your inbox"
(`RecoverPassword.tsx:37`); mobile tells the user to go log in with a password
that never changed (`AuthScreens.tsx:339`).

This phase builds the redirect infrastructure Phase 2's confirmation link also
uses — do them adjacently.

- Configure the exact allowed redirect URLs in the Supabase dashboard (both the
  web origin and the mobile scheme). No wildcards.
- Pass `redirectTo` on `resetPasswordForEmail`, chosen per calling client
  (the request body needs a `platform` discriminator, validated against an
  allowlist server-side — never reflect a client-supplied URL).
- **Web:** new `/auth/reset-password` route, with the URL-detecting client from
  1.3 scoped to it. Handle `PASSWORD_RECOVERY`, render new + confirm password,
  call `updateUser({ password })`, handle the expired/invalid/already-used link
  as its own state with a "send me a new link" action.
- **Mobile:** `finsight://auth/reset-password` deep link, same screen, same
  states. Register the linking config in the navigator.
- On success, revoke all other sessions and route to login (see Phase 4).

**Exit criteria:** a full reset completes on both clients; an expired link shows a
recoverable error rather than a blank screen or a silent login; a used link
cannot be replayed.

---

## Phase 4 — One session policy, applied everywhere

*Problem:* mobile signs out after a password change on the belief that
`admin.updateUserById` invalidates sessions (`AuthContext.tsx:161`); web assumes
the opposite (`Profile.tsx:233`). The belief was never verified and the Admin API
generally does **not** revoke sessions.

- **Decide (recommended):** changing or resetting a password keeps the current
  session and revokes every *other* one. This is the industry-standard behaviour
  and avoids punishing the person who just did the right thing.
- Implement it explicitly — do not rely on Supabase side-effects. Call the
  admin sign-out with `others` scope after a successful change, and verify the
  actual behaviour with an integration test rather than a comment.
- **Ordinary logout becomes local scope.** `logoutUser` currently passes
  `"global"` (`auth.service.ts:103`), so logging out on one phone kills every
  device. Split into `POST /auth/logout` (local) and
  `POST /auth/logout-all` (global), and surface "Log out on all devices" in
  profile settings on both clients.
- Same copy, same behaviour, both clients.

**Exit criteria:** a documented policy with a test per branch; two devices, log
out on one, the other survives; change the password, the other device is dropped.

---

## Phase 5 — Durable registration and deletion

### 5.1 Registration compensation

*Problem:* if sign-in fails after the Prisma row is created, the catch block
deletes only the Supabase user (`auth.service.ts:53`), leaving an orphan Prisma
row whose unique email blocks every retry.

Phase 2 largely dissolves this by removing the sign-in step from registration.
What remains:

- Track what was created and compensate for all of it.
- Add an integration test that forces the failure and asserts a clean retry.
- Give `loginUser`'s "No FinSight profile for this account" branch a real
  recovery path — today it is a permanent, self-inflicted lockout with no
  self-service exit.

### 5.2 Durable deletion

*Problem:* deletion runs storage → Auth → Prisma inline (`auth.service.ts:184`).
The code does abort before touching Auth if a storage delete fails — but those
deletes are already irreversible, so the user keeps an account with its files
destroyed. If Prisma fails after Auth succeeds, they keep data they can never
reach.

- `DELETE /auth/me` re-authenticates, transitions to `DELETION_PENDING`, revokes
  all sessions, and returns immediately. Access ends at that instant.
- A retryable background job drains the stages in order, recording each one, and
  deletes relational metadata **last** so a crash is always resumable.
- Add an orphan-storage reconciliation job for objects with no surviving row.
- A `DELETION_PENDING` account cannot log in and cannot be reinstated by the
  user (support-only path).

**Exit criteria:** kill the process at each stage boundary; deletion resumes and
completes on restart; at no point is there a reachable account with destroyed
files.

---

## Phase 6 — Enforcement, normalization, and abuse controls

- **Enforce status.** `requireAuth` (`auth.middleware.ts:20`) checks only that the
  row exists. Add the `ACTIVE` check there and in `loginUser`, with distinct,
  non-enumerating messages per state.
- **Normalize email.** Supabase lowercases; Prisma stores raw in a
  case-sensitive unique column, so the two identities drift and Prisma's
  uniqueness is currently enforced only by Supabase rejecting the duplicate
  first. Normalize (`trim().toLowerCase()`) in the Zod schemas — one place,
  server-side — and backfill existing rows.
- **CAPTCHA — deferred, deliberately.** Note first that because registration goes
  through the Admin API, Supabase's own CAPTCHA enforcement is bypassed
  entirely: the token would have to be verified server-side by us, so there is
  no cheap "flip it on in the dashboard" option here.

  It is not recommended for now. Phase 1.1's per-IP limits, an email-keyed
  limiter, and above all Phase 2's email verification already close the path
  that matters — fake accounts reaching the per-user-limited AI and OCR spend —
  because an unverified account cannot reach those routes at all. Against that,
  the cost is real: `mobile/` has no `react-native-webview`, Turnstile has no
  native RN SDK, and hCaptcha's SDK is a native dependency requiring a config
  plugin and a dev build (no Expo Go) — added to the client whose
  physical-device evidence is the outstanding risk.

  Ship instead, at a fraction of the cost and with no client changes:
  - alerting on registration rate and on email bounce/complaint rate;
  - a `register.disposable_domain` signal on registration.

  **On that last point — a disposable-domain BLOCK was implemented and then
  removed, deliberately.** The coverage maths fails in both directions at once:
  someone signing up in earnest is not using a throwaway inbox, and someone
  farming accounts to burn the AI budget uses one of the thousands of services
  no hand-kept list contains. What remains is a narrow middle that barely
  exists — set against a false positive that is silent and expensive, an owner
  whose business email runs on a small provider being turned away and telling
  nobody.

  This is also what the industry does. Most products verify and stop there;
  those that go further use a *maintained* dataset or a validation API, never a
  hardcoded list in the application repo. Confirmation is the control that
  carries the weight here, and it already does: a `PENDING_VERIFICATION` account
  reaches no API at all. `isDisposableEmail` survives as a logged signal, which
  is free and is the evidence any future decision here would rest on.

  Revisit when the product is genuinely public **and** those tripwires fire.
  Scope it then to registration and recovery only — not login, where lockout
  plus an email-keyed limiter is the right tool and a challenge mostly punishes
  someone who mistyped their password.
- **Recovery observability.** `requestPasswordRecovery` swallows every error
  (`auth.service.ts:107`). Keep the public response identical, but log the
  provider error and add a delivery-failure metric — otherwise an SMTP outage is
  invisible. Configure production SMTP; Supabase's default sender is
  test-grade.
- **Security event log.** Structured, request-ID-correlated events for: login
  success/failure, password change, reset requested/completed, session
  revocation, status transitions, deletion stages, rate-limit exhaustion.

---

## Phase 7 — Password policy

- Raise the minimum to 12 characters in `backend/src/controllers/auth.controller.ts`
  and both `authValidation.ts` copies **together** — the clients validate against
  the exported server schema, and a client stricter than the server locks people
  out of accounts the server would create.
- Add a confirm-password field to registration (it exists for change-password but
  not registration).
- Do not cap length or block paste; let password managers work.
- Enable Supabase leaked-password protection — note this is a paid-plan feature,
  so budget for it rather than assuming availability.
- **Defer MFA.** It is scope creep for this product's stage; revisit after the
  above is live.

---

## Also verify before production (outside auth, surfaced by this review)

- `nginx/nginx.conf` listens on port 80 with no TLS termination and no HSTS. If
  that is the public edge, bearer tokens cross the wire in plaintext and nothing
  above matters.
- `requireAuth` calls Supabase `getUser()` on every single request. A Supabase
  auth hiccup or rate limit takes down the entire API, and it adds a round trip
  to every call. Consider local JWT verification against the project JWKS, with
  the network call reserved for revocation-sensitive operations.

---

## Test matrix (Phase 8 — but written alongside each phase, not after)

End-to-end, both clients:

1. Register → unverified → cannot log in → confirm → active.
2. Register with an existing email → response identical to a fresh one.
3. Abandoned registration expires and frees the email.
4. Full password reset, both platforms, including expired and replayed links.
5. Password change: current session survives, other device is dropped.
6. Logout local vs. logout-all.
7. Suspended account: existing token refused, login refused.
8. Deletion: access ends immediately; process killed mid-drain resumes cleanly.
9. Rate limits: per-IP isolation, spoof resistance, re-auth oracle capped.
10. Registration rollback: forced failure leaves no orphan in either system.
