# FinSight

AI-assisted financial monitoring for small-business owners. FinSight is a
single-role product with web and mobile clients backed by an Express API,
Prisma/PostgreSQL, and Supabase Auth and Storage.



## Repository layout

```text
backend/   Express + Prisma + TypeScript API
web/       Vite + React + TypeScript web client
mobile/    React Native + Expo mobile client
docs/      Architecture, security, acceptance, and deployment documentation
scripts/   Optional external-UAT result scoring tools
nginx/     Reverse-proxy configuration
```

## Getting the code

```bash
git clone <repo-url>
cd FinsightV1
```

Each of `backend/`, `web/`, and `mobile/` is its own npm project with its own
`package.json` and `node_modules` — there's no root-level install step.

## Prerequisites

Install on your machine before doing anything else:

- **Node.js 22 or later** and **npm** — [nodejs.org](https://nodejs.org). Check
  with `node -v` / `npm -v`.
- **Git**
- **Expo Go** app on your phone (iOS App Store / Google Play) if you want to
  test the mobile client on a physical device without a native build.
- Android Studio (Android emulator) and/or Xcode (iOS simulator, macOS only)
  if you'd rather run mobile on an emulator/simulator than a physical phone.

**Not required for everyday development:**

- **Local PostgreSQL** — the app connects to a shared Supabase Postgres
  instance instead.
- **Docker Desktop** — only needed if you want to (a) run the backend's
  destructive integration test suite locally (`npm run test:db:up`, which
  starts a throwaway Postgres container), or (b) run the whole stack via
  `docker-compose.yml` instead of `npm run dev` in each folder. Plain
  `npm run dev` / `npm start` in `backend/`, `web/`, and `mobile/` needs
  neither.

Ask the project owner for:

- A Supabase project invite (or the `SUPABASE_URL` / anon key / service-role
  key for the shared dev project)
- Any values needed to fill in `.env` files (see below) — these are never
  committed to the repo

Copy each application's example environment file before running it. Never
commit Supabase service-role keys or other secrets.

## IDE setup

This project is developed in **VS Code**. Recommended extensions:

- **ESLint** (`dbaeumer.vscode-eslint`) — web/mobile use `oxlint`, which
  reuses the ESLint UI conventions
- **Prisma** (`Prisma.prisma`) — syntax highlighting/formatting for
  `backend/prisma/schema.prisma`
- **Tailwind CSS IntelliSense** (`bradlc.vscode-tailwindcss`) — for `web/`
- **Expo Tools** (`expo.vscode-expo-tools`) — for `mobile/`

After `npm ci` in each of `backend/`, `web/`, and `mobile/`, restart the
TypeScript server (Command Palette → "TypeScript: Restart TS Server") so VS
Code picks up installed types.

## Backend

```bash
cd backend
npm ci
cp .env.example .env
npx prisma generate
npm run dev
```

The API listens on `http://localhost:4000`. Use `GET /api/v1/health/live` for
process liveness and `GET /api/v1/health/ready` (or the compatibility path
`GET /api/v1/health`) for database-aware readiness and receipt-queue depth.

For a fresh target database, set both `DATABASE_URL` and `DIRECT_URL` before
deploying migrations. See [the deployment runbook](docs/deployment-runbook.md)
and [internal acceptance checklist](docs/internal-acceptance-checklist.md) before pointing at a
shared or hosted environment.

## Web

```bash
cd web
npm ci
cp .env.example .env
npm run dev
```

The Vite development server normally listens on `http://localhost:5173`.
Supabase client settings and `VITE_API_BASE_URL` are build-time values.

## Mobile

```bash
cd mobile
npm ci
cp .env.example .env
npm start
```

When testing on a physical phone, configure the API base URL with an address
the phone can reach; `localhost` refers to the phone itself.

## Verification

Run the complete candidate gate before internal acceptance testing or a demo:

```bash
cd backend
npm run typecheck
npm run build
npx prisma validate
npm test

cd ../web
npm run typecheck
npm test
npm run build

cd ../mobile
npm run typecheck
npm test
```

Backend integration tests are destructive by design and refuse to run unless
their database URL targets the dedicated `finsight_test` database. The setup
and safeguards are described in [backend/tests/README.md](backend/tests/README.md).

## Release readiness

Passing automated tests is necessary but not sufficient for the capstone demo.
The team must also complete the internal acceptance checklist, verify the
receipt flow on a physical Android phone, and prepare a clean synthetic demo
dataset. Production hardening remains documented but is not presented as a
completed capstone requirement.
