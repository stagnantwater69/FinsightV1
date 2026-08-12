# FinSight AI Response Quality Rubric

Run: 2026-07-25 16:47 UTC · 26 questions across 4 modules

Each response is judged on three criteria:

- **(a) Grounded** — every money figure traces to the owner's real profile/record data or to the deterministic simulator. Checked automatically against the same endpoints the screens use, allowing one arithmetic step over two source figures (e.g. "up by X" is a subtraction of two given numbers). Anything else is flagged 🔍 for a human to read — a flag is a prompt to check, not a proven error.
- **(b) Plain language** — no accounting jargon a shopkeeper wouldn't know. Auto-screened against a jargon list, then read.
- **(c) No invention** — questions the data can't answer must be declined; ambiguous scenarios must ask rather than guess.

✅ pass · 🔍 needs a human read · ❌ fail

## Summary

| Criterion | Pass | Rate |
|---|---|---|
| (a) Grounded in real numbers | 26/26 | 100% |
| (b) Plain language | 26/26 | 100% |
| (c) Invented nothing | 26/26 | 100% |

Provider(s) used: gemini, openrouter

## By question type

| Type | n | Grounded | Plain | No invention |
|---|---|---|---|---|
| factual | 8 | 8/8 | 8/8 | 8/8 |
| strategy | 3 | 3/3 | 3/3 | 3/3 |
| follow-up | 4 | 4/4 | 4/4 | 4/4 |
| unanswerable | 5 | 5/5 | 5/5 | 5/5 |
| scenario | 1 | 1/1 | 1/1 | 1/1 |
| ambiguous | 1 | 1/1 | 1/1 | 1/1 |
| unanswerable (sparse) | 4 | 4/4 | 4/4 | 4/4 |

## Dashboard

**Q (factual):** How much have I spent in the last 30 days?

> In the last 30 days, your total recorded expenses are PHP 91,300.00. This is up by PHP 82,100.00 compared to your previous equivalent period of PHP 9,200.00.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (factual):** How many records need my review?

> You currently have 0 records needing review.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (strategy):** How can I reduce my expenses?

> To lower your expenses, you could look at your largest category, Inventory, which is at PHP 71,200.00 this period and up 1680.0% compared to the previous period. You could also review Rent, which is at PHP 12,000.00 with no prior baseline, and Utilities, which came to PHP 5,500.00 and is up 34.1% from the previous period.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (follow-up):** Which of those should I look at first?

> You should look at Inventory first, which is your largest expense at PHP 71,200.00 and takes up 78.0% of your period expenses.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (unanswerable):** What was my profit margin last quarter?

> Your records don't show that yet.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (unanswerable):** How much do I owe my suppliers right now?

> Your records don't show that yet.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (unanswerable (sparse)):** How is my business doing this month?

> Your records show you are currently behind your sales target for the month. You have brought in PHP 0.00 out of the PHP 2,000.00 needed, leaving PHP 2,000.00 to cover across your 5 remaining operating days. Because of this, your adjusted daily target has increased to PHP 400.00 per operating day.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

## Expense Insights

**Q (factual):** Which expense category is my highest this period?

> Your highest expense category this period is Inventory at PHP 71,200.00, which makes up 78.0% of your period expenses.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (follow-up):** Why is that one so high?

> Your Inventory expenses are high because of a flagged "Bulk rice delivery" of PHP 30,000.00 on 2026-07-22. That category normally averages PHP 5,650.00, making this particular delivery a large statistical outlier.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (factual):** Did my utilities go up or down compared to last period?

> Your utilities went up compared to last period. They rose from PHP 4,100.00 to PHP 5,500.00, which is an increase of 34.1%.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (strategy):** Give me practical ways to cut my costs based on my actual records.

> To lower your expenses, you can look closely at your largest spending areas:
> - **Inventory:** This is your highest category at PHP 71,200.00 (78.0% of your period expenses). It includes a flagged "Bulk rice delivery" of PHP 30,000.00, which is well above your category average of PHP 5,650.00.
> - **Rent:** This is a fixed cost of PHP 12,000.00, making up 13.1% of your period expenses with no prior baseline.
> - **Utilities:** These rose to PHP 5,500.00, which is up 34.1% compared to your previous period of PHP 4,100.00.
> - **Transportation:** This reached PHP 2,600.00, showing a 136.4% increase from your previous period of PHP 1,100.00.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (unanswerable):** Which supplier gives me the best price?

> Your records don't show that yet.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (factual):** Are any of my expenses unusual?

> Yes, you have one unusual expense flagged this period. It is a "Bulk rice delivery" of PHP 30,000.00 in the Inventory category, which normally averages PHP 5,650.00.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (unanswerable (sparse)):** Which of my expense categories is highest, and why did it go up?

> Your records don't show any expense records for the last 30 days yet, so there are no spending categories to compare. Your expected monthly expenses are set at PHP 2,000.00, but no actual expenses have been logged in this period to show which one is highest or why it changed.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (unanswerable (sparse)):** How can I reduce my expenses?

> Your records don't show any specific expense categories or amounts for the last 30 days yet, so I cannot point to a specific area to cut. Your expected monthly expenses are set at PHP 2,000.00, but no actual expenses have been logged to review.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

## Spending Impact

**Q (scenario):** What if I spend ₱11,000 on a fridge?

> If you spend PHP 11,000.00 on the fridge, your available business funds will drop from PHP 48,500.00 down to PHP 37,500.00, using 22.7% of your available funds. This has a noticeable impact, but it stays just under your 25% large-expense threshold of PHP 12,125.00 and stays within your available funds on record. If you include this purchase, your total recorded expenses for the period would increase from PHP 91,300.00 to PHP 102,300.00.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (follow-up):** And what if it were only 3,000 instead?

> If the amount is PHP 3,000.00, your available business funds will go from PHP 48,500.00 down to PHP 45,500.00, using 6.2% of your available funds. This is a low impact that stays well below your 25% large-expense threshold of PHP 12,125.00, and your total recorded expenses for the period would increase from PHP 91,300.00 to PHP 94,300.00.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (ambiguous):** What if I buy a new freezer for the store?

> What amount do you have in mind for the new freezer?

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (factual):** What counts as a large expense for me?

> Your large-expense threshold is set at 25% of your available business funds, which comes out to PHP 12,125.00 based on your current available funds of PHP 48,500.00. Any expense that exceeds this amount is treated as high impact.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (unanswerable):** Will the fridge pay for itself within a year?

> I don't have information about how much extra sales the fridge would generate or what it would cost to operate. Your records don't show projected revenue from new equipment, so I can't calculate whether it would pay for itself.
> What I can tell you: you're currently behind on your sales target for the month (you've hit 36% of your PHP 125,000.00 goal with 6 operating days left), so any equipment purchase should ideally help you close that gap. If the fridge would help you stock or sell more inventory, that's worth considering — but the payoff depends on numbers outside what your records show right now.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

## Recovery Target

**Q (factual):** Did I reach today's target?

> Yes, you did. You recorded PHP 5,000.00 in sales today, which matches your PHP 5,000.00 target exactly — so you're at target for today.
> However, you're still behind overall for the month. You've covered PHP 45,000.00 of your PHP 125,000.00 monthly goal (36%), and with 6 operating days left, you need to average PHP 13,333.33 per day to catch up — that's well above your original PHP 5,000.00 daily target.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (factual):** What is my adjusted daily target?

> Your adjusted daily target is PHP 13,333.33 per operating day for the remaining 6 operating days.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (follow-up):** Why did it change from my original target?

> Your target changed because you have collected PHP 45,000.00 so far and still need PHP 80,000.00 to reach your monthly goal of PHP 125,000.00. With only 6 remaining operating days left in the month, that remaining amount is spread across fewer days, raising your daily target from the original PHP 5,000.00 to PHP 13,333.33.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (strategy):** What should I focus on to catch up?

> To catch up on your remaining PHP 80,000.00 target over the next 6 operating days, you need to average PHP 13,333.33 per day. Looking at your recent daily coverage, you have been hitting your PHP 5,000.00 target on some days but recording PHP 0.00 on alternating days. Focusing on consistent daily sales rather than zero days will be key to bridging that gap.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (unanswerable):** Will I hit my target by the end of the month?

> Your records don't show that yet. You currently have PHP 45,000.00 covered out of your PHP 125,000.00 goal, leaving PHP 80,000.00 to go across your 6 remaining operating days.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

**Q (unanswerable (sparse)):** Am I on track?

> Your records show you are behind on your goals. You have recorded PHP 0.00 in sales out of the PHP 2,000.00 needed for the month. Because of this, your adjusted daily target has increased to PHP 400.00 across the 5 remaining operating days.

(a) ✅ grounded · (b) ✅ plain · (c) ✅ no invention

---

