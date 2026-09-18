/**
 * FinSight load profile — one owner's working session, not a home-page hammer.
 *
 * Each VU is a distinct seeded user (its own business profile and records), so
 * the per-user rate limiters behave as they would in production rather than
 * one synthetic account absorbing every request.
 *
 * Shape of a session, with think time between steps:
 *   sign-in bootstrap  -> auth/me, business-profiles       (every session)
 *   dashboard          -> summary, flagged count           (every session)
 *   records            -> search, paged                    (most sessions)
 *   insights           -> expense-behavior or recovery     (some sessions)
 *   write              -> create an expense                (~15% of sessions)
 *
 * Everything is parameterised: BASE_URL, VUS, DURATION, USER_COUNT, WRITE_PCT.
 * No secrets: the bearer token is a seeded synthetic uuid, valid only against
 * the local stub.
 */
import http from "k6/http";
import { check, sleep, group } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://127.0.0.1:4100/api/v1";
const USER_COUNT = Number(__ENV.USER_COUNT || 60);
const WRITE_PCT = Number(__ENV.WRITE_PCT || 15);
const THINK_MIN = Number(__ENV.THINK_MIN || 2);
const THINK_MAX = Number(__ENV.THINK_MAX || 6);

// Per-flow latency, so a slow report does not hide behind fast bootstrap calls.
const tBootstrap = new Trend("flow_bootstrap", true);
const tDashboard = new Trend("flow_dashboard", true);
const tRecords = new Trend("flow_records", true);
const tInsights = new Trend("flow_insights", true);
const tWrite = new Trend("flow_write", true);

const rateLimited = new Counter("rate_limited_429");
const serverErrors = new Counter("server_errors_5xx");
const businessErrors = new Rate("business_errors");

export const options = {
  scenarios: {
    session: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: JSON.parse(__ENV.STAGES || '[{"duration":"30s","target":10},{"duration":"1m","target":10},{"duration":"20s","target":0}]'),
      gracefulRampDown: "20s",
    },
  },
  thresholds: {
    // Acceptance criteria. k6 fails the run when these are breached, so a
    // pass is a measured fact rather than a reading of the summary.
    "http_req_failed": ["rate<0.01"],
    "flow_bootstrap": ["p(95)<2000"],
    "flow_dashboard": ["p(95)<2000"],
    "flow_records": ["p(95)<2000"],
    "flow_insights": ["p(95)<5000"],
    "flow_write": ["p(95)<2000"],
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
  discardResponseBodies: false,
};

function token(vu) {
  // VUs cycle through the seeded users. User 1 holds the fat profile (50k
  // records) and is deliberately included: some sessions must be heavy.
  const n = ((vu - 1) % USER_COUNT) + 1;
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function think() {
  sleep(THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN));
}

function headersFor(vu) {
  return { headers: { Authorization: `Bearer ${token(vu)}`, "Content-Type": "application/json" } };
}

function track(res, trend) {
  trend.add(res.timings.duration);
  if (res.status === 429) rateLimited.add(1);
  if (res.status >= 500) serverErrors.add(1);
  businessErrors.add(res.status >= 400);
  return res;
}

// Cached per VU: a real client fetches categories once at bootstrap and keeps
// them for the session, so refetching them per write would overstate read load.
const categoryCache = {};

export default function () {
  const vu = __VU;
  const h = headersFor(vu);
  let profileId;

  group("bootstrap", () => {
    const start = Date.now();
    const me = http.get(`${BASE}/auth/me`, h);
    check(me, { "me 200": (r) => r.status === 200 });
    if (me.status >= 400) serverErrors.add(me.status >= 500 ? 1 : 0);

    const profiles = http.get(`${BASE}/business-profiles`, h);
    check(profiles, { "profiles 200": (r) => r.status === 200 });
    tBootstrap.add(Date.now() - start);
    businessErrors.add(profiles.status >= 400);

    if (profiles.status === 200) {
      try {
        const body = profiles.json();
        if (Array.isArray(body) && body.length > 0) profileId = body[0].id;
      } catch (_) { /* body shape is asserted by the check above */ }
    }
  });

  if (!profileId) return;

  if (categoryCache[profileId] === undefined) {
    const cats = http.get(`${BASE}/records/categories?businessProfileId=${profileId}`, h);
    businessErrors.add(cats.status >= 400);
    let first = null;
    if (cats.status === 200) {
      try {
        const body = cats.json();
        if (Array.isArray(body) && body.length > 0) first = body[0].id;
      } catch (_) { /* checked below by the write's own assertion */ }
    }
    categoryCache[profileId] = first;
  }

  think();

  group("dashboard", () => {
    const start = Date.now();
    const summary = http.get(`${BASE}/dashboard/summary?businessProfileId=${profileId}&periodDays=30`, h);
    track(summary, tDashboard);
    check(summary, { "summary 200": (r) => r.status === 200 });
    const flagged = http.get(`${BASE}/records/flagged/count?businessProfileId=${profileId}`, h);
    track(flagged, tDashboard);
    tDashboard.add(Date.now() - start);
  });

  think();

  group("records", () => {
    const res = http.get(`${BASE}/records/search?businessProfileId=${profileId}&limit=50`, h);
    track(res, tRecords);
    check(res, { "records 200": (r) => r.status === 200 });
  });

  think();

  // Not every session opens a report — modelling that keeps the read mix honest.
  if (Math.random() < 0.4) {
    group("insights", () => {
      const path = Math.random() < 0.5 ? "expense-behavior" : "recovery";
      const res = http.get(`${BASE}/insights/${path}?businessProfileId=${profileId}`, h);
      track(res, tInsights);
      check(res, { "insights ok": (r) => r.status === 200 || r.status === 429 });
    });
    think();
  }

  if (Math.random() * 100 < WRITE_PCT) {
    group("write", () => {
      const payload = JSON.stringify({
        businessProfileId: profileId,
        categoryId: categoryCache[profileId],
        date: "2026-09-15",
        description: `Load test expense from VU ${vu}`,
        amount: 250 + Math.floor(Math.random() * 900),
        vendor: "Load Test Vendor",
      });
      const res = http.post(`${BASE}/records/expenses`, payload, h);
      track(res, tWrite);
      // 429 is a pass: the limiter doing its job is correct behaviour, not a
      // failure. A 400 is NOT accepted any more — that meant a malformed test.
      check(res, { "write accepted": (r) => r.status === 201 || r.status === 200 || r.status === 429 });
    });
  }

  think();
}
