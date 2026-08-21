# FinSight — working agreement

**Read [`AGENTS.md`](AGENTS.md) before starting any non-trivial task.** It defines the 8-agent team, the ownership map for every directory, the task-report format, priority levels (P0–P3), and the rules that keep agents from making conflicting edits.

## Fast facts

- Monorepo-ish layout, three independent npm projects — no root install step: `backend/` (Express + Prisma + TypeScript), `web/` (Vite + React 19 + Tailwind), `mobile/` (Expo + React Native).
- Postgres via Supabase; Supabase also provides Auth and Storage. All application-table access goes through Express/Prisma — RLS is deny-all for the `anon`/`authenticated` roles by design.
- **This is a mature codebase, not a prototype.** Nearly every core feature is already implemented and tested (~845 tests across the three projects). Verify against the code before concluding a feature is missing.

## Verification gate

```bash
cd backend && npm run typecheck && npm run build && npx prisma validate && npm test
cd ../web && npm run typecheck && npm run lint && npm test && npm run build
cd ../mobile && npm run typecheck && npm run lint && npm test
```

Backend integration tests need the throwaway Postgres container: `npm run test:db:up --prefix backend`. They are destructive and refuse to run against anything but the dedicated `finsight_test` database.

## Hard rules

- Never regress ownership isolation (every query scoped to the authenticated user's active business profile), the deny-all RLS posture, or durable DB-backed rate limiting.
- Never commit `.env` files, Supabase service-role keys, or other secrets.
- Mobile camera/permission/lifecycle behavior has **no** automated coverage — say "needs physical-device verification," never claim test coverage it doesn't have.
- Don't present the mostly-synthetic OCR corpus as real-receipt evidence.
- Commits in this repo do **not** carry a Claude co-author trailer.
