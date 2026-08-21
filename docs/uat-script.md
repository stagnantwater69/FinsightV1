# FinSight — User Acceptance Testing Script

> **Scope note (6 August 2026):** FinSight is being completed as a team-used
> capstone and currently has no external participant cohort. Do not claim that
> the team running this script constitutes representative user acceptance
> testing. For the current project scope, use
> [internal-acceptance-checklist.md](internal-acceptance-checklist.md). Retain
> this script only if the adviser later requires research participants.

**For:** small business owners and operators, Sitio Plaza, Brgy. Apas, Cebu
**Facilitator:** one team member per session
**Duration:** about 45 minutes per participant
**Format:** one participant at a time, on a real device, using their own real business figures where they are willing

---

## Before you start

### What to prepare

- [ ] A laptop or tablet with FinSight open at the registration screen, on working internet
- [ ] A printed copy of this script and the feedback form (participants may prefer paper)
- [ ] A pen
- [ ] **A few of the participant's own real receipts**, if they are willing to use them — ask ahead of time
- [ ] A prepared spare receipt in case they bring none
- [ ] A prepared CSV file of sample expenses, in case they have no spreadsheet of their own
- [ ] A phone or recorder for notes, **only if the participant agrees**

### What to say before beginning

Read this out, in Bisaya or Tagalog as appropriate:

> "Thank you for helping us. We are testing a system called FinSight — we are **not** testing you. There are no wrong answers, and anything you find confusing is useful information for us, not a mistake on your part.
>
> Please think out loud as you go. If something is unclear, say so. If you get stuck, that tells us the system needs fixing.
>
> You can stop at any time. Your business figures will only be used for this test, and we will not share them."

### Ground rules for the facilitator

- **Do not help unless they are genuinely stuck.** Wait at least 30 seconds. Getting stuck is data.
- When they ask "what do I do here?", first ask back: *"What would you expect to do?"*
- Record what they **do**, not only what they say. People often say something is fine while struggling with it.
- Note the exact words they use for things. If they call it "puhunan" and the screen says "Available Business Funds", write that down.
- Do not defend the system. If they criticise it, say "thank you, that's useful" and write it down.

### Consent

- [ ] Explained the purpose of the session
- [ ] Explained that participation is voluntary and can stop at any time
- [ ] Explained how their business data will be handled
- [ ] Participant agreed to take part
- [ ] Participant agreed / did not agree to audio recording *(circle one)*

---

## Participant details

| | |
|---|---|
| Participant ID (do not write their name) | |
| Date and time | |
| Facilitator | |
| Type of business | Retail / sari-sari · Food and beverage · Online selling · Service · Manufacturing · Trading · Other: ______ |
| Years operating | Under 1 · 1–2 · 3–5 · Over 5 |
| Who records sales and expenses now | Owner · Family member · Employee · Bookkeeper · No one specific |
| How they record now | Notebook · Spreadsheet · Phone notes · App / software · Receipts only · Not regularly |
| Comfort with phones/computers | Not comfortable · Somewhat · Comfortable · Very comfortable |

---

## How to record each task

For every task, fill in all four columns before moving on.

- **Completed?** — Yes without help · Yes with a hint · No
- **Time** — roughly, in minutes
- **What they said / did** — quotes and observations, especially hesitation
- **Problems** — anything confusing, any error, anything they expected that was not there

---

## Task 1 — Create an account

**Say:** "Please make an account for yourself, as if you were starting to use this for your business."

*Do not point at anything on the screen.*

| Observation | |
|---|---|
| Completed? | Yes, unaided · Yes, with hint · No |
| Time | |
| Did they understand what each field wanted? | |
| Any trouble with the password rules? | |
| What they said / did | |
| Problems | |

---

## Task 2 — Set up their business profile

**Say:** "Now set up your business in the system, using your real numbers if you're comfortable — roughly is fine."

This screen asks for available business funds, expected monthly expenses, and operating days per month.

| Observation | |
|---|---|
| Completed? | Yes, unaided · Yes, with hint · No |
| Time | |
| **Did they understand "Available Business Funds"?** What did they think it meant? | |
| **Did they understand "Expected Monthly Expenses"?** | |
| **Did they understand "Operating Days per Month"?** | |
| Could they answer these from memory, or did they need to check records? | |
| What words do THEY use for these things? | |
| Problems | |

> **Watch for:** these three figures drive every insight in the system. If a participant guesses or misunderstands any of them, every later number they see will be wrong. This is the highest-risk step in the whole session.

---

## Task 3 — Record about a week of expenses and sales by hand

**Say:** "Please enter roughly a week of your recent expenses, and your sales for those days."

Aim for at least 5 expenses and 3 sales entries.

| Observation | |
|---|---|
| Completed? | Yes, unaided · Yes, with hint · No |
| Time for the FIRST entry | |
| Time for a LATER entry | |
| Did they find creating expense categories obvious? | |
| Did they understand "Sales Reference" is for monitoring, not a receipt for a customer? | |
| Did the pace of entry frustrate them? | |
| Would they realistically do this every day? | |
| Problems | |

> **Watch for:** whether entry speeds up after the first two. If it does not, daily use is unlikely to stick.

---

## Task 4 — Scan a real receipt

**Say:** "Try adding an expense by taking a photo of this receipt instead of typing it."

Use the participant's own receipt if they brought one.

| Observation | |
|---|---|
| Completed? | Yes, unaided · Yes, with hint · No |
| Time | |
| Receipt used | Their own (describe: ______) · Ours |
| **Was the DATE read correctly?** | Yes · No — it read: ______ |
| **Was the VENDOR read correctly?** | Yes · No — it read: ______ |
| **Was the AMOUNT read correctly?** | Yes · No — it read: ______ |
| Did they notice the values were editable before saving? | |
| Did they check the values, or accept them without looking? | |
| How did they react to a wrong value? | |
| **Did the whole receipt fit in one photo?** | Yes · No — it took ______ photos to cover it |
| **If it did not fit, what did they do?** | Photographed the top only · Photographed twice and saved twice · Gave up and typed it · Other: ______ |
| **Did they try to photograph two receipts at once?** | Yes · No |
| Problems | |

> **Watch for:** whether they *check* the extracted values. Known limitation — scanning is accurate on clean printed receipts and unreliable on creased or faded thermal paper. The design depends on the owner reviewing before saving. If participants accept values without reading them, that is a significant finding and should be written up.

> **Why the "one photo" questions:** the system currently assumes one receipt is one photograph, and a receipt too long to fit has no supported path — the owner either loses the bottom of it or saves it as two unrelated expenses. Supporting multi-page capture is a large change (it touches the database, both apps and the whole scanning pipeline), so it should be built only if this turns out to be real for these owners rather than assumed. **Count it: how many participants hit it at all, and on what kind of receipt.** A supermarket grocery run and a sari-sari restock are very different lengths, and if nobody's receipts overflow a single photo the change is not worth its risk. Do not prompt — only record it if it comes up naturally with their own receipt.

---

## Task 5 — Import a spreadsheet (skip if not relevant to them)

**Say:** "If you keep a spreadsheet of expenses, try bringing it into the system."

| Observation | |
|---|---|
| Completed? | Yes, unaided · Yes, with hint · No · Not applicable |
| Time | |
| Did they understand the column-matching step? | |
| Did they understand why some rows were skipped? | |
| Problems | |

---

## Task 6 — Review flagged records

If FinSight flagged anything (possible duplicate, large expense), have them open the review screen.

**Say:** "The system has marked some records for you to look at. What do you make of these?"

| Observation | |
|---|---|
| Completed? | Yes, unaided · Yes, with hint · No · Nothing was flagged |
| **Did they understand WHY each record was flagged?** | |
| Did they agree it was worth flagging? | |
| Did they know what to do about it? | |
| Any record flagged that they thought was perfectly normal? *(false alarm — note it)* | |
| Problems | |

> **Watch for:** false alarms. Unusual-expense detection is known to over-flag when a category has only about five records — it can mark the highest and lowest of an ordinary set as unusual. Note every disagreement.

---

## Task 7 — Read the dashboard

**Say:** "This is your dashboard. Tell me what it's saying about your business."

**Do not explain it.** Let them interpret it.

| Observation | |
|---|---|
| Time before they said anything meaningful | |
| **What did they look at first?** | |
| Could they say what their biggest expense category was? | Yes · No |
| Could they say whether they were ahead or behind? | Yes · No |
| **Did they understand "Recovery Target"?** In their words: | |
| Did they understand "Daily Needed Target" vs "Adjusted Daily Target"? | |
| Anything they misread or got backwards? | |
| Anything they expected to see that wasn't there? | |
| Problems | |

---

## Task 8 — Check a spending decision

**Say:** "Suppose you're thinking about buying something for the business — maybe a freezer or a bulk order. Use the system to check what that would do to your money."

| Observation | |
|---|---|
| Completed? | Yes, unaided · Yes, with hint · No |
| Did they find the Spending Impact screen on their own? | |
| Did they understand the before/after figures? | |
| Did they understand the impact label (Low / Noticeable / High)? | |
| **Did they think the system was telling them whether to buy it?** | Yes · No |
| Problems | |

> **Watch for:** the answer to "did they think the system was telling them whether to buy it". FinSight is deliberately designed **not** to give a verdict. If owners read it as advice to proceed, that is a serious finding worth escalating.

---

## Task 9 — Ask FinSight a question

**Say:** "There's an assistant you can ask questions to, in your own words. Try asking it something you actually want to know about your business."

Let them choose the question. If they cannot think of one, suggest: *"ask it how you could reduce your expenses."*

| Observation | |
|---|---|
| Completed? | Yes, unaided · Yes, with hint · No |
| **What did they ask?** *(write it word for word)* | |
| What language did they use? | English · Bisaya · Tagalog · Mixed |
| Was the answer understandable to them? | |
| **Did they believe the answer?** Why or why not? | |
| Did they ask a follow-up? | |
| Did they notice it used their real figures? | |
| Problems | |

> **Watch for:** whether they trust it, and whether they check it. Both over-trust and total distrust are problems worth recording.

---

## Wrap-up questions

Ask these out loud and write the answers down before handing over the feedback form.

1. **What was the most confusing part of what you just did?**

2. **What was the most useful part?**

3. **Would you use this instead of your notebook? Why, or why not?**

4. **What would stop you from using this every day?**

5. **Is there anything you expected this to do that it doesn't?**

6. **If you could change one thing, what would it be?**

---

## Facilitator notes (fill in immediately after the session)

**Bugs or errors seen** *(note the screen and what happened)*

**Places they got stuck**

**Words they used that the system doesn't**

**Anything that surprised you**

**Overall impression** — did this person look like they would actually use it?

---

## After the session

- [ ] Feedback form completed by the participant
- [ ] Notes written up while still fresh (same day)
- [ ] Any bug logged with the screen name and the steps to reproduce
- [ ] Test account and test data removed, if the participant used real figures and asked for it
- [ ] Thanked the participant
