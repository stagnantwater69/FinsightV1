# Weekly Progress Roadmap (Post-Feature-Complete)

Built from the Aug 15 informal progress report, the Feature Inventory & Team
Task Distribution document, and the repository state as of 2026-08-19
(branch `feat/mobile-ui-refine`, 24 files pending commit).

## Where things actually stand

The Aug 15 report is a **completion report**, not a progress report — nearly
every feature in the inventory reads "Fully Implemented," and the
inventory's own methodology note confirms no stub or placeholder features
were found. Reporting more feature work from here would either repeat what's
already done or invent busywork. The plan below shifts the weekly story to
what's genuinely unfinished: stabilization, testing, validation, and
deployment readiness.

| Area | State | What's actually left |
|---|---|---|
| Core features (web + mobile + backend) | Implemented | No stub/placeholder features found — this is real, not a gap. |
| Uncommitted working tree | Pending | 24 modified files (anomaly detection, mobile UI, web charts/pages) and 2 untracked files sitting uncommitted right now. |
| Mobile camera / permission / lifecycle | Needs device testing | Explicitly zero automated coverage (CLAUDE.md hard rule) — only physical-device verification counts as evidence. |
| Receipt-capture rehearsal on presentation phone | Pending | Named directly as "next tasks" in the Aug 15 report. |
| OCR/AI accuracy corpus | Partial | Mostly synthetic today (CLAUDE.md hard rule) — needs a real-receipt accuracy pass before it can be cited as evidence. |
| CSV import with real-world files | Pending | Listed in the inventory's own teammate task list; not yet run. |
| Teammate polish/testing backlog (Part 4 of inventory) | Pending | ~14 discrete Easy/Moderate tasks assigned to Jah/Jimz/Kurt, none marked done yet. |
| Deployment / CI / runbook | Partial | docker-compose and CI exist per repo layout; no rehearsed deploy or backup/recovery doc yet. |
| Full presentation rehearsal | Pending | Named directly as "next tasks" in the Aug 15 report. |

## Team split

The inventory already assigns Jah, Jimz, and Kurt a fixed slice of
Easy/Moderate work (Part 4 & 5) on top of Ken's implementation. That backlog
is spread across weeks 1–6 below instead of dumped in one week, so each
person has a standing weekly contribution and Ken has something concrete to
integrate every Saturday rather than a pile at the end.

| Person | Standing backlog (from the inventory) |
|---|---|
| **Jah** | FAQ content (web + mobile), tutorial step content (mobile), proofread Privacy/Terms, password-strength indicator |
| **Jimz** | Empty-state audit/polish, skeleton-loader verification, swipe-gesture testing (mobile Records), theme/contrast verification (web), currency input masking |
| **Kurt** | Receipt-scanning UX testing (real receipts), CSV import testing (real-world files), notification read/mark-all testing, onboarding skip/resume testing, AI chat starter-prompt copy |
| **Ken** | Integrates each teammate's PR into the stabilized build, re-runs the verification gate, and owns everything the inventory marks difficult/system-critical (security, AI/OCR core, anomaly detection, deployment). |

## Eight Saturdays, one honest arc

Each week closes out one category from the table above. Nothing here is
invented to fill a slot — every task traces back either to the "next tasks"
line in your own report or to a task already named in the feature
inventory.

### Week 1 — Sat, Aug 22, 2026
**Stabilize the working tree, verify the camera on real hardware**

Tasks:
- Review and commit the 24 pending files in logical, reviewable groups (anomaly detection, mobile UI, web charts) rather than one sweep
- Run the full verification gate on all three projects post-commit
- Run the receipt-capture flow end-to-end on the actual presentation Android phone
- Test app behavior under network interruption and backgrounding mid-scan

Team split:
- **Kurt** — scans a range of real receipts on the presentation phone and logs confusing UI/error moments (feeds directly into Ken's device verification)
- **Jah** — starts drafting mobile tutorial step content and expanding FAQ entries (no dependency on this week's stabilization work)
- **Ken (integration)** — merges the 24 pending files, folds Kurt's device findings into the camera fixes, merges Jah's content as a doc/copy PR

Evidence for adviser:
- Clean git log with scoped commit messages
- Passing typecheck/build/test output for backend, web, mobile
- Short screen recording of a scan surviving a dropped connection and a backgrounding event
- Kurt's log of UI friction points found during device testing

Report text:
> This week we organized and committed the development changes carried over from last week, then verified the complete receipt-capture flow on the physical presentation device, including behavior during network interruption and app backgrounding. Kurt tested with real receipts and logged UX issues; Jah began drafting tutorial and FAQ content.

### Week 2 — Sat, Aug 29, 2026
**Close the QA and security loop**

Tasks:
- Finish the in-flight anomaly-detection and aiContext test work already visible in the working tree
- Re-verify ownership isolation and deny-all RLS after the recent service changes
- Load-test durable rate limiting on auth and upload endpoints
- Triage and close any test gaps the Week 1 gate run surfaced

Team split:
- **Jah** — proofreads Privacy/Terms on web and mobile for accuracy and consistency (pairs naturally with this week's security review)
- **Jimz** — starts the theme/color-contrast verification pass across web pages (independent of the backend work, can run anytime)
- **Ken (integration)** — merges Jah's copy fixes and Jimz's contrast fixes alongside the security/QA changes, confirms neither touched RLS-sensitive code paths

Evidence for adviser:
- Updated test count (baseline: 845) with a short delta note
- Security checklist: ownership scoping, RLS posture, rate-limit behavior under repeated requests
- List of legal-copy corrections and contrast issues found so far

Report text:
> This week's focus was quality assurance: we finished the in-progress anomaly-detection tests, re-verified that every query stays scoped to the authenticated user's business profile, and load-tested rate limiting on sensitive endpoints. Jah proofread the legal pages and Jimz began a contrast pass across the web app.

### Week 3 — Sat, Sep 5, 2026
**Validate CSV import and duplicate detection against real data**

Tasks:
- Import a range of real bank/POS CSV exports (varied formats, encodings, mixed-file cases)
- Document every parsing edge case found, fix what's safe to fix without touching core detection heuristics
- Validate the duplicate/near-duplicate/recurring-pattern queue against the imported data

Team split:
- **Kurt** — owns this week's headline task: imports the real bank/POS CSV files on web and mobile, documents every parsing edge case
- **Jimz** — builds currency input formatting/masking for the expense and sales forms (relevant since CSV-created records feed those same forms)
- **Ken (integration)** — fixes the parsing issues Kurt surfaces (without touching the core detection heuristics), merges Jimz's masking component, validates the anomaly queue against the imported data

Evidence for adviser:
- Table of CSV sources tested vs. issues found vs. resolved
- Before/after screenshots of the flagged-records review queue
- Before/after screenshots of currency formatting in the record forms

Report text:
> This week Kurt tested CSV import against real bank and point-of-sale export files and documented the parsing issues found; we fixed what we could and validated the duplicate/recurring-pattern detection queue against that same data. Jimz added currency formatting to the expense and sales forms.

### Week 4 — Sat, Sep 12, 2026
**Measure real-receipt OCR/AI accuracy**

Tasks:
- Scan a broad set of genuine physical receipts (not the synthetic corpus) across lighting/crumple/fade conditions
- Record the extraction-vs-user-correction feedback metrics already built into the pipeline
- Tune AI category suggestion based on the correction patterns observed

Team split:
- **Kurt** — continues logging OCR/UX friction across the broader real-receipt set (extends Week 1's device testing into a proper accuracy pass)
- **Jah** — builds the password-strength indicator for the Change Password forms (web + mobile), independent of this week's OCR focus
- **Ken (integration)** — tunes AI category suggestion from Kurt's correction data, merges Jah's password-strength component into both platforms' account-settings screens

Evidence for adviser:
- Correction-rate metric before/after tuning, clearly labeled as real-receipt evidence
- Sample of corrected extractions with notes on failure modes
- Screenshot of the password-strength indicator live on web and mobile

Report text:
> This week we tested receipt scanning against real physical receipts rather than the synthetic test set, measured how often users had to correct the extracted values, and used that feedback to tune AI category suggestion. Jah added a password-strength indicator to the account-security screens on both platforms.

### Week 5 — Sat, Sep 19, 2026
**Verify analytics across account states, pass accessibility**

Tasks:
- Walk the Dashboard, Expense Insight, Recovery Target, and Spending Impact screens across new/thin-data/mature accounts
- Verify Classic/Light/Dark contrast on every web page
- Test reduced-motion behavior across every animated mobile component

Team split:
- **Jimz** — owns this week's headline task: finishes theme/contrast verification across all three web themes and tests reduced-motion behavior on every animated mobile component
- **Jah** — finishes tutorial content and syncs FAQ copy between web and mobile so both platforms match
- **Ken (integration)** — fixes contrast/motion issues Jimz flags, confirms token changes stay centralized (per the design-system rule in the inventory), merges Jah's synced content

Evidence for adviser:
- Screenshot set: same screens across three account-age scenarios
- Accessibility checklist: contrast pass/fail per theme, reduced-motion pass/fail per component
- Diff showing FAQ/tutorial copy now matching across platforms

Report text:
> This week we verified dashboard and insight accuracy across new, thin-data, and mature accounts. Jimz completed a contrast pass across all three themes and verified reduced-motion behavior on mobile; Jah finished tutorial content and synced FAQ copy between platforms.

### Week 6 — Sat, Sep 26, 2026
**Close the teammate polish backlog**

Tasks:
- Work through the inventory's Part 4 list: empty states, skeleton accuracy, swipe-gesture thresholds, currency masking, password-strength indicator
- Test tablet-sized breakpoints on the web app shell
- Sync FAQ/legal/tutorial copy between web and mobile

Team split:
- **Jimz** — closes the remaining Part 4 items: empty-state audit, skeleton-loader verification, swipe-gesture testing on mobile Records
- **Kurt** — tests onboarding skip/resume across app restarts on both platforms, and drafts refined AI chat starter-prompt copy per module
- **Jah** — final proofreading pass on all content shipped this cycle (FAQ, tutorials, legal)
- **Ken (integration)** — merges the full remaining Part 4 backlog, re-runs the full verification gate on all three projects to confirm nothing regressed

Evidence for adviser:
- Checklist of the ~14 Part 4 tasks with each marked closed
- Before/after screenshots for the visual fixes
- Onboarding skip/resume test notes; sample of new AI chat starter prompts

Report text:
> This week the team closed out the polish and QA backlog identified in the feature inventory — empty states, loading skeletons, swipe gestures, input formatting, onboarding flow testing, AI chat prompt copy, and content proofreading — and re-verified the full test suite after integrating it all.

### Week 7 — Sat, Oct 3, 2026
**Deployment rehearsal and documentation**

Tasks:
- Rehearse a full deploy through the existing CI/Docker pipeline to a staging environment
- Write the backup/recovery procedure and a deployment runbook
- Bring README and API documentation in line with current behavior

Team split:
- **Jah, Jimz, Kurt** — run a full UAT pass against the staging deployment, each smoke-testing the areas they own (auth/content, UI/records, onboarding/CSV/AI chat) and filing anything that breaks post-deploy
- **Ken (integration)** — owns the deploy, runbook, and doc updates; triages whatever the team's staging UAT surfaces

Evidence for adviser:
- Staging deployment screenshot/URL and CI run link
- Runbook and backup/recovery document
- Completed UAT checklist from Jah/Jimz/Kurt against staging

Report text:
> This week we rehearsed a full deployment through the CI/Docker pipeline to staging, documented the backup and recovery procedure, and updated the README and API documentation to match current behavior. The team ran a UAT pass against staging and confirmed their respective areas held up post-deploy.

### Week 8 — Sat, Oct 10, 2026
**Full rehearsal, feature-complete sign-off**

Tasks:
- Run the entire presentation flow on a clean demo account with synthetic financial data
- Record backup screenshots/video in case of live-demo failure
- Fold in any outstanding adviser feedback from prior weeks
- Formally declare the system feature-complete and presentation-ready

Team split:
- **Jah, Jimz, Kurt** — each rehearses narrating and demoing the section they own (account/content, records/UI, onboarding/CSV/receipts/AI chat) during the full walkthrough
- **Ken (integration)** — runs the end-to-end rehearsal, stitches the sections together, signs off on the final readiness checklist

Evidence for adviser:
- Recorded end-to-end rehearsal
- Final test-count and verification-gate summary
- Signed-off readiness checklist

Report text:
> This week the whole team rehearsed the complete presentation flow on a clean demo account, each covering the section they've owned throughout the cycle, recorded backup material for the live demo, and incorporated outstanding adviser feedback. We consider FinSight feature-complete and ready for final presentation.

## The strategy behind the sequence

**Next Saturday (Aug 22).** Submit exactly what your own report already
promised: the working tree organized and committed, and the receipt-capture
flow verified on the real presentation phone under network interruption and
backgrounding. This is the most credible possible follow-up because it's
literally your own stated next step, not new material.

**Main focus, weeks 2–4 (through Sep 12).** Testing and validation against
real-world inputs: security/QA closure, real CSV files, real receipts. This
is where "we already built it" turns into "we proved it works," which is the
actual gap in the current report — the inventory itself notes the OCR
corpus is mostly synthetic and CSV testing hasn't happened against real
exports yet.

**Save for later, weeks 5–7 (through Oct 3).** Polish, accessibility, and
deployment. These depend on the app being stable and validated first —
polishing an empty state or rehearsing a deploy before the underlying data
pipeline is proven would be working out of order, and an adviser can tell.

**When to say "feature-complete."** You can say it honestly at the end of
Week 6 (Sep 26), once the teammate polish backlog from the feature inventory
is closed. From Week 7 on, the framing shifts explicitly to deployment and
rehearsal, which reads as intentional wind-down rather than stalling.

**Showing progress after feature-complete.** Report deployment and
rehearsal artifacts on their own terms — a staging URL, a runbook, a
rehearsal recording — instead of dressing them up as features. An adviser
reads "we deployed to staging and rehearsed the demo" as a normal, credible
late-stage milestone; padding it with invented UI tweaks is what actually
reads as manufactured.
