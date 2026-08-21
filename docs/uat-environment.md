# Setting up the environment for UAT

> **Scope note (6 August 2026):** A separate Supabase UAT environment is not
> required for the current team-only capstone acceptance pass. Use synthetic
> data in the existing development project and follow
> [internal-acceptance-checklist.md](internal-acceptance-checklist.md). The
> isolation guidance below remains applicable if external participants or real
> business data are introduced later.

What to put in front of participants, and why it should not be the development
database. Pairs with `docs/uat-script.md` (what to say and record) and
`scripts/README.md` (how to score the forms afterwards).

---

## Why a separate database

Two reasons, both concrete:

1. **The development database is full of test data.** Hundreds of receipt
   scans and business profiles created while building. A participant's real
   figures landing among them makes the results harder to read, and makes
   "delete my data" harder to honour precisely.

2. **`docs/uat-script.md` promises deletion.** Its after-session checklist
   includes *"Test account and test data removed, if the participant used real
   figures and asked for it"* — and there is currently **no in-app way to hard
   delete** a business profile or account (`archiveBusinessProfile` only
   soft-hides). On a dedicated environment that promise is a one-line answer:
   the whole thing is discarded afterwards. On the shared dev database it means
   hand-picking rows out of a live table.

A participant using their own real business figures has been told those figures
"will only be used for this test". A throwaway environment is what makes that
true by construction rather than by careful bookkeeping.

---

## Two ways to get one

### Option A — a Supabase branch (quickest, if your plan includes it)

Supabase branching clones the project's schema into an isolated database with
its own connection string. Production data does **not** carry over, which is
exactly what is wanted here.

Create it from the Supabase dashboard (Branches → new branch). This is a
**billed** resource on paid plans — check the cost shown before confirming.

> Not done for you: this requires a cost-confirmation step that is not
> available from this environment, so nobody but you can authorise the charge.

### Option B — a second Supabase project (works on any plan)

Create a new project from the Supabase dashboard. More setup than a branch, but
no branching feature required and it is unambiguously separate.

---

## Preparing whichever you chose

**1. Apply the migrations.**

```bash
cd backend
DATABASE_URL="<uat-pooled-url>" DIRECT_URL="<uat-direct-url>" npx prisma migrate deploy
```

Note **both** URLs are overridden — `migrate deploy` reads `DIRECT_URL`, so
setting only `DATABASE_URL` would migrate whatever `DIRECT_URL` still points at,
which is very likely your development project. See the deployment runbook §5.

*Verified:* the full migration chain has been applied to an empty database from
scratch during development and produces the expected schema, so a fresh target
is a supported path rather than an assumption.

**2. Create the storage buckets.** The app does not create them and will fail at
runtime without them:

| Bucket | Visibility |
|---|---|
| `receipts` | private |
| `csv-imports` | private |
| `avatars` | public |

**3. Enable email/password auth** in the new project, and set its redirect URLs
to wherever the app will be served during the sessions.

**4. Point the app at it.** Backend env: `DATABASE_URL`, `DIRECT_URL`,
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Web needs its
Supabase URL/anon key and `VITE_API_BASE_URL` **at build time** — rebuild after
changing them.

**5. Smoke-test before the first participant arrives**, using
`docs/deployment-runbook.md` §8. Do the receipt scan in particular: it touches
Storage, OCR and the vision model in one action, and is the step most likely to
reveal a missing bucket or an unset key.

---

## Where participants actually use it

`docs/uat-script.md` assumes *"a laptop or tablet… on a real device"*, one
participant at a time, with a facilitator present. That means the simplest
arrangement needs no deployment at all:

- **Backend and web running on the facilitator's laptop**, participant using
  that laptop. Nothing is exposed to the internet; the session is in person
  anyway.

If participants should use **their own phone** instead — more realistic, and
the only way to exercise the mobile capture flow properly — the backend has to
be reachable from their device. On the same wifi, the laptop's LAN address is
enough (`VITE_API_BASE_URL` and mobile's API base must point at it, not
`localhost`). A tunnel works too but is not necessary for an in-person session.

**Decide which app each session uses.** The script does not say. Web has had
considerably more verification; the mobile capture session has never been
rendered on a real device at all, so a session on mobile is also the first real
test of that flow — worth doing deliberately, and worth not discovering
mid-session.

---

## Afterwards

- Note the connection details somewhere durable before you tear anything down —
  the raw data behind the results chapter lives there.
- Export or screenshot anything needed for the write-up **first**.
- Then delete the branch or project outright. That is the deletion promise in
  the script, honoured in one action.
