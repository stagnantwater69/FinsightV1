// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { AiChatProvider } from "../context/AiChatContext";
import { AskFinSightDrawer } from "./AskFinSightDrawer";
import { useAskFinSight } from "./AskFinSightButton";
import { ToastProvider } from "./Toast";
import type { ChatMessage, Conversation, InteractionModule, ReductionOpportunity } from "../lib/types";

/**
 * WHAT THIS FILE GUARDS.
 *
 * The drawer went back to being a drawer, but it must NOT go back to being the
 * drawer it originally was. The one that shipped first refetched on open and
 * threw its thread away on close, so pressing Escape or walking to another
 * screen cost an owner their line of enquiry. That is the invariant with the
 * most tests here:
 *
 *   1. INDEPENDENCE — opening and closing the drawer starts no conversation,
 *      resets none, and issues no request.
 *   2. SURVIVAL — a conversation and its messages outlive closing the drawer,
 *      navigating to a different page, and reopening it there. The state lives
 *      in AiChatContext, above the route.
 *   3. LAZY CREATION — "New chat" persists nothing; only the first send writes.
 *
 * It also carries the coverage the old AskFinSightDrawer.test.tsx and the
 * short-lived AiChat.test.tsx held between them: the grouped history list, the
 * rename/delete menu, the unavailable banner, and starter chips priming the box
 * without ever sending.
 */

// jsdom implements no scrolling, and the message list pins itself to the newest
// message on every render. Not a stub of anything under test.
Element.prototype.scrollTo = () => {};

const profile = { id: 7, name: "Sari-sari" };

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));

let confirmResult = true;
const confirmSpy = vi.fn(async () => confirmResult);
vi.mock("./ConfirmDialog", () => ({
  // The real ConfirmProvider drives a <dialog>, which jsdom does not implement.
  // What matters here is that deletion goes THROUGH the shared confirm rather
  // than round a native confirm() or no gate at all, so the spy asserts the
  // options it was handed.
  useConfirm: () => confirmSpy,
}));

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    patch: (...args: unknown[]) => patch(...args),
    delete: (...args: unknown[]) => del(...args),
  },
}));

const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 1,
    title: "Why did rent go up?",
    originModule: "Dashboard",
    createdAt: iso(0),
    lastMessageAt: iso(0),
    ...over,
  };
}

function message(id: number, role: ChatMessage["role"], content: string): ChatMessage {
  return { id, role, content, createdAt: iso(0) };
}

const LIST = [
  conversation({ id: 1, title: "Why did rent go up?" }),
  // Yesterday, so the date grouping has two headings to prove rather than one.
  conversation({ id: 2, title: "Supplies last month", lastMessageAt: iso(DAY) }),
];

const DETAIL: Record<number, ChatMessage[]> = {
  1: [message(11, "user", "Why did rent go up?"), message(12, "assistant", "Rent rose by 8%.")],
  2: [message(21, "user", "Supplies last month?"), message(22, "assistant", "Supplies were 12,400.")],
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  del.mockReset();
  confirmSpy.mockClear();
  confirmResult = true;

  get.mockImplementation(async (url: string) => {
    if (url === "/ai/conversations") return { data: LIST };
    const id = Number(url.split("/").pop());
    return { data: { ...conversation({ id }), messages: DETAIL[id] ?? [] } };
  });

  post.mockImplementation(async (_url: string, body: { question: string }) => ({
    data: {
      conversation: conversation({ id: 99, title: body.question }),
      userMessage: message(101, "user", body.question),
      assistantMessage: message(102, "assistant", "Here is what I found."),
      provider: "gemini",
      detectedAmount: null,
    },
  }));

  patch.mockResolvedValue({ data: {} });
  del.mockResolvedValue({ data: {} });
});

/**
 * Two real routes under one provider — the same shape AuthenticatedLayout
 * mounts. Navigation has to be real here: "the thread survived a route change"
 * is not something a single-page render can prove.
 */
const reductionOpportunity: ReductionOpportunity = {
  id: "opp-1",
  type: "CATEGORY_PRESSURE",
  categoryId: 3,
  categoryName: "Office Supplies",
  priority: "high",
  confidence: "strong",
  observation: "Office Supplies made up a large share of expenses this period.",
  rationale: "Office Supplies crossed the high-share threshold this period.",
  evidence: {
    currentAmount: 7654,
    previousAmount: 5000,
    changeAmount: 2654,
    changePercent: 53.1,
    expenseSharePercent: 22.5,
    recordCount: 4,
    unusualRecordCount: 0,
    possibleDuplicateCount: 0,
  },
  costBehavior: "unclassified",
  suggestedChecks: ["Review the records contributing most to this category."],
  relatedRecordIds: [101, 102],
  limitations: [],
};

function Page({ name, module }: { name: string; module: InteractionModule }) {
  const ask = useAskFinSight(module);
  return (
    <main>
      <h1>{name}</h1>
      <button type="button" onClick={() => ask()}>
        Ask FinSight from {name}
      </button>
      <button type="button" onClick={() => ask("Why did Supplies rise 32%?")}>
        Explain this from {name}
      </button>
      <button
        type="button"
        onClick={() =>
          ask("Why was this reduction opportunity selected, and what should I check first?", reductionOpportunity)
        }
      >
        Ask about opportunity from {name}
      </button>
      <Link to={name === "Dashboard" ? "/records" : "/dashboard"}>Go elsewhere</Link>
    </main>
  );
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <ToastProvider>
        <AiChatProvider>
          <Routes>
            <Route path="/dashboard" element={<Page name="Dashboard" module="Dashboard" />} />
            <Route path="/records" element={<Page name="Records" module="Expense Insights" />} />
          </Routes>
          <AskFinSightDrawer />
        </AiChatProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** The panel itself. It stays mounted when closed, so "closed" is `inert`. */
const drawer = () => screen.getByRole("dialog", { name: "Ask FinSight" });
const isOpen = () => !drawer().hasAttribute("inert");

const box = () => screen.getByLabelText("Ask about your numbers");
const historyToggle = () => screen.getByRole("button", { name: "Chat history" });

async function open(from = "Dashboard") {
  await userEvent.click(screen.getByRole("button", { name: `Ask FinSight from ${from}` }));
}

async function openHistory() {
  await userEvent.click(historyToggle());
}

describe("the drawer's open flag is not a conversation lifecycle", () => {
  it("starts closed, parked out of the tab order rather than unmounted", () => {
    renderApp();
    expect(isOpen()).toBe(false);
    // Nothing is fetched for a panel nobody has opened.
    expect(get).not.toHaveBeenCalled();
  });

  it("opening and closing writes nothing and refetches nothing", async () => {
    renderApp();
    await open();
    expect(isOpen()).toBe(true);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/ai/conversations", expect.anything()));

    await userEvent.click(screen.getByRole("button", { name: "Close Ask FinSight" }));
    expect(isOpen()).toBe(false);

    await open();
    expect(isOpen()).toBe(true);

    // One list fetch across two opens: the guard is on having fetched, not on
    // the drawer being shut.
    expect(get.mock.calls.filter((c) => c[0] === "/ai/conversations")).toHaveLength(1);
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps the conversation and its messages across close, navigate and reopen", async () => {
    renderApp();
    await open();
    await openHistory();
    await userEvent.click(await screen.findByRole("button", { name: "Why did rent go up?" }));
    await screen.findByText("Rent rose by 8%.");
    const fetches = get.mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "Close Ask FinSight" }));
    // A different page entirely, with its own module.
    await userEvent.click(screen.getByRole("link", { name: "Go elsewhere" }));
    await screen.findByRole("heading", { name: "Records" });

    await open("Records");
    expect(isOpen()).toBe(true);
    // The SAME conversation, with the same messages and the same title — not a
    // fresh thread, and not a reload of the one that was already there.
    expect(screen.getByText("Rent rose by 8%.")).toBeInTheDocument();
    expect(within(drawer()).getByRole("heading", { name: "Why did rent go up?" })).toBeInTheDocument();
    expect(get.mock.calls).toHaveLength(fetches);
    expect(post).not.toHaveBeenCalled();
  });

  it("continues the same conversation after a route change instead of creating a second", async () => {
    renderApp();
    await open();
    await openHistory();
    await userEvent.click(await screen.findByRole("button", { name: "Why did rent go up?" }));
    await screen.findByText("Rent rose by 8%.");

    await userEvent.click(screen.getByRole("link", { name: "Go elsewhere" }));
    await screen.findByRole("heading", { name: "Records" });

    await userEvent.type(box(), "By how much?");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("Here is what I found.");
    expect(post).toHaveBeenCalledWith("/ai/conversations/1/messages", {
      businessProfileId: 7,
      question: "By how much?",
    });
  });
});

describe("lazy conversation creation", () => {
  it("writes nothing when a new chat is opened and abandoned", async () => {
    renderApp();
    await open();
    await openHistory();
    await screen.findByRole("button", { name: "Why did rent go up?" });
    await userEvent.click(historyToggle());

    await userEvent.click(screen.getByRole("button", { name: "New chat" }));

    // The whole point: an abandoned empty chat leaves no trace, so nothing was
    // posted and the history list grew no row.
    expect(post).not.toHaveBeenCalled();
    await openHistory();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("creates the conversation on the first send, and prepends it to the history", async () => {
    renderApp();
    await open();

    await userEvent.type(box(), "What can I cut?");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("Here is what I found.");
    expect(post).toHaveBeenCalledWith("/ai/conversations", {
      businessProfileId: 7,
      originModule: "Dashboard",
      question: "What can I cut?",
    });

    await openHistory();
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("What can I cut?");
  });

  it("sends the originModule of the screen the owner opened it from", async () => {
    renderApp();
    await userEvent.click(screen.getByRole("link", { name: "Go elsewhere" }));
    await screen.findByRole("heading", { name: "Records" });
    await open("Records");

    await userEvent.type(box(), "Why did my expenses increase?");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/ai/conversations",
        expect.objectContaining({ originModule: "Expense Insights" }),
      ),
    );
  });
});

describe("the selected reduction opportunity handed over with a primed question", () => {
  it("posts the selected opportunity's structured fields alongside the first send that uses it", async () => {
    renderApp();
    await userEvent.click(screen.getByRole("button", { name: "Ask about opportunity from Dashboard" }));

    expect(box()).toHaveValue("Why was this reduction opportunity selected, and what should I check first?");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("Here is what I found.");
    expect(post).toHaveBeenCalledWith("/ai/conversations", {
      businessProfileId: 7,
      originModule: "Dashboard",
      question: "Why was this reduction opportunity selected, and what should I check first?",
      reductionOpportunity,
    });
  });

  it("does not resend the reduction opportunity on a second message in the same conversation", async () => {
    renderApp();
    await userEvent.click(screen.getByRole("button", { name: "Ask about opportunity from Dashboard" }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Here is what I found.");
    post.mockClear();

    await userEvent.type(box(), "And what about last month?");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, body] = post.mock.calls[0];
    expect(body).not.toHaveProperty("reductionOpportunity");
  });
});

describe("the history overlay", () => {
  it("is hidden until asked for, and reports that in aria-expanded", async () => {
    renderApp();
    await open();
    expect(historyToggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "Chat history" })).not.toBeInTheDocument();

    await openHistory();
    expect(historyToggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { name: "Chat history" })).toBeInTheDocument();
  });

  it("groups the list by date", async () => {
    renderApp();
    await open();
    await openHistory();

    await screen.findByRole("button", { name: "Why did rent go up?" });
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
  });

  it("loads the chosen conversation and gives the width back to the messages", async () => {
    renderApp();
    await open();
    await openHistory();
    await userEvent.click(await screen.findByRole("button", { name: "Supplies last month" }));

    expect(await screen.findByText("Supplies were 12,400.")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/ai/conversations/2");
    // The list stood down on its own once it had done its job.
    expect(historyToggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "Chat history" })).not.toBeInTheDocument();
  });

  it("serves an already-read conversation from cache, so going back is instant and silent", async () => {
    renderApp();
    await open();
    await openHistory();
    await userEvent.click(await screen.findByRole("button", { name: "Why did rent go up?" }));
    await screen.findByText("Rent rose by 8%.");

    await openHistory();
    await userEvent.click(screen.getByRole("button", { name: "Supplies last month" }));
    await screen.findByText("Supplies were 12,400.");

    await openHistory();
    await userEvent.click(screen.getByRole("button", { name: "Why did rent go up?" }));
    expect(screen.getByText("Rent rose by 8%.")).toBeInTheDocument();

    // One fetch per conversation — the third choice added none.
    expect(get.mock.calls.filter((c) => String(c[0]).startsWith("/ai/conversations/"))).toHaveLength(2);
  });

  it("closes back to the conversation on Escape rather than closing the drawer", async () => {
    renderApp();
    await open();
    await openHistory();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("heading", { name: "Chat history" })).not.toBeInTheDocument();
    expect(isOpen()).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(isOpen()).toBe(false);
  });
});

describe("renaming and deleting", () => {
  async function openMenuFor(title: string) {
    renderApp();
    await open();
    await openHistory();
    const row = await screen.findByRole("button", { name: title });
    await userEvent.click(within(row.closest("li")!).getByRole("button", { name: new RegExp(`More options for`) }));
  }

  it("renames a conversation in place and updates the list", async () => {
    await openMenuFor("Why did rent go up?");
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    const input = screen.getByLabelText("Rename conversation");
    await userEvent.clear(input);
    await userEvent.type(input, "Rent{Enter}");

    expect(patch).toHaveBeenCalledWith("/ai/conversations/1", { title: "Rent" });
    expect(await screen.findByRole("button", { name: "Rent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Why did rent go up?" })).not.toBeInTheDocument();
  });

  it("keeps the old title when the box is emptied rather than blanking the row", async () => {
    await openMenuFor("Why did rent go up?");
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    await userEvent.clear(screen.getByLabelText("Rename conversation"));
    await userEvent.type(screen.getByLabelText("Rename conversation"), "{Enter}");

    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Why did rent go up?" })).toBeInTheDocument();
  });

  it("confirms before deleting, then drops the row and says so", async () => {
    await openMenuFor("Why did rent go up?");
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    // The shared ConfirmDialog, with the verb restated — never a native
    // confirm(), and never an unguarded delete.
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.objectContaining({ confirmLabel: "Delete conversation", tone: "danger" }),
    );
    await waitFor(() => expect(del).toHaveBeenCalledWith("/ai/conversations/1"));
    expect(screen.queryByRole("button", { name: "Why did rent go up?" })).not.toBeInTheDocument();
    expect(await screen.findByText("Conversation deleted")).toBeInTheDocument();
  });

  it("deletes nothing when the confirmation is declined", async () => {
    confirmResult = false;
    await openMenuFor("Why did rent go up?");
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Why did rent go up?" })).toBeInTheDocument();
  });
});

describe("what the drawer has always had to say", () => {
  it("opens with the full mascot scene and gives replies the small avatar", async () => {
    // Fin's two appearances come from two crops of the same art, and swapping
    // them is wrong in both places — the full scene is unreadable at 24px and
    // the bare head wastes the opening moment.
    renderApp();
    await open();
    // The panel portals to <body>, so the render container is not where its
    // markup lands.
    const intro = drawer().querySelector('img[src="/mascot/ask-fin.webp"]');
    expect(intro).toHaveAttribute("width", "104");
    expect(intro).toHaveAttribute("height", "83");

    await openHistory();
    await userEvent.click(await screen.findByRole("button", { name: "Why did rent go up?" }));
    await screen.findByText("Rent rose by 8%.");

    // One reply, one small avatar — and the full scene has gone, so Fin is
    // never on screen twice saying the same thing.
    expect(drawer().querySelectorAll('img[src="/mascot/ask-fin-avatar.webp"]')).toHaveLength(1);
    expect(drawer().querySelectorAll('img[src="/mascot/ask-fin.webp"]')).toHaveLength(0);
  });

  it("shows the greeting of the module it was opened from", async () => {
    renderApp();
    await userEvent.click(screen.getByRole("link", { name: "Go elsewhere" }));
    await screen.findByRole("heading", { name: "Records" });
    await open("Records");

    expect(screen.getByText(/I can help you understand your expense behaviour/i)).toBeInTheDocument();
  });

  it("primes the box from a starter chip without asking anything", async () => {
    renderApp();
    await open();
    await userEvent.click(screen.getByRole("button", { name: "What needs my attention?" }));

    expect(box()).toHaveValue("What needs my attention?");
    expect(post).not.toHaveBeenCalled();
  });

  it("primes the box from the question the card handed over, and sends nothing", async () => {
    renderApp();
    await userEvent.click(screen.getByRole("button", { name: "Explain this from Dashboard" }));

    expect(isOpen()).toBe(true);
    expect(box()).toHaveValue("Why did Supplies rise 32%?");
    expect(post).not.toHaveBeenCalled();
  });

  it("calls a placeholder answer what it is when both providers are down", async () => {
    post.mockResolvedValueOnce({
      data: {
        conversation: conversation({ id: 99, title: "Anything" }),
        userMessage: message(101, "user", "Anything"),
        assistantMessage: message(102, "assistant", "I can't answer right now."),
        provider: "unavailable",
        detectedAmount: null,
      },
    });

    renderApp();
    await open();
    await userEvent.type(box(), "Anything");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/unreachable right now/i)).toBeInTheDocument();
  });

  it("discloses the amount the server read out of a plainly-worded question", async () => {
    post.mockResolvedValueOnce({
      data: {
        conversation: conversation({ id: 99, title: "Fridge" }),
        userMessage: message(101, "user", "What if I spend 11,000 on a fridge?"),
        assistantMessage: message(102, "assistant", "That is 22% of your funds."),
        provider: "gemini",
        detectedAmount: 11000,
      },
    });

    renderApp();
    await open();
    await userEvent.type(box(), "fridge");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/read/i)).toHaveTextContent("PHP 11,000");
  });
});
