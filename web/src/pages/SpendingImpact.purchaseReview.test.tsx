// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SpendingImpact } from "./SpendingImpact";
import { discussionPrompt } from "../lib/purchaseConversation";
import type {
  BusinessProfile,
  PurchasePriceContext,
  PurchaseReview,
  SpendingImpact as SpendingImpactData,
} from "../lib/types";

/**
 * The description box, and whether it earns its place.
 *
 * "What are you planning to buy?" used to change nothing: it fed a silent
 * category guess and a phrase in the summary, so an owner who typed "display
 * fridge" got back the arithmetic they would have got by typing nothing. These
 * tests are about the part that changed — that the words are read back, that
 * the reading is labelled as AI-written, and that a page whose whole value is
 * calculated figures still works when the AI does not.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE: whether the model classifies well.
 * That varies by model and by day. The rule that it must never issue a verdict
 * is enforced on the server, where a test can hold it —
 * backend/tests/unit/purchaseReview.test.ts.
 */

const profile = {
  id: 1,
  name: "Sari-sari",
  availableFunds: 50000,
  expectedMonthlyExpenses: 20000,
  largeExpenseThresholdPercent: 20,
} as unknown as BusinessProfile;

const impact: SpendingImpactData = {
  periodDays: 30,
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-01-31T00:00:00.000Z",
  plannedAmount: 11000,
  thresholdPercent: 20,
  thresholdAmount: 10000,
  percentOfFunds: 22,
  impactBand: "High Impact",
  exceedsFunds: false,
  funds: { before: 50000, after: 39000 },
  periodExpenses: { before: 8000, after: 19000 },
  availableFunds: 50000,
  resultingFunds: 39000,
};

const price: PurchasePriceContext = {
  categoryId: 1,
  categoryName: "Equipment",
  recordCount: 4,
  typicalAmount: 4200,
  smallestAmount: 1800,
  largestAmount: 9800,
  multipleOfTypical: 2.62,
  comparison: "far-above",
  similar: [
    { description: "Chest fridge deposit", amount: 9800, date: "2026-03-04T00:00:00.000Z", categoryName: "Equipment" },
  ],
  windowDays: 365,
};

const review: PurchaseReview = {
  kind: "asset",
  kindReason: "A fridge is bought once and kept, and it keeps working for years.",
  businessUse: "A store uses one to keep drinks cold so they sell for more than warm stock.",
  ongoingCosts: "Electricity every month, and the odd repair.",
  priceCheck: "Ask whether delivery and installation are included, and whether that price is for a new unit.",
  questions: [
    "How many hours a day would it actually run?",
    "Does it replace ice you already buy every week?",
  ],
};

let postHandler: (url: string, body: unknown) => unknown;

vi.mock("../lib/api", () => ({
  api: {
    get: async () => ({ data: impact }),
    post: async (url: string, body: unknown) => postHandler(url, body),
  },
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));
vi.mock("../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({ categories: [{ id: 1, name: "Equipment" }] }),
}));
/*
 * The floating trigger portals itself to <body> and is not what these tests
 * are about; the hook beside it is left real, because the question it hands to
 * the drawer IS the behaviour under test.
 */
vi.mock("../components/AskFinSightButton", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/AskFinSightButton")>()),
  AskFinSightButton: () => null,
}));

/*
 * Ask FinSight is a drawer owned by AiChatContext up in the authenticated
 * layout, not a route. Asserting on `openChat` is therefore asserting on the
 * real seam this page talks through — the alternative, mounting the whole
 * provider and drawer, would test the drawer rather than the card.
 */
const openChat = vi.fn();
vi.mock("../context/AiChatContext", () => ({
  useAiChat: () => ({ openChat }),
}));

/** The question the card handed to the drawer on the last open. */
function askedQuestion(): string {
  return String(openChat.mock.calls.at(-1)?.[1] ?? "");
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/insights/spending-impact"]}>
      <SpendingImpact />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  openChat.mockClear();
  postHandler = (url) => {
    if (url === "/ai/purchase-review") return { data: { review, priceContext: price } };
    // The category suggestion, which fires from its own typing debounce.
    return { data: { suggestion: null } };
  };
});

describe("reading the description back", () => {
  it("stays out of the way until there is an item to describe", async () => {
    renderPage();
    expect(screen.getByRole("button", { name: /what am i buying/i })).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText("e.g. Display fridge"), "Display fridge");
    expect(screen.getByRole("button", { name: /what am i buying/i })).toBeEnabled();
  });

  it("describes the item, its running costs, and what to ask", async () => {
    renderPage();
    await userEvent.type(screen.getByPlaceholderText("e.g. Display fridge"), "Display fridge");
    await userEvent.click(screen.getByRole("button", { name: /what am i buying/i }));

    expect(await screen.findByText(/A fridge is bought once and kept/)).toBeInTheDocument();
    expect(screen.getByText(/Electricity every month/)).toBeInTheDocument();
    expect(screen.getByText(/Does it replace ice you already buy every week\?/)).toBeInTheDocument();
    expect(screen.getByText("Something you keep")).toBeInTheDocument();
  });

  /**
   * The provenance rule this codebase already follows everywhere else: an
   * owner is entitled to know which words on a screen were calculated and
   * which were written by a model, BEFORE weighing them.
   */
  it("says the words are AI-written and the figures are not", async () => {
    renderPage();
    await userEvent.type(screen.getByPlaceholderText("e.g. Display fridge"), "Display fridge");
    await userEvent.click(screen.getByRole("button", { name: /what am i buying/i }));

    expect(await screen.findByText(/Written by AI from what you typed/)).toBeInTheDocument();
    expect(screen.getByText(/Whether to buy this is your call/)).toBeInTheDocument();
  });

  it("sends the item and the amount, and no figures about the business", async () => {
    const sent: unknown[] = [];
    postHandler = (url, body) => {
      if (url === "/ai/purchase-review") {
        sent.push(body);
        return { data: { review, priceContext: price } };
      }
      return { data: { suggestion: null } };
    };

    renderPage();
    await userEvent.type(screen.getByPlaceholderText("e.g. Display fridge"), "Display fridge");
    await userEvent.type(screen.getByPlaceholderText("11000"), "11000");
    await userEvent.click(screen.getByRole("button", { name: /what am i buying/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ businessProfileId: 1, description: "Display fridge", plannedAmount: 11000 });
  });

  /*
   * Losing the card on every keystroke would be worse than keeping it, so it
   * stays — and says out loud that it describes the older wording.
   */
  it("admits when the description has moved on since it was written", async () => {
    renderPage();
    const item = screen.getByPlaceholderText("e.g. Display fridge");
    await userEvent.type(item, "Display fridge");
    await userEvent.click(screen.getByRole("button", { name: /what am i buying/i }));
    await screen.findByText(/A fridge is bought once and kept/);

    await userEvent.type(item, " second hand");
    expect(await screen.findByRole("button", { name: /item changed/i })).toBeInTheDocument();
  });
});

/**
 * "Is this the right price?" — answered against the owner's own records,
 * because that is the only half of the question anything here can know. What a
 * display fridge costs in Cebu this week is not in this system, and the server
 * drops any price claim the model makes rather than letting a guess sit inches
 * from figures that are real.
 */
describe("placing the amount against what they have paid before", () => {
  async function openReview() {
    renderPage();
    await userEvent.type(screen.getByPlaceholderText("e.g. Display fridge"), "Display fridge");
    await userEvent.type(screen.getByPlaceholderText("11000"), "11000");
    await userEvent.click(screen.getByRole("button", { name: /what am i buying/i }));
    await screen.findByText(/A fridge is bought once and kept/);
  }

  it("shows the last similar purchase and the category's usual spend", async () => {
    await openReview();
    expect(screen.getByText("Chest fridge deposit")).toBeInTheDocument();
    // Twice over: the record itself, and the top of the category's range.
    expect(screen.getAllByText(/PHP 9,800/).length).toBeGreaterThan(0);
    expect(screen.getByText(/usually run/)).toHaveTextContent("PHP 4,200");
    expect(screen.getByText(/2.62×/)).toBeInTheDocument();
  });

  it("describes the gap without pronouncing on it", async () => {
    await openReview();
    expect(screen.getByText("Well beyond anything in your records")).toBeInTheDocument();
    // A fact about their history, never an opinion about a market nobody here
    // can see.
    expect(document.body.textContent).not.toMatch(/too expensive|overpriced|good deal|fair price/i);
  });

  it("says these figures were counted, not written", async () => {
    await openReview();
    expect(screen.getByText(/Counted from your own records — not written by AI/)).toBeInTheDocument();
  });

  it("shows what to check about the price, from the AI half", async () => {
    await openReview();
    expect(screen.getByText(/delivery and installation are included/)).toBeInTheDocument();
  });

  it("sends the reference category so the comparison uses the right records", async () => {
    const sent: Record<string, unknown>[] = [];
    postHandler = (url, body) => {
      if (url === "/ai/purchase-review") {
        sent.push(body as Record<string, unknown>);
        return { data: { review, priceContext: price } };
      }
      return { data: { suggestion: null } };
    };

    renderPage();
    await userEvent.type(screen.getByPlaceholderText("e.g. Display fridge"), "Display fridge");
    await userEvent.selectOptions(screen.getByLabelText(/Reference category/), "1");
    await userEvent.click(screen.getByRole("button", { name: /what am i buying/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.categoryId).toBe(1);
  });

  /**
   * The two halves come apart cleanly, and that is the point of computing one
   * of them. The paragraphs need a model; this comparison needs only the
   * owner's records, so it is still a real answer when the AI is down.
   */
  it("still compares the price when the AI cannot describe the item", async () => {
    postHandler = (url) => {
      if (url === "/ai/purchase-review") return { data: { review: null, priceContext: price } };
      return { data: { suggestion: null } };
    };

    renderPage();
    await userEvent.type(screen.getByPlaceholderText("e.g. Display fridge"), "Display fridge");
    await userEvent.type(screen.getByPlaceholderText("11000"), "11000");
    await userEvent.click(screen.getByRole("button", { name: /what am i buying/i }));

    expect(await screen.findByText("Chest fridge deposit")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/AI is unreachable/i);
  });

  it("says plainly when their records hold nothing like it", async () => {
    postHandler = (url) => {
      if (url === "/ai/purchase-review") {
        return {
          data: {
            review,
            priceContext: {
              ...price,
              recordCount: 0,
              typicalAmount: null,
              smallestAmount: null,
              largestAmount: null,
              multipleOfTypical: null,
              comparison: "no-history",
              similar: [],
            },
          },
        };
      }
      return { data: { suggestion: null } };
    };

    await openReview();
    expect(screen.getByText(/nothing of your own to compare it against yet/i)).toBeInTheDocument();
  });
});

describe("carrying the card into a conversation", () => {
  it("opens Ask FinSight primed with the item and what FinSight said about it", async () => {
    renderPage();
    await userEvent.type(screen.getByPlaceholderText("e.g. Display fridge"), "Display fridge");
    await userEvent.type(screen.getByPlaceholderText("11000"), "11000");
    await userEvent.click(screen.getByRole("button", { name: /what am i buying/i }));
    await screen.findByText(/A fridge is bought once and kept/);

    await userEvent.click(screen.getByRole("button", { name: /talk this through/i }));

    await waitFor(() => expect(openChat).toHaveBeenCalled());
    expect(openChat.mock.calls.at(-1)?.[0]).toBe("Spending Impact");
    expect(askedQuestion()).toContain("Display fridge");
    expect(askedQuestion()).toMatch(/something the business keeps and uses/);
    expect(askedQuestion()).toMatch(/Electricity every month/);
  });

  /*
   * PRIMED, NOT SENT. `initialQuestion` only fills the drawer's box — the
   * same contract the "expand on this" link honours — so the owner reads the
   * question and decides before anything reaches the model.
   */
  it("asks nothing on the owner's behalf", async () => {
    const posted: string[] = [];
    postHandler = (url) => {
      posted.push(url);
      if (url === "/ai/purchase-review") return { data: { review, priceContext: price } };
      return { data: { suggestion: null } };
    };

    renderPage();
    await userEvent.type(screen.getByPlaceholderText("e.g. Display fridge"), "Display fridge");
    await userEvent.click(screen.getByRole("button", { name: /what am i buying/i }));
    await screen.findByText(/A fridge is bought once and kept/);
    await userEvent.click(screen.getByRole("button", { name: /talk this through/i }));

    expect(posted).not.toContain("/ai/ask");
  });
});

describe("the primed question itself", () => {
  /**
   * The API caps a question at 500 characters and the drawer's input carries
   * the same maxLength, so an over-long prompt would arrive as a sentence the
   * owner never wrote, cut mid-word.
   */
  it("stays inside the question limit even when the AI was wordy", () => {
    const wordy = { ...review, ongoingCosts: "Electricity, ".repeat(60) };
    const prompt = discussionPrompt("Display fridge", wordy, 11000);
    expect(prompt.length).toBeLessThanOrEqual(500);
    expect(prompt.trim()).toMatch(/\?$/);
  });

  it("keeps the item and the classification when the costs clause is dropped", () => {
    const wordy = { ...review, ongoingCosts: "Electricity, ".repeat(60) };
    const prompt = discussionPrompt("Display fridge", wordy, 11000);
    expect(prompt).toContain("Display fridge");
    expect(prompt).toMatch(/something the business keeps and uses/);
  });

  it("leaves the amount out when the owner has not given one", () => {
    const prompt = discussionPrompt("Display fridge", review, "");
    expect(prompt).toContain("Display fridge");
    expect(prompt).not.toMatch(/PHP/);
  });
});

describe("when the AI cannot answer", () => {
  /**
   * THE RULE FOR EVERY AI SURFACE IN THIS PRODUCT: it accelerates a manual
   * flow, it is never a dependency of one. The impact figures are calculated
   * by FinSight and must survive the model being unreachable — and the owner
   * must be told which is which rather than left with a blank space.
   */
  it("keeps the calculated figures and says why the card is missing", async () => {
    postHandler = (url) => {
      if (url === "/ai/purchase-review") return { data: { review: null, priceContext: null } };
      return { data: { suggestion: null } };
    };

    renderPage();
    await userEvent.type(screen.getByPlaceholderText("e.g. Display fridge"), "Display fridge");
    await userEvent.type(screen.getByPlaceholderText("11000"), "11000");
    await userEvent.click(screen.getByRole("button", { name: /what am i buying/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not describe this item/i);
    expect(screen.getByText(/calculated by FinSight, not by AI/)).toBeInTheDocument();
    // The scenario itself is untouched.
    // Both the band pill and the summary say it, hence findAll.
    expect(await screen.findAllByText("High Impact")).not.toHaveLength(0);
  });

  it("surfaces a rate limit or network failure as an error, not as silence", async () => {
    postHandler = (url) => {
      if (url === "/ai/purchase-review") throw new Error("Request failed with status code 429");
      return { data: { suggestion: null } };
    };

    renderPage();
    await userEvent.type(screen.getByPlaceholderText("e.g. Display fridge"), "Display fridge");
    await userEvent.click(screen.getByRole("button", { name: /what am i buying/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
