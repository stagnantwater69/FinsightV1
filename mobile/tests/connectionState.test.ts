import { describe, expect, it } from "vitest";
import {
  describeActionFailure,
  describeLoadFailure,
  describeSaveFailure,
  isUnreachable,
  lastUpdatedLabel,
  lastUpdatedLine,
  saveFailureMessage,
  toLoadFailure,
  type LoadFailure,
} from "../src/lib/connectionState";

/**
 * The offline and stale-data wording, pinned.
 *
 * WHY THE COPY IS TESTED AND NOT JUST THE BRANCHING. This app has no sync
 * queue: a save that fails is a save that did not happen. The plan's rule is
 * "do not imply full offline capability until a sync/queue architecture
 * exists", and the way that rule gets broken is not by someone rewriting the
 * architecture — it is by someone softening a sentence. "We'll save this when
 * you're back online" is a kinder thing to read and a lie, and nothing in a
 * typecheck or a render has an opinion about it.
 *
 * So the last block below is a check on the VOCABULARY of every string this
 * module can produce. It is deliberately blunt: any phrase that promises later
 * work fails it, wherever it appears.
 */

const UNREACHABLE: LoadFailure = { reach: "unreachable", message: "Couldn't reach FinSight. [detail]" };
const SERVER: LoadFailure = { reach: "server", message: "FinSight's server had a problem with that." };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("isUnreachable", () => {
  it("recognises the status lib/api.ts stamps on a request that never landed", () => {
    expect(isUnreachable({ status: 0 })).toBe(true);
  });

  it("treats every real HTTP status as an answer from the server", () => {
    for (const status of [400, 401, 404, 409, 429, 500, 503]) {
      expect(isUnreachable({ status })).toBe(false);
    }
  });

  it("does not mistake a plain error for an unreachable server", () => {
    // pollBatch in the CSV import throws bare Errors. Those are FinSight
    // saying something went wrong, not the phone failing to reach it.
    expect(isUnreachable(new Error("The import could not be finished."))).toBe(false);
    expect(isUnreachable(null)).toBe(false);
    expect(isUnreachable(undefined)).toBe(false);
    expect(isUnreachable("offline")).toBe(false);
  });
});

describe("toLoadFailure", () => {
  it("keeps the API layer's message and classifies the reach", () => {
    const err = Object.assign(new Error("Some details need fixing."), { status: 400 });
    expect(toLoadFailure(err)).toEqual({ reach: "server", message: "Some details need fixing." });
  });

  it("falls back rather than showing an empty banner", () => {
    expect(toLoadFailure({}).message).toBe("Something went wrong. Please try again.");
  });
});

describe("lastUpdatedLabel", () => {
  const now = 1_000 * DAY;

  it("reads as now for anything under a minute", () => {
    expect(lastUpdatedLabel(now, now)).toBe("just now");
    expect(lastUpdatedLabel(now - 59_000, now)).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(lastUpdatedLabel(now - MINUTE, now)).toBe("1 minute ago");
    expect(lastUpdatedLabel(now - 5 * MINUTE, now)).toBe("5 minutes ago");
    expect(lastUpdatedLabel(now - HOUR, now)).toBe("1 hour ago");
    expect(lastUpdatedLabel(now - 5 * HOUR, now)).toBe("5 hours ago");
    expect(lastUpdatedLabel(now - DAY, now)).toBe("1 day ago");
    expect(lastUpdatedLabel(now - 9 * DAY, now)).toBe("9 days ago");
  });

  it("never reports a negative age when the phone's clock moves backwards", () => {
    // An NTP correction or a manual time change can put `at` in the future.
    // "-3 minutes ago" would be the kind of detail that makes an owner
    // distrust every other figure on the screen.
    expect(lastUpdatedLabel(now + HOUR, now)).toBe("just now");
  });
});

describe("lastUpdatedLine", () => {
  const now = 1_000 * DAY;

  it("prints nothing at all when no load has ever succeeded", () => {
    // Rather than "Updated never", which reads as a fault.
    expect(lastUpdatedLine(null, now)).toBeNull();
    expect(lastUpdatedLine(undefined, now)).toBeNull();
  });

  it("uses the same phrase as the label", () => {
    expect(lastUpdatedLine(now - 3 * MINUTE, now)).toBe("Updated 3 minutes ago");
  });
});

describe("describeLoadFailure", () => {
  const now = 1_000 * DAY;

  it("says nothing when nothing failed", () => {
    expect(describeLoadFailure(null, { hasData: true, now })).toBeNull();
  });

  /*
   * The distinction the whole module exists for. Records used to render "You
   * haven't added any records yet" over a failed search — telling an owner
   * their books were empty because their wifi dropped.
   */
  it("separates cannot-load from cannot-refresh by whether anything is on screen", () => {
    const blank = describeLoadFailure(UNREACHABLE, { hasData: false, now, subject: "your records" })!;
    const stale = describeLoadFailure(UNREACHABLE, { hasData: true, now, lastUpdatedAt: now - 5 * MINUTE })!;

    expect(blank.kind).toBe("cannot-load");
    expect(blank.tone).toBe("error");
    expect(stale.kind).toBe("cannot-refresh");
    expect(stale.tone).toBe("warn");
    expect(blank.body).not.toBe(stale.body);
  });

  it("tells an owner with an empty screen that their records are not the thing that is missing", () => {
    const notice = describeLoadFailure(UNREACHABLE, { hasData: false, now, subject: "your records" })!;
    expect(notice.body).toContain("your records haven't loaded");
    expect(notice.body).toContain("Nothing is missing from your account");
  });

  it("ages the figures it is describing", () => {
    const notice = describeLoadFailure(UNREACHABLE, { hasData: true, now, lastUpdatedAt: now - 2 * HOUR })!;
    expect(notice.body).toContain("what loaded 2 hours ago");
  });

  it("says 'earlier' rather than inventing a time it was never told", () => {
    const notice = describeLoadFailure(SERVER, { hasData: true, now })!;
    expect(notice.body).toContain("what loaded earlier");
  });

  it("shows the server's own message when the server answered", () => {
    // The unreachable message from lib/api.ts is a diagnostic with the API
    // base URL in it — right for a developer, wrong for a banner — so it is
    // replaced, while a real server message is the most specific thing there is.
    expect(describeLoadFailure(SERVER, { hasData: false, now })!.body).toContain(SERVER.message);
    expect(describeLoadFailure(UNREACHABLE, { hasData: false, now })!.body).not.toContain(UNREACHABLE.message);
  });

  it("always offers a way to try again", () => {
    for (const hasData of [true, false]) {
      for (const failure of [UNREACHABLE, SERVER]) {
        expect(describeLoadFailure(failure, { hasData, now })!.retryLabel).toBe("Try again");
      }
    }
  });
});

describe("describeSaveFailure", () => {
  it("promises the typing is kept, and only that", () => {
    const notice = describeSaveFailure(UNREACHABLE, "Save expense");
    expect(notice.body).toContain("Everything you entered is still here");
    expect(notice.body).toContain("press Save expense again once you have a connection");
    // The honesty clause. There is no outbox behind this app.
    expect(notice.body).toContain("FinSight can't save it in the background for you");
  });

  it("names the button in front of the owner", () => {
    expect(describeSaveFailure(UNREACHABLE, "Import these rows").retryLabel).toBe("Import these rows");
  });

  it("keeps the reassurance when the failure came from the server", () => {
    const notice = describeSaveFailure(SERVER, "Save");
    expect(notice.body).toContain(SERVER.message);
    expect(notice.body).toContain("Everything you entered is still here");
  });

  it("saveFailureMessage is the same sentence, for forms that show a plain note", () => {
    expect(saveFailureMessage(Object.assign(new Error("x"), { status: 0 }), "Save expense")).toBe(
      describeSaveFailure({ reach: "unreachable", message: "x" }, "Save expense").body,
    );
  });
});

describe("describeActionFailure", () => {
  it("reassures about the record rather than about a form", () => {
    // A failed delete leaves a list, not a half-typed form, so "everything you
    // entered is still here" would be answering a question nobody asked.
    const line = describeActionFailure(UNREACHABLE, "The record is still in your books.");
    expect(line).toBe(
      "Your phone couldn't reach FinSight's server, so nothing was changed. The record is still in your books.",
    );
  });

  it("leads with the server's own words when there were any", () => {
    expect(describeActionFailure(SERVER, "The item is still on the receipt.")).toBe(
      `${SERVER.message} The item is still on the receipt.`,
    );
  });
});

/**
 * The vocabulary guard.
 *
 * Every sentence this module can produce, checked against the phrases that
 * would claim a capability the app does not have.
 *
 * KNOWN LIMIT, don't mistake this for airtight: `everySentence()` calls the
 * four exported describe* functions by hand. It exercises their real output,
 * not a copy of it — but a FIFTH exported notice is silently uncovered until
 * someone adds it to the list below. The guard also stops at this module's
 * border: copy written directly into ConnectionNotice.tsx or a screen is not
 * checked here. Both are why the phrases matter more than the mechanism.
 */
describe("no string in this module promises a background sync", () => {
  const now = 1_000 * DAY;

  const everySentence = (): string[] => {
    const out: string[] = [];
    for (const failure of [UNREACHABLE, SERVER]) {
      for (const hasData of [true, false]) {
        const notice = describeLoadFailure(failure, { hasData, now, lastUpdatedAt: now - MINUTE })!;
        out.push(notice.title, notice.body, notice.retryLabel);
      }
      const save = describeSaveFailure(failure, "Save");
      out.push(save.title, save.body, save.retryLabel);
      out.push(describeActionFailure(failure, "The record is unchanged."));
    }
    return out;
  };

  /**
   * Phrases that would be a promise. "queue", "sync" and "later" are the
   * obvious ones; "when you're back online" is the specific sentence every
   * offline banner on the internet uses and the one this app must not.
   */
  const FORBIDDEN = [
    "sync",
    "synced",
    "queue",
    "queued",
    "save it later",
    "saved later",
    "we'll save",
    "will be saved when",
    "back online",
    "offline mode",
    "works offline",
  ];

  it("never uses a phrase that implies the work will happen by itself", () => {
    for (const sentence of everySentence()) {
      for (const phrase of FORBIDDEN) {
        expect(
          sentence.toLowerCase().includes(phrase),
          `"${phrase}" appears in: ${sentence}`,
        ).toBe(false);
      }
    }
  });

  it("still says the connection is the problem, so the banner is actionable", () => {
    const unreachableSentences = [
      describeLoadFailure(UNREACHABLE, { hasData: true, now })!.body,
      describeLoadFailure(UNREACHABLE, { hasData: false, now })!.body,
      describeSaveFailure(UNREACHABLE).body,
      describeActionFailure(UNREACHABLE, "Nothing changed."),
    ];
    for (const sentence of unreachableSentences) {
      expect(sentence).toContain("couldn't reach FinSight's server");
    }
  });
});
