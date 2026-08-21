# Team onboarding — secrets checklist

These files are gitignored on purpose and are never pushed to GitHub. Send
them to each teammate through a private, non-persistent channel (password
manager shared item, Signal, an encrypted note that expires after viewing) —
never plaintext chat, email, or committed to this repo.

> Do not fill in real values in this file. This file is tracked by git.
> Keep actual keys only in the private channel you use to send them.

## What to send

Three `.env` files, one per app. Rename each to `.env` and drop it into the
matching folder.

### `backend/.env`

```env
PORT=4000
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173
TRUST_PROXY_HOPS=0

HEALTH_DETAIL_TOKEN=

WEB_APP_URL=http://localhost:5173
MOBILE_APP_URL=finsight://

DATABASE_URL="postgresql://postgres.[PROJECT_REF]:[URL_ENCODED_PASSWORD]@[POOLER_HOST]:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://postgres.[PROJECT_REF]:[URL_ENCODED_PASSWORD]@[POOLER_HOST]:5432/postgres"

SUPABASE_URL="https://[PROJECT_REF].supabase.co"
SUPABASE_ANON_KEY="[anon-key]"
SUPABASE_SERVICE_ROLE_KEY="[service-role-key]"
SUPABASE_STORAGE_BUCKET="receipts"

GOOGLE_GEMINI_API_KEY=""
OPENROUTER_API_KEY=""

TESSERACT_LANG="eng"

ANOMALY_NEAR_DUPLICATE_ENABLED="false"
ANOMALY_VELOCITY_ENABLED="false"
ANOMALY_TRENDS_ENABLED="false"
ANOMALY_BEHAVIORAL_NOVELTY_ENABLED="false"
```

`SUPABASE_SERVICE_ROLE_KEY` is the most sensitive value here — it bypasses
Row Level Security and has full database admin access. Treat it like a root
password.

### `web/.env`

```env
VITE_SUPABASE_URL="https://[PROJECT_REF].supabase.co"
VITE_SUPABASE_ANON_KEY="[anon-key]"
VITE_API_BASE_URL="http://localhost:4000/api/v1"
```

### `mobile/.env`

```env
EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:4000/api/v1
EXPO_PUBLIC_SUPABASE_URL=
EXPO_PUBLIC_SUPABASE_ANON_KEY=
```

Each teammate must edit `EXPO_PUBLIC_API_BASE_URL` themselves after receiving
it:

- Physical phone → the sender's or their own machine's LAN IP
  (e.g. `http://192.168.1.14:4000/api/v1`), not `localhost`
- Android emulator on the same machine as the backend → `10.0.2.2` works
  as-is

## After sending

- Confirm each teammate can reach `GET http://localhost:4000/api/v1/health/live`
  (or their configured API base URL) before they start on features.
- If a laptop with these secrets is lost, or someone leaves the team, rotate
  `SUPABASE_SERVICE_ROLE_KEY` (and re-send `backend/.env` to everyone) from
  the Supabase dashboard.
