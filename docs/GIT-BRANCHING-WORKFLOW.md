# Git branching workflow

Here is the simplest recommended workflow from start to finish.

## Phase 1: Put your latest code on GitHub

Your current local work must become the shared baseline.

1. Check which branch you're using:

```bash
git branch --show-current
git status
```

2. Fill in real GitHub usernames in `.github/CODEOWNERS` and
   `.github/pull_request_template.md` (placeholders like
   `@web-member-username`) — these need real usernames before Phase 2's
   collaborator invites and Phase 6's PR reviews can route correctly.

3. Stage and commit your work. Use explicit paths, not `git add .` — an
   untracked report or scratch file sitting in the working tree can get
   swept into a commit by accident:

```bash
git add backend/ mobile/ web/ .github/CODEOWNERS .github/pull_request_template.md
git status   # confirm nothing unexpected is staged before committing
git commit -m "chore: prepare latest project baseline"
```

Before staging, confirm `.env`, passwords, API keys, database dumps, and
`node_modules` are ignored (already handled by `.gitignore` in this repo).

4. Push your existing branch:

```bash
git push -u origin feat/mobile-ui-refine
```

5. On GitHub, create a pull request:

```text
feat/mobile-ui-refine → master
```

This repo's default branch is `master` — there is no `main` branch here.
If you'd rather standardize on `main` going forward, rename it first:
GitHub → Settings → Branches → rename `master` to `main`, then use `main`
for every step below instead.

6. Review and merge the pull request. `master` now contains the latest
   shared project.

## Phase 2: Give members repository access

On GitHub:

```text
Repository → Settings → Collaborators → Add people
```

Add their GitHub accounts with **Write** access — not Admin. Never request
their passwords, tokens, or SSH keys.

## Phase 3: Members update their copies

Members who already cloned the repository run:

```bash
git switch master
git pull origin master
```

New members run:

```bash
git clone <your-repository-url>
cd FinSight
git switch master
```

Everyone should install dependencies according to the project instructions
afterward.

## Phase 4: Create one branch per assignment

Each member creates their own branch from the latest `master`.

Login assignment:

```bash
git switch master
git pull origin master
git switch -c web/feat/login
git push -u origin web/feat/login
```

Mobile camera assignment:

```bash
git switch master
git pull origin master
git switch -c mobile/feat/receipt-camera
git push -u origin mobile/feat/receipt-camera
```

Backend assignment:

```bash
git switch master
git pull origin master
git switch -c backend/feat/receipt-upload
git push -u origin backend/feat/receipt-upload
```

You may create the branches for them, but they should push using their own
GitHub accounts.

## Phase 5: Members complete their tasks

While on their assigned branch, each member:

```bash
git status
git add <files-they-changed>
git commit -m "feat(web): implement login"
git push
```

They should not push directly to `master`.

## Phase 6: Open and review pull requests

On GitHub, the member opens a pull request:

```text
web/feat/login → master
```

You then:

1. Review the changed files.
2. Confirm no secrets or unrelated files were included.
3. Run or check the tests.
4. Request corrections if necessary.
5. Merge when ready.

After merging, delete the feature branch on GitHub.

## Phase 7: Everyone synchronizes again

Before starting another task, each member runs:

```bash
git switch master
git pull origin master
git switch -c web/feat/next-feature
```

Do not reuse an old merged branch for a different task.

## The repeating team cycle

Phases 4 through 7 are permanent — every future commit, feature, or fix
follows this same loop, for every team member including the repo owner.
Phase 1 (direct push to `master`) is a one-time bootstrap step; after it,
nobody pushes directly to `master` again.

```text
Update master
    ↓
Create branch from master
    ↓
Implement and test
    ↓
Commit and push branch
    ↓
Open pull request
    ↓
Review and merge into master
    ↓
Delete branch
    ↓
Pull updated master
```

Your most important immediate action is to fill in real usernames in
CODEOWNERS, safely commit your current work, push `feat/mobile-ui-refine`,
and merge it into `master`. After that, your members can start their
assigned branches from the same updated code.
