// Signs every owner in through the SOURCE stack's FinSight API, so the backup
// holds live sessions, and saves the tokens it issued for verify-app.mjs.
// Usage: API_PORT=4731 node source-tokens.mjs <manifest> <tokens-out>
import { readFileSync, writeFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const API = `http://127.0.0.1:${process.env.API_PORT ?? 4731}/api/v1`;
const tokens = {};
for (const u of manifest.users) {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: u.email, password: u.password }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200 || !body.session?.refresh_token) throw new Error(`${u.email}: login on the source answered ${res.status}`);
  tokens[u.email] = { access_token: body.session.access_token, refresh_token: body.session.refresh_token };
}
writeFileSync(process.argv[3], JSON.stringify(tokens, null, 1), { mode: 0o600 });
console.log(`source-tokens: ${Object.keys(tokens).length} owners signed in`);
