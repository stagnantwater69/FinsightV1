# Security notes

Findings from the security review on 2026-08-04, and the reasoning behind what
was fixed versus what was accepted. This exists so a later reader — or a later
`npm audit` run that surfaces the same advisory again — does not have to
re-derive the decision from scratch.

## Hosted Supabase audit — 6 August 2026

The initial audit found RLS disabled on all 13 application tables in the
exposed `public` schema. This was resolved on 6 August by migration
`20260806153854_secure_application_tables_from_data_api`.

The web and mobile clients use Supabase for Auth and Storage, while all
application-table access goes through Express/Prisma. The migration therefore:

- enables RLS on every application table, including `_prisma_migrations`;
- revokes all table and sequence privileges from `anon` and `authenticated`;
- removes the default table and sequence privileges those roles would
  otherwise receive from future migrations.

Hosted verification found RLS enabled on 13 of 13 tables, zero table grants for
the two Data API roles, and no effective `SELECT` privilege on `User` for either
role. The backend's `postgres` connection retained access and successfully read
the hosted application tables. The advisor now reports only informational
"RLS enabled with no policy" notices for this deliberate deny-all design; it no
longer reports the critical disabled-RLS findings. Supabase remediation
reference: https://supabase.com/docs/guides/database/database-linter?lint=0013_rls_disabled_in_public

The same audit confirmed that `receipts` and `csv-imports` are private and
`avatars` is public. It still reports leaked-password protection as disabled
and two low-priority missing duplicate-reference indexes. Leaked-password
protection is accepted for synthetic capstone-only accounts, but must be
enabled before the project stores real user credentials.

---

## Accepted, with reasoning

### `react-router-dom` — GHSA-qwww-vcr4-c8h2 (high)

**Advisory:** "React Router: RSC Mode CSRF Bypass Allows Action Execution
Before 400 Response" (CWE-352). Affects `react-router` 7.12.0 – 8.2.0;
`web/package.json` pins `^7.18.1`.

**Not remediated, deliberately.** Two independent reasons:

1. **The vulnerable code path is not reachable in this app.** The advisory is
   specific to **RSC (React Server Components) mode**. FinSight's web client is
   a pure client-side SPA: `web/src/main.tsx` mounts with `createRoot`, routing
   is `BrowserRouter`, and the only router APIs imported anywhere in `web/src`
   are `BrowserRouter`, `Routes`, `Route`, `Link`, `Navigate`, `Outlet`,
   `useLocation`, `useNavigate`, `useParams` and `useSearchParams`. There is no
   server runtime, no `@react-router/serve`, no SSR entry, and no RSC usage.

2. **The CSRF precondition does not hold.** CSRF depends on the browser
   attaching credentials automatically to a cross-site request. Authentication
   here is a bearer token sent explicitly by the client
   (`backend/src/middleware/auth.middleware.ts` reads `Authorization`), not a
   cookie session, so a cross-site form post carries no credentials.

**Why not just take the fix:** `npm audit` offers only a *downgrade* to
`7.11.0`, flagged `isSemVerMajor: true`. There is no forward patch on the 7.12+
line as of this writing. Downgrading a core routing library across a major
boundary — before UAT, to close a finding whose vulnerable mode this app does
not use — trades a real regression risk for no real security gain.

**Revisit when:** a forward-fixing release lands on the 7.x line (upgrade
then), **or** if this app ever adopts React Router's server/RSC mode or moves
authentication to cookies. Either change invalidates the reasoning above and
this must be re-assessed rather than re-accepted.

**Re-check cadence:** run `npm audit` in `web/` monthly.

---

## Fixed

### CSV upload filename was interpolated into the storage key unsanitised

`backend/src/services/storage.service.ts`, `uploadCsvFile`. The object key was
built as `` `${businessProfileId}/${randomUUID()}-${originalname}` `` using the
client-supplied filename verbatim. A crafted name containing `/` or `..` could
steer the written key outside the `<profileId>/` prefix that every other object
in that bucket lives under — and that prefix is what makes an object
attributable to one business.

Object stores generally treat keys as opaque strings rather than filesystem
paths, so this was a latent weakness rather than an active break. Fixed anyway:
`safeStoredFileName` now takes the basename and applies a character allowlist
(`[A-Za-z0-9._-]`, everything else to `_`), strips leading dots, and caps the
length. Covered by `backend/tests/unit/safeStoredFileName.test.ts`, whose
traversal cases were mutation-checked — reverting either the basename split or
the allowlist makes them fail.

The filename is sanitised rather than discarded (unlike `uploadReceiptImage`,
which keeps only the extension) because `signedCsvFileUrl` reads it back out to
name the owner's download; dropping it would regress that.

---

## Verified sound — no action needed

Recorded so a future review does not have to re-check them from zero:

- **Route auth coverage.** Every router under `backend/src/routes/` applies
  `requireAuth`; no route was found missing it.
- **Ownership isolation.** Services scope queries by `businessProfile: { userId }`
  or `requireOwnedBusinessProfile` (`backend/src/lib/ownership.ts`), and return
  **404 rather than 403** on a mismatch, so record existence cannot be probed.
  Covered by `backend/tests/integration/ownershipIsolation.test.ts`.
- **SQL injection.** Prisma exclusively — no `$queryRaw` / `$executeRaw`
  anywhere in `backend/src`.
- **Input validation.** zod on every user-facing controller, several with
  `.strict()` so unknown keys are rejected rather than silently dropped.
- **Error responses.** `backend/src/middleware/error.middleware.ts` returns a
  generic message on 500s; stack traces go to `console.error` only, never to the
  client.
- **Secrets.** None hardcoded in source; `.env` files are gitignored and
  untracked; API keys are used only in request headers and never logged.
- **Upload limits.** `backend/src/middleware/upload.middleware.ts` restricts
  MIME type and size per upload kind.
- **Backend dependencies.** `npm audit --production` in `backend/` reports zero
  vulnerabilities.

---

## Known limitations (not vulnerabilities, but load-bearing to know)

- **Rate limiting is in-memory and single-process**
  (`backend/src/middleware/rateLimit.middleware.ts`, documented in its own
  comments). Correct for the current single-container deployment; behind more
  than one instance the effective limit multiplies by the instance count and
  this needs to move to Redis or the database.
- **No security headers.** No `helmet` — no `X-Content-Type-Options`,
  `X-Frame-Options`, or HSTS. Low impact for a pure JSON API consumed by an SPA
  and a native app, but cheap to add whenever the backend gets a deployment
  hardening pass.
- **No account/business-profile hard delete.** `archiveBusinessProfile` soft-hides
  a profile; there is no in-app path to fully erase a user's data. This matters
  for the deletion promise in `docs/uat-script.md`'s post-session checklist —
  honouring it currently requires direct database access.
- **`mobile/` dependency advisories.** `npm audit` reports issues concentrated in
  Expo build tooling (`@expo/config-plugins` and friends), largely build-time
  rather than runtime. Worth clearing during an Expo SDK upgrade.
