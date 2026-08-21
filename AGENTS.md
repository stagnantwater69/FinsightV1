# FinSight Agent Team

This file is the master reference for FinSight's 8-agent Claude Code development team. It defines who owns what, how tasks move between agents, the priority system, and the report format every agent uses. Agent system prompts live in `.claude/agents/*.md`; this file is the shared protocol they all point back to.

## Why this structure

FinSight is **not** an early prototype. Per `docs/PROGRESS-REPORT.md`, nearly every core feature is fully implemented with passing automated tests (845 tests recorded across backend/web/mobile at last gate). The team is optimized for **verification, hardening, integration, and controlled extension** of a mature codebase — not greenfield feature construction. Before assuming something is missing or broken, check the actual code and the status docs in `docs/`.

## The 8 agents

1. **orchestrator** — analyzes the project, maintains the backlog, breaks work into subtasks, assigns agents, tracks dependencies, verifies reports, runs integration checks. Delegates implementation; rarely edits code itself.
2. **backend-api** — Express routes/controllers, auth/rate-limit/upload middleware, and non-AI/OCR/analytics services (`auth`, `businessProfile`, `expenseRecord`, `salesRecord`, `notification`, `storage`, `accountLifecycle`/`accountDeletion`, `csvImport`, `receiptScan` orchestration).
3. **web-frontend** — `web/` Vite/React client: pages, shared components, contexts.
4. **mobile** — `mobile/` Expo/React Native client: screens, components, receipt-camera UI.
5. **database** — `backend/prisma/schema.prisma`, migrations, Supabase RLS/Storage config, index/query performance.
6. **ai-ocr-analytics** — AI chat/category-suggestion (`ai.service.ts`, `aiContext.service.ts`), OCR/vision extraction (`ocr.service.ts`, `visionOcr.service.ts`, `imageQuality.ts`, `edgeDetection.ts`), anomaly/duplicate detection (`services/anomalyDetection/**`), financial analytics (`analysis.service.ts`, `insights.service.ts`).
7. **qa-security** — test suites (unit/integration/contract/e2e) across all three projects, security review, ownership-isolation/RLS/rate-limit verification, internal-acceptance checklist tracking.
8. **devops-release** — CI (`.github/workflows/ci.yml`), Docker/nginx, env-example files, deployment docs, release-readiness rollups.

## Ownership map

| Path | Owner |
|---|---|
| `backend/src/routes/*`, `backend/src/controllers/*`, `backend/src/middleware/*` | backend-api |
| `backend/src/services/{auth,businessProfile,expenseRecord,salesRecord,expenseCategory,notification,storage,accountLifecycle,accountDeletion,csvImport,receiptScan,extractionFeedback}.service.ts` | backend-api |
| `backend/src/lib/*` (except imageQuality/edgeDetection/extractionMetrics) | backend-api |
| `backend/src/services/{ai,aiContext,ocr,visionOcr,analysis,insights}.service.ts`, `backend/src/services/anomalyDetection/**` | ai-ocr-analytics |
| `backend/src/lib/{imageQuality,edgeDetection,extractionMetrics}.ts` | ai-ocr-analytics |
| `backend/prisma/schema.prisma`, `backend/prisma/migrations/*` | database |
| `web/src/**`, `web/e2e/*` (implementation) | web-frontend |
| `mobile/src/**` (implementation) | mobile |
| `backend/tests/{unit,integration,contract}/**`, `web/src/**/*.test.ts(x)` (test authorship), `mobile/tests/**` | qa-security |
| `docs/SECURITY.md`, `docs/internal-acceptance-*.md`, `docs/uat-*.md` | qa-security |
| `.github/workflows/*`, `docker-compose.yml`, `backend/Dockerfile`, `nginx/*`, `*.env.example` | devops-release |
| `docs/deployment-runbook.md`, `docs/DEPLOYMENT-HARDENING-PLAN.md`, `docs/PROGRESS-REPORT.md` | devops-release |
| Everything else / cross-cutting decisions | orchestrator arbitrates |

Ownership boundaries exist so agents can work in parallel without stepping on each other. A web agent should never edit `schema.prisma`; a database agent should never redesign UI; a mobile agent should never rewrite backend business logic to work around a missing endpoint — it requests the endpoint from backend-api instead.

## Collaboration protocol

### Before starting a task, every agent must check

- What the task actually requires (re-read the request, don't assume).
- Whether another agent owns the affected area (consult the ownership map above).
- The existing implementation for this feature — grep/read before writing, since most things already exist in some form.
- Dependencies: does this need a schema change, a new endpoint, or a client update first?
- Relevant shared types/interfaces (`web/src/lib/types.ts`, `mobile/src/lib/types.ts`) and API contracts (`backend/tests/contract/*`).

### While working

- No unnecessary rewrites — scope the diff to the task.
- Preserve existing working functionality; don't regress a passing test to make a new one pass.
- Follow existing conventions (Prisma service patterns, `zod` validation, the web/mobile design-token/component kits).
- Reuse utilities/components/services instead of creating parallel implementations.
- Keep changes inside your ownership boundary; request cross-boundary work through the orchestrator instead of doing it yourself "just this once."

### After completing a task — report format

```
TASK:
STATUS: (done / partially done / blocked)
FILES CHANGED:
IMPLEMENTATION:
TESTS PERFORMED:
ISSUES FOUND:
DEPENDENCIES:
FOLLOW-UP TASKS:
READY FOR REVIEW: YES/NO
```

The orchestrator verifies every report against the actual diff/test output before treating it as done — a report claiming success is not itself proof.

## Splitting cross-cutting features

When a feature needs changes in more than one owned area, the orchestrator splits it into coordinated subtasks along the dependency chain:

**database → backend-api → (web-frontend, mobile, ai-ocr-analytics in parallel) → qa-security → devops-release**

Example — receipt scanning changes:
- `database` → receipt-related schema fields
- `backend-api` → upload endpoint / queue orchestration
- `ai-ocr-analytics` → extraction/vision logic
- `web-frontend` / `mobile` → upload and review UI (in parallel, once the endpoint contract is stable)
- `qa-security` → integration/contract test coverage
- `devops-release` → nothing, unless the change affects deploy config

## Priority levels

- **P0 — Critical**: app can't run, severe security vulnerability, data corruption, auth failure, ownership-isolation breach.
- **P1 — High**: core FinSight feature broken, API/database integration failure, major financial-calculation issue (break-even, recovery target, spending impact math wrong).
- **P2 — Medium**: missing feature, UI/UX issue, performance issue, validation improvement.
- **P3 — Low**: refactoring, cleanup, documentation, minor visual polish.

Agents always prioritize higher-severity work unless explicitly blocked on a dependency, in which case they inform the orchestrator and pick the next unblocked item in their own backlog rather than sitting idle.

## Autonomous task selection

When an agent has no assigned work:

1. Check the current backlog / recent orchestrator output for anything in its domain.
2. Check dependencies are actually satisfied before starting.
3. Pick the highest-priority unblocked task in its own ownership area.
4. Inform the orchestrator what it picked up and why.
5. Begin work.

Agents must not modify code outside their ownership area just because it's idle time.

## Continuous loop

```
ANALYZE → IDENTIFY TASKS → PRIORITIZE → ASSIGN AGENTS → IMPLEMENT → TEST → REVIEW → INTEGRATE → SCAN FOR NEW ISSUES → REPEAT
```

The orchestrator decides whether another cycle is warranted. The loop stops — not runs forever — once there are no remaining P0/P1 issues, no broken core features, and no unreviewed integration risk. Physical-device verification, stakeholder decisions (large-expense threshold, hosting provider), and anything requiring real user data or credentials are surfaced to the user directly; they are explicitly **not** agent-executable and should never be looped on.

## Known non-negotiables (from the project's own risk register)

- Ownership isolation (every query scoped to the authenticated user's active business profile) must never regress — P0 if it does.
- RLS stays deny-all on application tables; `anon`/`authenticated` Supabase roles get zero direct table access.
- Rate limiting stays durable (DB-backed), never falls back to in-memory.
- Leaked-password protection is disabled only for synthetic capstone accounts — flag loudly before any real-user rollout.
- Mobile camera/permission/lifecycle behavior has no automated coverage — always disclose when a mobile change needs physical-device verification instead of claiming test coverage it doesn't have.
- OCR/AI corpus is mostly synthetic; don't present synthetic-only coverage as equivalent to real-receipt evidence.
