# FinSight Mobile — Device Walkthrough

**This is the verification I could not run.** There is no Android SDK, emulator,
adb, or Java on the build machine, and a headless server has no camera — so the
six-module device pass and the real-camera receipt test have to be done by you.
Everything below is what I would have checked.

Verified without a device: TypeScript clean, `expo-doctor` 20/20, a real Android
Metro bundle (2.7 MB Hermes bytecode — every module resolves), 11 unit tests on
the shared formatting logic, and a live authenticated round-trip against the
running backend rendered through Expo's web target.

Not verified: native layout, camera capture, SecureStore on real hardware,
document picking, and anything that depends on device permissions.

---

## Before you start

```bash
# 1. Backend must be running and reachable FROM THE PHONE.
cd backend && npm run dev

# 2. Point the app at a reachable address.
#    Emulator on this machine:  http://10.0.2.2:4000/api/v1   (already set)
#    Physical phone:            http://<your-LAN-IP>:4000/api/v1
#    Find your LAN IP with:  hostname -I | awk '{print $1}'
$EDITOR mobile/.env

# 3. The backend's CORS origin only matters for web; the native app is
#    unaffected. But the phone must be on the SAME NETWORK as this machine.

cd mobile && npx expo start
# Scan the QR with Expo Go, or press `a` for an emulator.
```

**If the app shows "Couldn't reach FinSight":** that is the deliberate network
error message, and it means the address in `.env` is not reachable from the
phone. `localhost` inside the app means the phone itself, not your computer.

---

## Module 1 — Account

- [ ] **Register** a brand-new account. You land straight in the app.
- [ ] **Force-quit the app and reopen it.** You should still be logged in —
      this is the SecureStore path working. If you are asked to log in again,
      the keystore write failed and that is a real bug worth reporting.
- [ ] Log out, then **log in** again.
- [ ] Wrong password shows "Invalid email or password", not a raw error.
- [ ] Business ▸ My account ▸ edit your name, **Save changes** → "Changes saved."
- [ ] **Change password.** You should be signed out immediately (the server
      invalidates sessions), and the new password should work.

## Module 2 — Business profile

- [ ] Create a business. Use realistic figures — expected monthly expenses and
      operating days drive every later number.
- [ ] Edit it; the change sticks.
- [ ] **Archive** it. Confirm the dialog says nothing is deleted.
- [ ] With no active businesses left, confirm **"Show archived businesses"** is
      still reachable — an owner who archives their only business must be able
      to get it back.
- [ ] **Restore** it. All its records are still there.
- [ ] Confirm there is **no delete option anywhere**.

## Module 3 — Records

- [ ] Add an expense. If you have no categories, create one inline.
- [ ] Add a sales reference.
- [ ] Add the **same expense twice** → the second is flagged *Possible duplicate*.
- [ ] Add an expense over your large-expense threshold → flagged *Large expense*.
- [ ] Search narrows the list; the type filter works.
- [ ] Review tab: mark a flagged record reviewed; it leaves the queue.

### Receipt scan — the one that most needs a real device

- [ ] **Take an actual photo of a real receipt** (not a gallery pick — camera
      captures differ in resolution, rotation and lighting).
- [ ] Confirm the review screen pre-fills date / vendor / amount.
- [ ] **Check whether the values are right, and note when they are wrong.**
      Measured server-side accuracy on a 20-image corpus was 100% date /
      95% vendor / 100% amount — but that corpus was mostly clean renders. A
      creased thermal receipt photographed in a dim store is the real test.
- [ ] Correct a wrong value and save. The record stores what YOU confirmed.
- [ ] Try a **deliberately bad photo** (blurry, angled, poor light). It should
      still save a scan you can fix by hand — never an error that loses it.
- [ ] Try **denying camera permission**. You should get a plain-language
      message, not a crash.

### CSV import

- [ ] Pick a CSV. Column auto-matching should guess most fields.
- [ ] Import a file with a deliberately broken row → it reports what was
      skipped and why.

## Module 4 — Dashboard

- [ ] Card order top to bottom: **Available funds → Expenses/Sales → …
      → Recovery target last.**
- [ ] Period switch (Today / Week / Month) changes expenses and sales but
      **not** the recovery figures — recovery is month-to-date by design.
- [ ] Pull to refresh works.
- [ ] Add a record on the Records tab, come back → the dashboard reflects it.

## Module 5 — Insights

- [ ] Expense behaviour: category trends and any unusual expenses.
- [ ] Spending impact: enter ₱11,000 → before/after bars and an impact band.
- [ ] Recovery target: meter, remaining target, daily coverage.
- [ ] **Cross-check one figure against the web app** for the same business.
      They must match exactly — both read the same server-computed values.

## Module 6 — Ask FinSight

- [ ] Open it from **all four** places (Dashboard, and each of the three
      Insights screens).
- [ ] Ask something factual → the answer cites your real figures.
- [ ] Ask a **follow-up** that only makes sense in context ("why is that one so
      high?") → it should resolve, not ask what you mean.
- [ ] In Spending Impact, ask *"what if I spend ₱11,000 on a fridge?"* → the
      numbers must match the deterministic simulator, not be AI-estimated.
- [ ] Ask something the data can't answer → it should say so.
- [ ] The keyboard should not cover the input box.

## Accessibility

- [ ] Set the system font size to its **largest**. Text should grow and rows
      should get taller — nothing clipped or overlapping.
- [ ] Enable **Reduce Motion**; screen transitions should calm down.
- [ ] Every button should be comfortable to hit one-handed.

---

## Please report back

1. Anything that crashed, and what you were doing.
2. **Receipt OCR results on real photos** — how often date/vendor/amount were
   right. This is genuinely unmeasured on camera captures.
3. Any figure that differs between mobile and web for the same business.
4. Anything that looked wrong at your system font size.
