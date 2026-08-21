# Branch push guide — Jah, Jimz, Kurt

How to create and push your assigned feature branches, what files each branch
touches, and what to put in the commit message.

Remote: `finsightv1` → `git@github.com:stagnantwater69/FinsightV1.git`
Base branch: `finsightv1-main`

## Before you start

All of the files listed below **already exist** in `web/src` — this is a
mature codebase, not a blank slate. That means two things:

1. **If you have no pending edits yet**, `git add` + `git commit` on an
   unchanged file will do nothing (git prints a "nothing to commit" status
   instead of erroring). Pushing at that point just publishes an empty
   branch pointer — that's fine if the goal is to reserve the branch name,
   but there's no reviewable diff until you actually change the file.
2. **Some branches below share the same file.** Whoever pushes second needs
   to `git rebase finsightv1-main` (or coordinate with the first person)
   before pushing, or the second PR will conflict. These are flagged
   explicitly under each section.

## General flow (repeat per branch)

```bash
# 1. Make sure you're starting from the latest shared baseline
git checkout finsightv1-main
git pull finsightv1 main

# 2. Create your branch
git checkout -b web/feat/<branch-name>

# 3. Make your changes, then check what's staged
git status
git diff

# 4. Stage only the files that belong to this feature
git add <file1> <file2>

# 5. Commit with a scoped message (see per-branch messages below)
git commit -m "feat(web): <message>"

# 6. Push and set upstream tracking
git push -u finsightv1 web/feat/<branch-name>

# 7. Open the PR link GitHub prints, or go to:
#    https://github.com/stagnantwater69/FinsightV1/pull/new/web/feat/<branch-name>

# 8. Return to main before starting the next branch
git checkout finsightv1-main
```

---

## Jah — Authentication & Account Lifecycle

**`web/feat/login`**
- `web/src/pages/Login.tsx`
- `git commit -m "feat(web): add login page"`

**`web/feat/register`**
- `web/src/pages/Register.tsx`
- `git commit -m "feat(web): add registration page"`

**`web/feat/email-confirmation`**
- `web/src/pages/ConfirmEmail.tsx`
- `git commit -m "feat(web): add email confirmation page"`

**`web/feat/forgot-password`**
- `web/src/pages/RecoverPassword.tsx`
- `git commit -m "feat(web): add forgot password request page"`
- Not `ResetPassword.tsx` — that's the token-based reset flow and belongs to
  Ken's `web/feat/reset-password` branch (already pushed).

**`web/feat/logout-everywhere`**
- `web/src/pages/Profile.tsx` — specifically the `SessionsPanel` component
  (~line 240) and the `onLogOutEverywhere` wiring
- `web/src/context/AuthContext.tsx` — the `logoutEverywhere()` function
- `git commit -m "feat(web): add log out of all devices"`
- ⚠️ **Shares `Profile.tsx`** with `change-password`, `delete-account`, and
  `profile-management` below — see the note at the bottom of this section.

**`web/feat/change-password`**
- `web/src/pages/Profile.tsx` — the `SecurityPanel` component (~line 336)
- `web/src/lib/authValidation.ts` — `validateChangePassword`
- `git commit -m "feat(web): add change password panel"`
- ⚠️ Shares `Profile.tsx` — see note below.

**`web/feat/delete-account`**
- `web/src/pages/Profile.tsx` — the `DeleteAccountPanel` component
  (~line 272)
- `git commit -m "feat(web): add account deletion flow"`
- ⚠️ Shares `Profile.tsx` — see note below.

**`web/feat/profile-management`**
- `web/src/pages/Profile.tsx` — the main `Profile` component and avatar
  upload (top of the file)
- `git commit -m "feat(web): add profile management page"`
- ⚠️ Shares `Profile.tsx` — see note below.

> **Note on the four branches above:** `Profile.tsx` is one file containing
> four logical sections (profile form, sessions/logout-everywhere, change
> password, delete account) as separate inline components. If all four are
> being pushed as genuinely separate PRs, only the *first* one merged will
> apply cleanly — the rest will need a rebase against the updated
> `finsightv1-main` before they can push without conflicts. Simplest fix:
> agree on a merge order for these four with Jah up front, or land them as
> one combined `web/feat/profile-management` PR instead of four.

---

## Jimz — Onboarding & Business Profile

**`web/feat/business-profile-view`**
- `web/src/pages/BusinessProfiles.tsx` (route: `/business-profiles` — single
  active profile view)
- `git commit -m "feat(web): add business profile view"`

**`web/feat/business-profiles-list`**
- `web/src/pages/AllBusinessProfiles.tsx` (route: `/business-profiles/all`)
- `git commit -m "feat(web): add business profiles list"`

**`web/feat/business-profile-create`**
- `web/src/pages/CreateBusinessProfile.tsx`
- `web/src/components/BusinessProfileForm.tsx`
- `web/src/components/BusinessFields.tsx`
- `git commit -m "feat(web): add business profile creation flow"`
- ⚠️ **Shares `BusinessProfileForm.tsx`** with `business-profile-edit` — see
  note below.

**`web/feat/business-profile-edit`**
- `web/src/pages/EditBusinessProfile.tsx`
- `web/src/components/BusinessProfileForm.tsx` (shared with create)
- `git commit -m "feat(web): add business profile edit flow"`

> **Note:** `BusinessProfileForm.tsx` is the shared form used by both create
> and edit. If both branches genuinely need to touch it, land one first and
> rebase the other, or scope the shared-field changes to whichever branch
> owns them and have the other just import unchanged.

---

## Kurt — Records CRUD

**`web/feat/add-expense`**
- `web/src/pages/AddExpense.tsx`
- `git commit -m "feat(web): add expense creation page"`
- Note: `web/src/components/AddExpenseModal.tsx` is a separate quick-add
  modal used from `Records.tsx` (Ken's `records-list` branch) — not part of
  this branch.

**`web/feat/edit-expense`**
- `web/src/pages/EditExpense.tsx`
- `git commit -m "feat(web): add expense edit page"`

**`web/feat/add-sales-record`**
- `web/src/pages/AddSalesRecord.tsx`
- `git commit -m "feat(web): add sales record creation page"`
- Note: `web/src/components/AddSalesModal.tsx` belongs to `Records.tsx`
  (Ken's branch), same caveat as above.

**`web/feat/edit-sales-record`**
- `web/src/pages/EditSalesRecord.tsx`
- `git commit -m "feat(web): add sales record edit page"`

**`web/feat/expense-category-mgmt`**
- `web/src/pages/Categories.tsx`
- `git commit -m "feat(web): add expense category management"`
- Note: `web/src/components/CategorySelect.tsx` is the shared category
  dropdown consumed by `AddExpense.tsx`, `EditExpense.tsx`, `ScanReceipt.tsx`
  (Ken), and `RecurringScheduleForm.tsx`. Only touch it here if the category
  data shape itself is changing — otherwise leave it alone to avoid
  conflicts with those other branches.

---

## Quick reference — who owns what shared file

| File | Branches touching it |
|---|---|
| `web/src/pages/Profile.tsx` | `logout-everywhere`, `change-password`, `delete-account`, `profile-management` (all Jah) |
| `web/src/components/BusinessProfileForm.tsx` | `business-profile-create`, `business-profile-edit` (both Jimz) |
| `web/src/components/CategorySelect.tsx` | `expense-category-mgmt` (Kurt) + `add-expense`, `edit-expense` (Kurt) + `receipt-scan` (Ken) — read-only for most branches |
| `web/src/components/AddExpenseModal.tsx`, `AddSalesModal.tsx` | `records-list` (Ken) only — not Kurt's add/edit pages |
