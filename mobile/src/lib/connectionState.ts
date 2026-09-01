/**
 * What to say when a request did not come back.
 *
 * ===================================================================
 * THERE IS NO OFFLINE QUEUE, AND THIS FILE IS WHERE THAT IS ADMITTED
 * ===================================================================
 * FinSight mobile reads and writes straight through to the API. There is no
 * local database, no outbox, no background sync — a save that fails is a save
 * that did not happen, and it will not happen later on its own. The plan's
 * resilience section says this out loud: "Do not imply full offline capability
 * until a sync/queue architecture exists."
 *
 * Every sentence produced below is written against that constraint. The copy
 * may say the connection is gone, may say what is still on screen, and may say
 * the owner's typing was kept — because all three are true. It may never say
 * "we'll save this when you're back", because nothing in the app would.
 *
 * ===================================================================
 * WHY OFFLINE-NESS IS INFERRED RATHER THAN OBSERVED
 * ===================================================================
 * There is no connectivity library in this project — no
 * `@react-native-community/netinfo`, no `expo-network` — and adding one to
 * answer this question would be the wrong trade. A radio that reports "WiFi
 * connected" tells you nothing about a captive portal, a backend that is not
 * routable from the phone's network, or a laptop running the API on
 * `localhost` while the phone is on the same wifi and cannot reach it. Those
 * are the three failures this app actually hits during development and in a
 * Philippine market stall alike.
 *
 * So "offline" here means the narrower, provable thing: THIS request never got
 * an answer. `lib/api.ts` already models that — its `networkError` builds an
 * `ApiError` with `status: 0`, which no HTTP response can produce. That is the
 * signal.
 *
 * DUCK-TYPED ON PURPOSE. This module does not import `ApiError`, because
 * `lib/api.ts` pulls in `lib/supabase.ts` and therefore the Expo runtime, and
 * the test runner has no Expo. Checking for `status === 0` structurally keeps
 * every sentence below testable as plain data. The cost is that the link is by
 * convention rather than by the type system, which is what the comment on
 * `UNREACHABLE_STATUS` is for.
 *
 * ===================================================================
 * THE DISTINCTION THIS FILE EXISTS TO DRAW
 * ===================================================================
 * "Cannot refresh" and "no data" are different facts and the app was showing
 * them as the same thing. Records, on a failed first load, rendered "You
 * haven't added any records yet" — telling an owner whose wifi dropped that
 * their books are empty. Home rendered a skeleton that never resolved.
 *
 * `describeLoadFailure` takes the one bit that separates them — whether there
 * is anything on screen already — and returns different words for each.
 */

/**
 * The status `lib/api.ts` stamps on a request that never reached the server.
 *
 * Kept in step with `networkError` there by hand. If that ever starts using a
 * different sentinel, `tests/connectionState.test.ts` will not catch it — but
 * every offline banner in the app would quietly downgrade to the server-side
 * wording, which is the failure mode to watch for.
 */
const UNREACHABLE_STATUS = 0;

/** How far the request got. */
export type FailureReach =
  /** It never reached FinSight — no signal, wrong address, captive portal. */
  | "unreachable"
  /** FinSight answered, and the answer was a refusal or a fault. */
  | "server";

export interface LoadFailure {
  reach: FailureReach;
  /** The message the API layer already composed. Shown for server failures. */
  message: string;
}

/** True when the request never got an answer at all. */
export function isUnreachable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: unknown }).status === UNREACHABLE_STATUS;
}

/**
 * A caught error, as the two facts a screen needs to store.
 *
 * Screens hold this instead of a bare string, because the string alone cannot
 * answer "was this the network or the server?" — and `lib/api.ts`'s
 * unreachable message is a long diagnostic with the API base URL in it, which
 * is the right thing for a developer and the wrong thing for a banner.
 */
export function toLoadFailure(err: unknown, fallback = "Something went wrong. Please try again."): LoadFailure {
  const message = err instanceof Error && err.message ? err.message : fallback;
  return { reach: isUnreachable(err) ? "unreachable" : "server", message };
}

/* ==================================================================
   "LAST UPDATED"
   ==================================================================
   One phrasing, everywhere. The plan asks for consistent "last updated"
   language; before this each screen either had none or invented its own.

   Deliberately NOT `Intl.RelativeTimeFormat` or a date library: the phrases
   below are the four an owner needs, they are testable as plain strings, and
   the app already ships no i18n. Everything is a plain phrase that reads
   correctly after the word "loaded" and after the word "Updated", which is the
   only grammatical contract the call sites rely on.
   ------------------------------------------------------------------ */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "just now" | "5 minutes ago" | "2 hours ago" | "3 days ago". */
export function lastUpdatedLabel(at: number, now: number): string {
  // A clock that has gone backwards (a manual time change, an NTP correction)
  // must not produce "-3 minutes ago". Anything not in the past reads as now.
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return plural(Math.floor(elapsed / MINUTE_MS), "minute");
  if (elapsed < DAY_MS) return plural(Math.floor(elapsed / HOUR_MS), "hour");
  return plural(Math.floor(elapsed / DAY_MS), "day");
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** The caption a screen prints under its figures. */
export function lastUpdatedLine(at: number | null | undefined, now: number): string | null {
  if (at == null) return null;
  return `Updated ${lastUpdatedLabel(at, now)}`;
}

/**
 * The same phrase inside a sentence, when the timestamp may be missing.
 *
 * "earlier" is the honest fallback: a screen that never recorded when its data
 * arrived should not invent a time, and "what loaded earlier" is true whatever
 * the answer would have been.
 */
function whenLoaded(at: number | null | undefined, now: number): string {
  return at == null ? "earlier" : lastUpdatedLabel(at, now);
}

/* ==================================================================
   THE NOTICES
   ================================================================== */

export type NoticeKind = "cannot-load" | "cannot-refresh";

export interface LoadNotice {
  kind: NoticeKind;
  /**
   * `error` when the screen has nothing to show, `warn` when it still has
   * usable figures. Severity follows consequence, not the size of the
   * failure — an owner reading month-old figures is inconvenienced; an owner
   * staring at a blank screen is stuck.
   */
  tone: "warn" | "error";
  title: string;
  body: string;
  retryLabel: string;
}

export interface LoadFailureContext {
  /** Whether anything already loaded is still on screen. */
  hasData: boolean;
  /** When that data arrived, as `Date.now()`. */
  lastUpdatedAt?: number | null;
  now?: number;
  /**
   * What this screen shows, as a PLURAL noun phrase — "these figures", "your
   * records", "your notifications". Used only in the nothing-loaded wording,
   * where the sentence needs a subject; the stale wording says "what's on
   * screen" and needs none.
   */
  subject?: string;
}

/**
 * The failure, as the words to put on the screen — or `null` when there is no
 * failure to report.
 */
export function describeLoadFailure(
  failure: LoadFailure | null | undefined,
  context: LoadFailureContext,
): LoadNotice | null {
  if (!failure) return null;
  const now = context.now ?? Date.now();
  const retryLabel = "Try again";

  if (context.hasData) {
    const when = whenLoaded(context.lastUpdatedAt, now);
    return failure.reach === "unreachable"
      ? {
          kind: "cannot-refresh",
          tone: "warn",
          title: "Can't reach FinSight",
          body:
            `Your phone couldn't reach FinSight's server, so this couldn't be refreshed. ` +
            `What's on screen is what loaded ${when} and may have changed since.`,
          retryLabel,
        }
      : {
          kind: "cannot-refresh",
          tone: "warn",
          title: "Couldn't refresh",
          body: `${failure.message} What's on screen is still what loaded ${when}.`,
          retryLabel,
        };
  }

  const subject = context.subject ?? "these figures";
  return failure.reach === "unreachable"
    ? {
        kind: "cannot-load",
        tone: "error",
        title: "Can't reach FinSight",
        body:
          `Your phone couldn't reach FinSight's server, so ${subject} haven't loaded. ` +
          `Nothing is missing from your account — there is just nothing to show here until the connection is back.`,
        retryLabel,
      }
    : {
        kind: "cannot-load",
        tone: "error",
        title: "Couldn't load this",
        body: `${failure.message} Nothing on your account has changed.`,
        retryLabel,
      };
}

/**
 * A failed one-shot ACTION, as a single sentence.
 *
 * The difference from `describeSaveFailure` is what the owner is looking at.
 * A failed save leaves a form full of their typing, so the reassurance is
 * about that typing. A failed delete or resolve leaves a LIST — the optimistic
 * change has already been rolled back — so the reassurance is that the record
 * is exactly as it was. Both refuse to imply a retry will happen by itself.
 *
 * `reassurance` is the caller's, because only the caller knows what was left
 * untouched. It is required rather than defaulted: a generic "nothing was
 * lost" is the kind of sentence that eventually gets attached to something
 * where it is not true.
 */
export function describeActionFailure(failure: LoadFailure, reassurance: string): string {
  return failure.reach === "unreachable"
    ? `Your phone couldn't reach FinSight's server, so nothing was changed. ${reassurance}`
    : `${failure.message} ${reassurance}`;
}

/**
 * The failed-save counterpart.
 *
 * THE SENTENCE THAT MATTERS is "Everything you entered is still here." It is
 * true — every form in this app keeps its state on a failed submit and only
 * navigates away on success — and it is the one reassurance that stops an
 * owner retyping a receipt they can still see. It is also carefully NOT
 * "we'll save it for you": the last clause of the unreachable wording says the
 * opposite in as many words, because that is the promise this app cannot keep.
 *
 * `action` is the label on the button the owner will press again, so the
 * instruction names the control in front of them rather than a generic "save".
 */
export function describeSaveFailure(failure: LoadFailure, action = "Save"): LoadNotice {
  return failure.reach === "unreachable"
    ? {
        kind: "cannot-load",
        tone: "error",
        title: "Can't reach FinSight",
        body:
          `Your phone couldn't reach FinSight's server, so this wasn't saved. ` +
          `Everything you entered is still here — press ${action} again once you have a connection. ` +
          `FinSight can't save it in the background for you.`,
        retryLabel: action,
      }
    : {
        kind: "cannot-load",
        tone: "error",
        title: "Couldn't save this",
        body: `${failure.message} Everything you entered is still here.`,
        retryLabel: action,
      };
}

/**
 * `describeSaveFailure`'s sentence, for the forms that show a plain
 * `ErrorNote` rather than the full banner.
 *
 * A form already has the Save button on screen, so a banner with its own retry
 * control would put two buttons for the same act next to each other. The words
 * are what the form was missing, not the control.
 */
export function saveFailureMessage(err: unknown, action = "Save"): string {
  return describeSaveFailure(toLoadFailure(err), action).body;
}
