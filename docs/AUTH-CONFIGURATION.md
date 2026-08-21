# Auth configuration — the parts that are not in this repository

The account lifecycle described in [AUTH-HARDENING-PLAN.md](AUTH-HARDENING-PLAN.md)
is implemented in code, but three pieces of it live in the Supabase dashboard
and in deployment environment variables. They cannot be enforced by a migration
or a test, and each of them fails **silently** when it is wrong — which is why
they are written down here rather than left to be rediscovered.

Work through this before any deployment that is not a local `npm run dev`.

---

## 1. Supabase dashboard

### Authentication → Providers → Email

| Setting | Value | Why |
| --- | --- | --- |
| **Confirm email** | **ON** | This is the whole of email ownership. With it off, `signUp` returns an already-confirmed user, and the backend creates the account as `ACTIVE` rather than stranding it at `PENDING_VERIFICATION` — but it also logs a loud `register.rejected` event saying confirmation appears disabled. If you see that event in production, this switch is the reason. |
| **Secure email change** | ON | Requires confirmation on both the old and new address. The app does not currently expose an email change at all, so this is defence in depth for anything done through the dashboard. |
| **Email OTP Expiration** (`MAILER_OTP_EXP`) | **At least 300 seconds (5 minutes).** 3600 (1 hour) is the recommended setting. | How long a confirmation or password-reset link stays valid. Supabase ships this well above five minutes, so if links are dying sooner than that, **this setting is almost certainly not the cause** — see the note below before changing it. Do not raise it past 3600: Supabase's own security advisor flags anything longer, and these links confirm account ownership. |

#### If confirmation links appear to expire immediately

Check the current value first — it is very unlikely to be under five minutes. Two
things fail in a way that is indistinguishable from expiry, and both are far
more common:

- **The link is single use, and something clicked it first.** Mail security
  scanners — Gmail, Outlook/Safe Links, corporate filters, some antivirus
  products — fetch every URL in an incoming message to check it. That fetch
  consumes the one-time token, so the human who clicks afterwards gets a dead
  link. Nothing in the app can prevent this; it is a property of one-time links
  in email. The resend flow on `/auth/confirm` is the remedy.
- **A newer link was issued.** Requesting another confirmation email
  invalidates the earlier one. Someone who clicks the first message after
  pressing "send a new link" gets the same failure.

`confirmEmail` in `backend/src/services/auth.service.ts` deliberately reports
both as one message — "expired or has already been used" — because the client
cannot tell them apart and the fix is identical either way. That wording is not
evidence that the link timed out.

### Authentication → URL Configuration

**Site URL** — the web app's origin (`https://…`). This is where Supabase sends
anyone whose redirect target is not on the allow-list below, so a mistake here
surfaces as "the reset link goes to the home page" rather than as an error.

**Redirect URLs** — add all four, exactly:

```
https://<your-web-host>/auth/confirm
https://<your-web-host>/auth/reset-password
finsight://auth/confirm
finsight://auth/reset-password
```

No wildcards. The backend picks the redirect from `WEB_APP_URL` /
`MOBILE_APP_URL` and never from the request body — a client-supplied
`redirectTo` would be an open redirect carrying a live password-reset token —
so these four must match those variables exactly or Supabase drops the redirect.

### Authentication → Rate Limits

Supabase's own limits sit in front of ours and are worth raising to match
reality: the backend now sends a confirmation email per registration and a
reset email per recovery request. The defaults are sized for testing.

### Project Settings → Auth → SMTP

**Configure a real SMTP provider.** Supabase's built-in mail service is
explicitly for development and is heavily rate-limited; with email confirmation
switched on, hitting its ceiling means registrations that can never be
completed. The failure is quiet by design — recovery and verification answer
identically whether or not delivery worked, so nobody is told an email is
missing. What you get instead is a `recovery.delivery_failed` security event
per failure. **Alert on it.**

### Leaked-password protection

Enable it if your plan includes it (Authentication → Providers → Email →
"Prevent use of leaked passwords"). It is a paid-plan feature, so budget for it
rather than assuming it is there. Nothing in the code depends on it.

---

## 2. Backend environment

| Variable | Local | Deployed | Notes |
| --- | --- | --- | --- |
| `TRUST_PROXY_HOPS` | `0` | `1` behind the bundled nginx | **The process refuses to start in production until this is set.** It is a hop count, never a boolean — see below. |
| `WEB_APP_URL` | `http://localhost:5173` | the web origin | Must match the dashboard's Redirect URLs. |
| `MOBILE_APP_URL` | `finsight://` | `finsight://` | Same. |

### Why `TRUST_PROXY_HOPS` has no production default

Every IP-keyed rate limit resolves the client through it, and both ways of
getting it wrong are silent:

- **Too low** (behind a proxy, set to 0) — `req.ip` is nginx's own container
  address for every caller on earth. All auth traffic shares one bucket, and the
  product's real login limit becomes *ten attempts per fifteen minutes for all
  users combined*. One person with a wrong password locks out everybody.
- **Too high**, or `true` — Express believes the left-most `X-Forwarded-For`
  entry, which is whatever the client wrote, so anyone can mint a fresh bucket
  per request and every limit becomes optional.

Neither is detectable at runtime, so production has to state which it is.
`tests/unit/rateLimit.test.ts` pins the behaviour either side of it.

---

## 3. Deployment checklist

- [ ] `npx prisma migrate deploy` — includes `20260811090000_account_lifecycle`,
      which converts `User_Status` to an enum and lowercases stored emails. It
      **aborts deliberately** if two accounts differ only by the case of their
      address; merge them by hand first (the error names them).
- [ ] `TRUST_PROXY_HOPS`, `WEB_APP_URL`, `MOBILE_APP_URL` set for the environment.
- [ ] All four redirect URLs registered in the dashboard.
- [ ] Confirm email ON; production SMTP configured and a test email received.
- [ ] TLS terminating in front of the app. `nginx/nginx.conf` listens on port 80
      with no TLS; if that is the public edge, bearer tokens cross the wire in
      plaintext and nothing above matters.
- [ ] `/api/v1/health/ready` scraped, and **`stalledAccountDeletions` alerted
      on**. A deletion that has exhausted its retries is a data obligation
      nobody is working on, and it is quiet by design — the owner was already
      told their account was gone.
- [ ] Log aggregation retains the `securityEvent` lines (they carry email
      addresses, so set a retention policy deliberately).

---

## 4. What is deliberately *not* configured

**CAPTCHA.** Deferred, with reasoning recorded in
[AUTH-HARDENING-PLAN.md](AUTH-HARDENING-PLAN.md) Phase 6. In short: email
verification already closes the path that mattered, Supabase's own CAPTCHA
enforcement does not apply to the flow this app uses, and the mobile
integration would add a native dependency to the client whose device story is
the outstanding risk. Revisit when the registration-rate or bounce-rate alerts
above actually fire.

**Disposable-address blocking.** Also deferred, and for the same shape of
reason. A block was implemented and then removed: a hand-kept list misses
anyone actually farming accounts while silently turning away the occasional
real owner on a small provider. Registration now accepts these addresses and
emits a `register.disposable_domain` event instead. **That event is the
tripwire** — if it starts appearing in volume, that is the evidence for adding
a maintained blocklist dataset or a CAPTCHA, in that order.

**MFA.** Out of scope for this stage.
