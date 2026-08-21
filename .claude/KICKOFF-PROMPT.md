# FinSight — agent team prompts

Paste-ready prompts for driving the 8-agent team from the Claude Code terminal.
`CLAUDE.md` already points at `AGENTS.md`, so the protocol loads automatically —
but the kickoff prompt restates it because the first run is the one that matters.

---

## 1. Full kickoff (use this once, to start the team)

```
Read AGENTS.md and .claude/agents/*.md first — that is the operating protocol for this repo, and it overrides your default habits.

Act as the orchestrator agent defined in .claude/agents/orchestrator.md.

Ground yourself before planning anything:
1. Run `git status` and `git log --oneline -10` to see the real working-tree state.
2. Read docs/PROGRESS-REPORT.md and docs/FEATURE-INVENTORY-AND-TASK-DISTRIBUTION.md.
3. Spot-check the code for anything those docs claim is done — the repository is the source of truth, not the documentation.

Then produce a prioritised backlog using the P0–P3 scale in AGENTS.md. For each item give: priority, the single owning agent, the files involved, what blocks it, and the definition of done. Order by severity, not by convenience.

Rules for this session:
- FinSight is a mature, mostly-complete system. Default posture is verify / harden / test / integrate — not build new features. Do not invent scope.
- Delegate implementation to the specialist agents via the Agent tool. Launch genuinely independent subtasks in parallel in a single message; never run two agents against the same file.
- Verify every agent report against the actual diff and test output before accepting it. A report claiming success is not proof.
- Flag anything that is NOT agent-executable — physical Android device testing, hosting/TLS decisions, stakeholder calls like the large-expense threshold — directly to me rather than looping on it.
- Do not commit anything unless I ask.

Start by showing me the backlog. Wait for my go-ahead before dispatching any agent.
```

---

## 2. Daily driver (subsequent sessions)

```
Read AGENTS.md, then act as the orchestrator.

Check `git status` and the current state of the repo, tell me the highest-priority unblocked work, and recommend which agent should take it and why. Don't start yet — show me the plan first.
```

---

## 3. Single feature / bug, cross-cutting

```
Read AGENTS.md, then act as the orchestrator.

Task: <describe the feature or bug>

Split it into ordered subtasks along the dependency chain (database → backend-api → web-frontend/mobile/ai-ocr-analytics in parallel → qa-security → devops-release), assign each to the owning agent per the ownership map, and show me the plan before dispatching. Flag any subtask that would cross an ownership boundary.
```

---

## 4. Dispatch one specialist directly (when you already know the owner)

```
Use the <agent-name> agent. Read AGENTS.md for the ownership boundaries and report format first.

Task: <specific, scoped task>
Definition of done: <what must be true, including which test command must pass>

Stay inside your ownership boundary. If the task needs a change outside it, stop and report the dependency instead of making the change yourself.
```

Valid agent names: `orchestrator`, `backend-api`, `web-frontend`, `mobile`,
`database`, `ai-ocr-analytics`, `qa-security`, `devops-release`.

---

## 5. Verification pass only

```
Use the qa-security agent. Read AGENTS.md first.

Run the full candidate gate across backend, web, and mobile (typecheck, lint, tests, builds; bring up the test Postgres container if needed). Report actual pass/fail counts and paste real failure output — do not summarise a run you did not perform. Route any defect you find to the owning agent with a precise reproduction rather than fixing core logic yourself.
```
