// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AiChat } from "./AiChat";
import { ToastProvider } from "../components/Toast";
import type { ChatMessage, Conversation } from "../lib/types";

/**
 * WHAT THIS FILE GUARDS.
 *
 * Three of these are the reasons the page exists at all, and all three were
 * broken in the drawer this replaced:
 *
 *   1. LAZY CREATION — opening a blank chat and walking away must leave no
 *      record. The drawer had no records to leave; a page with a New Chat
 *      button that writes one on click would fill the rail with empty threads
 *      nobody asked for.
 *   2. SIDEBAR/CHAT INDEPENDENCE — the drawer's open flag WAS its conversation
 *      lifecycle, so closing it wiped the thread. Collapsing the history rail
 *      must not touch the conversation, the messages, or the network.
 *   3. SWITCHING — a conversation already read comes back from the in-page
 *      cache, instantly and without a second fetch.
 *
 * It also carries over the coverage the deleted AskFinSightDrawer.test.tsx
 * held: the unavailable banner, the starter chips priming (never sending) the
 * box, and Fin's two sizes not being crossed over.
 */

// jsdom implements no scrolling, and the message list pins itself to the
// newest message on every render. Not a stub of anything under test.
Element.prototype.scrollTo = () => {};

const profile = { id: 7, name: "Sari-sari" };

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));

let confirmResult = true;
const confirmSpy = vi.fn(async () => confirmResult);
vi.mock("../components/ConfirmDialog", () => ({
  // The real ConfirmProvider drives a <dialog>, which jsdom does not
  // implement. What matters here is that deletion goes THROUGH the shared
  // confirm rather than round a native confirm() or no gate at all, so the
  // spy asserts the options it was handed.
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

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 1,
    title: "Why did rent go up?",
    originModule: "Dashboard",
    createdAt: "2026-08-23T09:00:00.000Z",
    lastMessageAt: "2026-08-23T09:00:00.000Z",
    ...over,
  };
}

function message(id: number, role: ChatMessage["role"], content: string): ChatMessage {
  return { id, role, content, createdAt: "2026-08-23T09:00:00.000Z" };
}

const LIST = [
  conversation({ id: 1, title: "Why did rent go up?" }),
  conversation({ id: 2, title: "Supplies last month", lastMessageAt: "2026-08-22T09:00:00.000Z" }),
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
  localStorage.clear();

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

function renderPage(state?: { originModule: string; initialQuestion?: string }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/ai-chat", state }]}>
      <ToastProvider>
        <AiChat />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** The rail renders two controls with this name — one per breakpoint, each
 *  display:none in the other. Either one drives the same state. */
function railToggle(name: string) {
  return screen.getAllByRole("button", { name })[0]!;
}

describe("lazy conversation creation", () => {
  it("writes nothing when a new chat is opened and abandoned", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Why did rent go up?" });

    await userEvent.click(screen.getByRole("button", { name: "New chat" }));

    // The whole point: an abandoned empty chat leaves no trace, so nothing
    // was posted and the rail grew no row.
    expect(post).not.toHaveBeenCalled();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("creates the conversation on the first send, and prepends it to the rail", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Why did rent go up?" });

    await userEvent.type(screen.getByLabelText("Ask about your numbers"), "What can I cut?");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("Here is what I found.");
    expect(post).toHaveBeenCalledWith("/ai/conversations", {
      businessProfileId: 7,
      originModule: "Dashboard",
      question: "What can I cut?",
    });
    expect(screen.getByRole("button", { name: "What can I cut?" })).toBeInTheDocument();
  });

  it("continues an existing conversation on its own route instead of creating a second", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Why did rent go up?" }));
    await screen.findByText("Rent rose by 8%.");

    await userEvent.type(screen.getByLabelText("Ask about your numbers"), "By how much?");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("Here is what I found.");
    expect(post).toHaveBeenCalledWith("/ai/conversations/1/messages", {
      businessProfileId: 7,
      question: "By how much?",
    });
    // The earlier turn is still above the new one — a continued thread, not a
    // replaced one.
    expect(screen.getByText("Rent rose by 8%.")).toBeInTheDocument();
  });

  it("sends the originModule the owner arrived with, not the default", async () => {
    renderPage({ originModule: "Records Review" });
    await screen.findByRole("button", { name: "Why did rent go up?" });

    await userEvent.type(screen.getByLabelText("Ask about your numbers"), "Why was this flagged?");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/ai/conversations", expect.objectContaining({ originModule: "Records Review" })),
    );
  });
});

describe("switching conversations", () => {
  it("loads a conversation's messages without changing the route", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Supplies last month" }));

    expect(await screen.findByText("Supplies were 12,400.")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/ai/conversations/2");
  });

  it("serves an already-read conversation from cache, so switching back is instant and silent", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Why did rent go up?" }));
    await screen.findByText("Rent rose by 8%.");

    await userEvent.click(screen.getByRole("button", { name: "Supplies last month" }));
    await screen.findByText("Supplies were 12,400.");

    await userEvent.click(screen.getByRole("button", { name: "Why did rent go up?" }));
    expect(screen.getByText("Rent rose by 8%.")).toBeInTheDocument();

    // One list fetch and one fetch per conversation — the third click added
    // none.
    expect(get.mock.calls.filter((c) => String(c[0]).startsWith("/ai/conversations/"))).toHaveLength(2);
  });
});

describe("the rail is independent of the conversation", () => {
  it("collapsing and re-expanding leaves the active conversation and its messages untouched", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Why did rent go up?" }));
    await screen.findByText("Rent rose by 8%.");
    const before = get.mock.calls.length;

    await userEvent.click(railToggle("Collapse chat history"));
    expect(screen.getByText("Rent rose by 8%.")).toBeInTheDocument();

    await userEvent.click(railToggle("Open chat history"));
    expect(screen.getByText("Rent rose by 8%.")).toBeInTheDocument();

    // Not a single request: the rail's flag reaches nothing that fetches.
    expect(get.mock.calls).toHaveLength(before);
    expect(post).not.toHaveBeenCalled();
  });

  it("remembers being collapsed across a remount, without reloading anything", async () => {
    const { unmount } = renderPage();
    await screen.findByRole("button", { name: "Why did rent go up?" });
    await userEvent.click(railToggle("Collapse chat history"));
    unmount();

    renderPage();
    // Persisted, so the expand control is the one on offer.
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Open chat history" }).length).toBeGreaterThan(1));
  });
});

describe("renaming and deleting", () => {
  it("renames a conversation in place and updates the rail", async () => {
    renderPage();
    const row = await screen.findByRole("button", { name: "Why did rent go up?" });

    await userEvent.click(
      within(row.closest("li")!).getByRole("button", { name: /More options for Why did rent go up/ }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    const input = screen.getByLabelText("Rename conversation");
    await userEvent.clear(input);
    await userEvent.type(input, "Rent{Enter}");

    expect(patch).toHaveBeenCalledWith("/ai/conversations/1", { title: "Rent" });
    expect(await screen.findByRole("button", { name: "Rent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Why did rent go up?" })).not.toBeInTheDocument();
  });

  it("keeps the old title when the box is emptied rather than blanking the row", async () => {
    renderPage();
    const row = await screen.findByRole("button", { name: "Why did rent go up?" });

    await userEvent.click(
      within(row.closest("li")!).getByRole("button", { name: /More options for Why did rent go up/ }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    await userEvent.clear(screen.getByLabelText("Rename conversation"));
    await userEvent.type(screen.getByLabelText("Rename conversation"), "{Enter}");

    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Why did rent go up?" })).toBeInTheDocument();
  });

  it("confirms before deleting, then drops the row and says so", async () => {
    renderPage();
    const row = await screen.findByRole("button", { name: "Why did rent go up?" });

    await userEvent.click(
      within(row.closest("li")!).getByRole("button", { name: /More options for Why did rent go up/ }),
    );
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
    renderPage();
    const row = await screen.findByRole("button", { name: "Why did rent go up?" });

    await userEvent.click(
      within(row.closest("li")!).getByRole("button", { name: /More options for Why did rent go up/ }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Why did rent go up?" })).toBeInTheDocument();
  });
});

describe("what the drawer used to cover", () => {
  it("opens with the full mascot scene and gives replies the small avatar", async () => {
    // Fin's two appearances come from two crops of the same art, and swapping
    // them is wrong in both places — the full scene is unreadable at 24px and
    // the bare head wastes the opening moment.
    const { container } = renderPage();
    const intro = container.querySelector('img[src="/mascot/ask-fin.webp"]');
    expect(intro).toHaveAttribute("width", "104");
    expect(intro).toHaveAttribute("height", "83");
    expect(intro).toHaveAttribute("aria-hidden", "true");

    await userEvent.click(await screen.findByRole("button", { name: "Why did rent go up?" }));
    await screen.findByText("Rent rose by 8%.");

    // One reply, one small avatar — and the full scene has gone, so Fin is
    // never on screen twice saying the same thing.
    expect(container.querySelectorAll('img[src="/mascot/ask-fin-avatar.webp"]')).toHaveLength(1);
    expect(container.querySelectorAll('img[src="/mascot/ask-fin.webp"]')).toHaveLength(0);
  });

  it("shows the module's greeting copy beside the mascot", () => {
    renderPage({ originModule: "Expense Insights" });
    expect(screen.getByText(/I can help you understand your expense behaviour/i)).toBeInTheDocument();
  });

  it("primes the box from a starter chip without asking anything", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "What needs my attention?" }));

    expect(screen.getByLabelText("Ask about your numbers")).toHaveValue("What needs my attention?");
    expect(post).not.toHaveBeenCalled();
  });

  it("primes the box from the question the caller navigated with", () => {
    renderPage({ originModule: "Dashboard", initialQuestion: "Why did Supplies rise 32%?" });
    expect(screen.getByLabelText("Ask about your numbers")).toHaveValue("Why did Supplies rise 32%?");
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

    renderPage();
    await userEvent.type(await screen.findByLabelText("Ask about your numbers"), "Anything");
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

    renderPage();
    await userEvent.type(await screen.findByLabelText("Ask about your numbers"), "fridge");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/read/i)).toHaveTextContent("PHP 11,000");
  });
});
