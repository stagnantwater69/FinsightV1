import { describe, expect, it } from "vitest";
import { extractScenario } from "../../src/lib/scenario";

// Bounded extraction for the Spending Impact drawer only. The point is that the
// AI never invents the impact numbers: an amount is pulled out here, run
// through the real deterministic simulator, and the model only describes the
// computed result. A miss must produce null (-> ask for clarification), never a
// guess.

describe("extractScenario — amounts it must read", () => {
  const cases: [string, number][] = [
    ["what if I spend ₱11,000 on a fridge", 11000],
    ["What if I spend PHP 11,000 on a fridge?", 11000],
    ["what if i spend php11000", 11000],
    ["if i buy a fridge for 11000", 11000],
    ["can I afford P11000", 11000],
    ["what if I spend 11k on a fridge", 11000],
    ["what if I spend 11 thousand on a fridge", 11000],
    ["thinking of buying a 2.5m delivery van", 2500000],
    ["what if I spend 1220.50 on supplies", 1220.5],
    ["planning to spend 1,234,567 on a truck", 1234567],
    ["spend 500 on load", 500],
  ];

  for (const [message, expected] of cases) {
    it(`reads ${expected} from "${message}"`, () => {
      expect(extractScenario(message).amount).toBe(expected);
    });
  }
});

describe("extractScenario — things that are NOT purchase amounts", () => {
  it("ignores a percentage", () => {
    // 25% is the owner's threshold, not something they intend to spend.
    expect(extractScenario("is 25% of my funds a large expense?").amount).toBeNull();
  });

  it("ignores a four-digit year", () => {
    expect(extractScenario("how did I do in 2026?").amount).toBeNull();
  });

  it("ignores an ordinal date", () => {
    expect(extractScenario("what about the 15th?").amount).toBeNull();
  });

  it("returns null when a scenario names no amount at all", () => {
    expect(extractScenario("what if I buy a new freezer").amount).toBeNull();
    expect(extractScenario("should I purchase more stock").amount).toBeNull();
  });

  it("never returns zero or a negative amount as a usable figure", () => {
    for (const msg of ["what if I spend 0", "spend nothing", "what if I spend -500"]) {
      const amount = extractScenario(msg).amount;
      expect(amount === null || amount > 0).toBe(true);
    }
  });

  it("prefers the currency-marked figure when a percentage is also present", () => {
    // Tiered matching: an explicit currency marker outranks a bare number.
    expect(extractScenario("would ₱11,000 be over my 25% threshold?").amount).toBe(11000);
  });
});

describe("extractScenario — scenario intent detection", () => {
  it("recognises hypothetical-purchase phrasing", () => {
    for (const msg of [
      "what if I buy a new freezer",
      "if i spend on stock",
      "should I purchase more inventory",
      "can I afford a new cart",
      "planning to invest in shelves",
      "thinking of getting a fridge",
    ]) {
      expect(extractScenario(msg).looksLikeScenario, msg).toBe(true);
    }
  });

  it("does not treat ordinary questions as scenarios", () => {
    // These must NOT trigger the "ask me for an amount" path — they are
    // answerable as-is from the owner's real data.
    for (const msg of [
      "what is my largest expense category",
      "did I reach today's target",
      "how much did I record this month",
    ]) {
      expect(extractScenario(msg).looksLikeScenario, msg).toBe(false);
    }
  });

  it("marks a scenario with no amount — the case that must ask for clarification", () => {
    const s = extractScenario("what if I buy a new freezer for the store?");
    expect(s.amount).toBeNull();
    expect(s.looksLikeScenario).toBe(true);
  });
});

describe("extractScenario — item label", () => {
  it("reads the item after 'on'", () => {
    expect(extractScenario("what if I spend 11000 on a fridge").label).toBe("fridge");
  });

  it("reads the item after 'for', dropping a leading article", () => {
    expect(extractScenario("spend 5000 for new shelves").label).toBe("shelves");
  });

  it("returns null when there is no readable item", () => {
    expect(extractScenario("what if I spend 11000").label).toBeNull();
  });

  it("never lets a label failure affect the amount", () => {
    // The label is cosmetic; a miss must not disturb the figure that gets
    // fed to the simulator.
    const s = extractScenario("what if I spend ₱7,500");
    expect(s.amount).toBe(7500);
    expect(s.label).toBeNull();
  });
});
