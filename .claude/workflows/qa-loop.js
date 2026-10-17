export const meta = {
  name: 'qa-loop',
  description: 'Review → triage → fix → re-verify, looping until two clean rounds or the cap',
  whenToUse:
    'After a feature lands, to drive QA findings to zero without hand-dispatching each fix. Escalates product decisions instead of guessing at them.',
  phases: [
    { title: 'Review', detail: 'qa-security reviews the target; findings are typed and owned' },
    { title: 'Triage', detail: 'dedupe against prior rounds, split defects from decisions' },
    { title: 'Fix', detail: 'route each defect to its owning agent; backend fixes run serially' },
    { title: 'Verify', detail: 'exclusive gate run — never concurrent with a fix agent' },
  ],
}

/*
 * ---------------------------------------------------------------------------
 * WHY THIS LOOKS OVER-CONSTRAINED
 * ---------------------------------------------------------------------------
 * Every rule below is here because the un-constrained version of it produced a
 * real failure during the recurring-expenses work this was written from.
 *
 * 1. SERIALISED BACKEND TESTS. backend/ integration tests TRUNCATE every table
 *    between files and the whole team shares ONE finsight-test-db container.
 *    Two concurrent backend runs destroy each other's fixtures. During that
 *    session three overlapping runs reported 111, 183 and 149 failures — all
 *    bogus, in files unrelated to any change; the same tree ran clean when it
 *    held the container alone. A loop that reads those numbers and dispatches
 *    fixes will "repair" code that was never broken. So: at most one backend
 *    agent at a time, and fix agents never run the suite at all.
 *
 * 2. MUTATION-VERIFY EVERY FIX. The worst finding of that session was a
 *    permanent FALSE alarm — meaning the failing signal was a test asserting
 *    that no alarm fires. The cheapest way to turn that green is to weaken the
 *    assertion, and a loop optimising for "no findings" is under constant
 *    pressure to do exactly that. Requiring the fixer to reintroduce the defect
 *    and watch the test fail turns "green" from a claim into evidence.
 *
 * 3. DEFECTS ARE FIXED; DECISIONS ARE ESCALATED. That session surfaced at
 *    least four questions that were the owner's, not the code's: keep or delete
 *    existing rows, raise a finding's severity vs lower a global threshold, how
 *    many reminders per cycle, whether to apply a migration to production. An
 *    autonomous loop will answer those confidently and wrongly.
 *
 * 4. DEDUPE AGAINST EVERYTHING SEEN, NOT AGAINST WHAT WAS FIXED. Otherwise a
 *    finding the triage step declined to act on returns every round and the
 *    loop never converges.
 * ---------------------------------------------------------------------------
 */

const MAX_ROUNDS = 3
const CLEAN_ROUNDS_TO_STOP = 2
const MAX_FIXES_PER_ROUND = 4

/** Reserve enough budget to finish the round in flight rather than dying mid-fix. */
const ROUND_COST_ESTIMATE = 120_000

const target = args?.target ?? 'the uncommitted work on the current branch'
const gate = [
  'cd backend && npm run typecheck && npm run build && npx prisma validate && npm test',
  'cd web && npm run typecheck && npm run lint && npm test && npm run build',
  'cd mobile && npm run typecheck && npm run lint && npm test',
].join('\n')

/** Shared by every agent. These are the rules that keep the loop honest. */
const HOUSE_RULES = `
REPO RULES (from CLAUDE.md and AGENTS.md — read both):
- Ownership isolation, deny-all RLS, and durable DB-backed rate limiting must never regress.
- Mobile camera/permission/lifecycle has NO automated coverage. Never claim test coverage this repo does not have; say "needs physical-device verification".
- Report in the AGENTS.md format.

TEST EXECUTION — THIS IS NOT OPTIONAL:
- backend/ integration tests truncate every table and share ONE container. NEVER run a backend suite while another agent might be. Check with \`pgrep -fa "node.*vitest"\` — NOT \`pgrep -f vitest\`, which matches your own shell and will hang a wait loop forever.
- NEVER point tests at the configured DATABASE_URL. It is PRODUCTION and holds real data.
`

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'gateGreen'],
  properties: {
    gateGreen: {
      type: 'boolean',
      description: 'True only if the full gate passed on a run you held exclusively.',
    },
    gateSummary: { type: 'string', description: 'Actual pass/fail counts per project.' },
    findings: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'severity', 'kind', 'owner', 'title', 'evidence'],
        properties: {
          key: {
            type: 'string',
            description:
              'Stable slug identifying this finding across rounds, e.g. "web-paused-counted-overdue". Same defect must produce the same key every round.',
          },
          severity: { type: 'string', enum: ['P1', 'P2', 'P3'] },
          kind: {
            type: 'string',
            enum: ['DEFECT', 'DECISION'],
            description:
              'DEFECT = the code is wrong and a fix is objectively correct. DECISION = a product/priority call a human must make. When genuinely unsure, choose DECISION.',
          },
          owner: {
            type: 'string',
            enum: [
              'backend-api',
              'ai-ocr-analytics',
              'database',
              'web-frontend',
              'mobile',
              'devops-release',
              'qa-security',
            ],
          },
          title: { type: 'string' },
          evidence: {
            type: 'string',
            description: 'file:line plus what proves it — a repro, a failing assertion, or emitted output. Not a hunch.',
          },
          fixDirection: { type: 'string' },
        },
      },
    },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'outcome', 'mutationVerified', 'summary'],
  properties: {
    key: { type: 'string' },
    outcome: { type: 'string', enum: ['fixed', 'not-a-defect', 'blocked'] },
    mutationVerified: {
      type: 'boolean',
      description:
        'True only if you reintroduced the defect, OBSERVED the test fail, and restored. Guessing here defeats the loop.',
    },
    summary: { type: 'string' },
  },
}

const seen = new Set()
const applied = []
const decisions = []
const blocked = []
let cleanRounds = 0
let round = 0

while (cleanRounds < CLEAN_ROUNDS_TO_STOP && round < MAX_ROUNDS) {
  if (budget.total && budget.remaining() < ROUND_COST_ESTIMATE) {
    log(`Stopping: ${Math.round(budget.remaining() / 1000)}k budget left, under the ${ROUND_COST_ESTIMATE / 1000}k a round needs.`)
    break
  }

  round++
  phase('Review')

  const review = await agent(
    `You are reviewing: ${target}

Run the FULL gate, holding the test container EXCLUSIVELY, and report the real numbers:

${gate}

Then review for defects, in this priority order:
1. Ownership isolation and RLS/deny-all posture (hard rules — a regression here is always P1).
2. Correctness bugs that automated tests would NOT catch. Look specifically for interactions between two individually-sound pieces of code. The most serious defect found in this codebase's last review was of exactly that shape: two lines written minutes apart in one edit, each correct alone, jointly producing a permanent false alarm through a state variable one of them set.
3. Tests that do not bite. For each important test, ask: what mutation would break this? If the answer is "none", the test is vacuous however green it is.
4. Cross-client divergence (web vs mobile behaving differently on the same data).
5. Dead or non-functional code — a CSS class that generates nothing, an enum value nothing reads, a promise in copy the code cannot keep.

${HOUSE_RULES}

Findings already reported in earlier rounds — do NOT report these again:
${seen.size ? [...seen].join(', ') : '(none, this is the first round)'}

Classify each finding as DEFECT or DECISION. A DEFECT has an objectively correct fix. A DECISION is a product or priority call — which of two valid behaviours is wanted, whether to delete data, whether to ship something. If you are genuinely unsure, mark it DECISION: a wrong auto-fix costs more than a question.

Report review-only. Do not fix anything yourself.`,
    { schema: FINDINGS_SCHEMA, label: `review:round-${round}`, phase: 'Review', agentType: 'qa-security' },
  )

  if (!review) {
    log(`Round ${round}: review agent returned nothing; stopping rather than looping blind.`)
    break
  }

  phase('Triage')
  log(`Round ${round} gate: ${review.gateGreen ? 'GREEN' : 'RED'} — ${review.gateSummary ?? 'no summary'}`)

  const fresh = (review.findings ?? []).filter((f) => !seen.has(f.key))
  fresh.forEach((f) => seen.add(f.key))

  const freshDecisions = fresh.filter((f) => f.kind === 'DECISION')
  decisions.push(...freshDecisions)
  if (freshDecisions.length) {
    log(`Round ${round}: ${freshDecisions.length} decision(s) escalated, not auto-fixed.`)
  }

  const actionable = fresh
    .filter((f) => f.kind === 'DEFECT')
    .sort((a, b) => a.severity.localeCompare(b.severity))

  // A round is clean when nothing NEW is actionable and the gate is green.
  // Both conditions matter: a green gate with a fresh P1 is not clean, and a
  // red gate with no new findings means the review could not explain the red.
  if (actionable.length === 0 && review.gateGreen) {
    cleanRounds++
    log(`Round ${round}: clean (${cleanRounds}/${CLEAN_ROUNDS_TO_STOP}).`)
    continue
  }
  cleanRounds = 0

  const toFix = actionable.slice(0, MAX_FIXES_PER_ROUND)
  if (actionable.length > toFix.length) {
    // Never let a cap silently look like "that was everything".
    log(`Round ${round}: ${actionable.length} defects, fixing the ${toFix.length} most severe this round; the rest carry to the next.`)
    actionable.slice(MAX_FIXES_PER_ROUND).forEach((f) => seen.delete(f.key))
  }

  phase('Fix')

  const fixPrompt = (f) => `Fix ONE defect. Do not refactor beyond it.

SEVERITY: ${f.severity}
TITLE: ${f.title}
EVIDENCE: ${f.evidence}
${f.fixDirection ? `SUGGESTED DIRECTION: ${f.fixDirection}` : ''}

Stay inside your ownership boundary (AGENTS.md). If the fix needs a file you do not own, report blocked with the reason — do not reach across.

MANDATORY — MUTATION VERIFICATION. A passing test is not evidence your fix works; it may only mean the test never checked. After fixing:
  1. Reintroduce the defect deliberately.
  2. Run the covering test and OBSERVE it fail. Quote that failure.
  3. Restore the fix and confirm green.
If no existing test fails when you reintroduce the defect, the test is vacuous — write one that does, then repeat. Report mutationVerified:false if you could not complete this; do not claim it.

NEVER weaken an assertion, delete a test, or loosen a threshold to make something pass. If a test looks wrong, report that as a finding instead of editing it green.

${HOUSE_RULES}

Run ONLY the targeted test file for your fix, never a full backend suite — the verification phase owns that, exclusively.`

  // Backend fixes touch the shared container, so they run ONE AT A TIME.
  // Web and mobile share nothing, so they can go together.
  const backendOwners = ['backend-api', 'ai-ocr-analytics', 'database']
  const backendFixes = toFix.filter((f) => backendOwners.includes(f.owner))
  const clientFixes = toFix.filter((f) => !backendOwners.includes(f.owner))

  const results = []

  for (const f of backendFixes) {
    const r = await agent(fixPrompt(f), {
      schema: FIX_SCHEMA,
      label: `fix:${f.key}`,
      phase: 'Fix',
      agentType: f.owner,
    })
    if (r) results.push(r)
  }

  if (clientFixes.length) {
    const clientResults = await parallel(
      clientFixes.map((f) => () =>
        agent(fixPrompt(f), { schema: FIX_SCHEMA, label: `fix:${f.key}`, phase: 'Fix', agentType: f.owner }),
      ),
    )
    results.push(...clientResults.filter(Boolean))
  }

  for (const r of results) {
    if (r.outcome === 'fixed' && r.mutationVerified) {
      applied.push(r)
    } else if (r.outcome === 'blocked') {
      blocked.push(r)
    } else if (r.outcome === 'fixed' && !r.mutationVerified) {
      // Unproven, so it does not count as done and must be looked at again.
      blocked.push({ ...r, summary: `UNVERIFIED (no mutation check): ${r.summary}` })
      seen.delete(r.key)
    }
  }

  log(`Round ${round}: ${applied.length} verified fixes so far, ${blocked.length} blocked/unverified.`)
}

phase('Verify')

const final = await agent(
  `Run the full gate one last time, holding the test container EXCLUSIVELY, and report the real numbers per project.

${gate}

${HOUSE_RULES}

Do not fix anything. Report only: did every project pass, and if not, exactly what failed. If a run looks red, confirm no other test process was active (\`pgrep -fa "node.*vitest"\`) before calling it a regression — concurrent runs against the shared container produce large numbers of bogus failures in unrelated files.`,
  { label: 'final-gate', phase: 'Verify', agentType: 'qa-security' },
)

return {
  rounds: round,
  stoppedBecause:
    cleanRounds >= CLEAN_ROUNDS_TO_STOP
      ? `${CLEAN_ROUNDS_TO_STOP} consecutive clean rounds`
      : round >= MAX_ROUNDS
        ? `hit the ${MAX_ROUNDS}-round cap — findings may remain`
        : 'budget or review failure',
  fixesApplied: applied,
  blockedOrUnverified: blocked,
  decisionsForHuman: decisions,
  finalGate: final,
}
