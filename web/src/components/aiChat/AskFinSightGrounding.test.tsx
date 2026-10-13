// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { AiChatProvider } from "../../context/AiChatContext";
import { AskFinSightDrawer } from "../AskFinSightDrawer";
import { useAskFinSight } from "../AskFinSightButton";
import { ToastProvider } from "../Toast";
import { ChatMarkdown } from "./ChatMarkdown";
import type { ChatAnswerMetadata, ChatMessage } from "../../lib/types";

/**
 * What a grounded reply looks like on the web: Markdown rendered as elements
 * (never as HTML), the server's links and actions under it, follow-ups that
 * prime the box, thumbs that save, and "Explain this flag" carrying its
 * finding id so the answer is about that card.
 */

Element.prototype.scrollTo = () => {};

vi.mock("../../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: { id: 7, name: "Kusina" } }),
}));
vi.mock("../ConfirmDialog", () => ({ useConfirm: () => async () => true }));

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const put = vi.fn();
vi.mock("../../lib/api", () => ({
  api: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    patch: (...args: unknown[]) => patch(...args),
    put: (...args: unknown[]) => put(...args),
    delete: vi.fn(),
  },
}));

const METADATA: ChatAnswerMetadata = {
  references: [{ kind: "record", recordType: "expense", id: 343, label: "Frozen fries x5", amount: 550, date: "2022-01-10" }],
  pages: [{ key: "review-queue", label: "Needs review" }],
  actions: [
    { kind: "review-finding", findingId: 51, label: "This is normal for my business", status: "DISMISSED", feedback: "EXPECTED_TRANSACTION" },
  ],
  followUps: ["What is my usual for Raw Materials?"],
  period: "January 2022",
  amountCheck: "trimmed",
};

function reply(content: string, metadata: ChatAnswerMetadata | null = METADATA): ChatMessage {
  return { id: 102, role: "assistant", content, createdAt: new Date().toISOString(), metadata, feedback: null };
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  put.mockReset();
  get.mockResolvedValue({ data: [] });
  patch.mockResolvedValue({ data: {} });
  put.mockResolvedValue({ data: {} });
  post.mockImplementation(async (_url: string, body: { question: string }) => ({
    data: {
      conversation: { id: 9, title: body.question, originModule: "Records Review", createdAt: "", lastMessageAt: "" },
      userMessage: { id: 101, role: "user", content: body.question, createdAt: "" },
      assistantMessage: reply("The **Frozen fries x5** purchase was higher than usual.\n- Usual: PHP 305.14\n- This one: PHP 550.00"),
      provider: "gemini",
      detectedAmount: null,
    },
  }));
});

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function Queue() {
  const ask = useAskFinSight("Records Review");
  return (
    <button type="button" onClick={() => ask('Why did FinSight flag "Unusual Raw Materials expense"?', undefined, { kind: "finding", findingId: 51 })}>
      Explain this flag
    </button>
  );
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/records/flagged"]}>
      <ToastProvider>
        <AiChatProvider>
          <Routes>
            <Route path="*" element={<Queue />} />
          </Routes>
          <Where />
          <AskFinSightDrawer />
        </AiChatProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function askAboutFlag(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Explain this flag" }));
  await user.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Frozen fries x5", { selector: "strong" });
}

describe("ChatMarkdown", () => {
  it("renders bold and lists as elements instead of showing the asterisks", () => {
    const { container } = render(<ChatMarkdown text={"Here's why:\n- **Fries** cost more\n- Wrappers too\n\n1. First\n2. Second"} />);
    expect(container.querySelector("strong")?.textContent).toBe("Fries");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.textContent).not.toContain("**");
  });

  it("never turns model text into markup", () => {
    const { container } = render(<ChatMarkdown text={'<img src=x onerror="alert(1)"> **<b>bold</b>**'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});

describe("a grounded reply in the drawer", () => {
  it("sends the flag the owner pressed Explain on", async () => {
    const user = userEvent.setup();
    renderApp();
    await askAboutFlag(user);
    expect(post).toHaveBeenCalledWith(
      "/ai/conversations",
      expect.objectContaining({ originModule: "Records Review", focus: { kind: "finding", findingId: 51 } }),
    );
  });

  it("links the record and page the server resolved, and closes the drawer on the way", async () => {
    const user = userEvent.setup();
    renderApp();
    await askAboutFlag(user);

    const recordLink = screen.getByRole("link", { name: /Frozen fries x5/ });
    expect(recordLink).toHaveAttribute("href", "/records?highlightRecordId=343");
    expect(screen.getByRole("link", { name: /Open Needs review/ })).toHaveAttribute("href", "/records/flagged");

    await user.click(recordLink);
    expect(screen.getByTestId("where")).toHaveTextContent("/records?highlightRecordId=343");
    expect(screen.getByRole("dialog", { name: "Ask FinSight" })).toHaveAttribute("inert");
  });

  it("says when part of an answer was removed, and which period it covers", async () => {
    const user = userEvent.setup();
    renderApp();
    await askAboutFlag(user);
    expect(screen.getByText(/Based on your records for January 2022\./)).toBeInTheDocument();
    expect(screen.getByText(/Part of this answer was removed/)).toBeInTheDocument();
  });

  it("primes the box with a follow-up rather than sending it", async () => {
    const user = userEvent.setup();
    renderApp();
    await askAboutFlag(user);
    await user.click(screen.getByRole("button", { name: "What is my usual for Raw Materials?" }));
    expect(screen.getByLabelText("Ask about your numbers")).toHaveValue("What is my usual for Raw Materials?");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("runs a review action only when pressed, through the review endpoint", async () => {
    const user = userEvent.setup();
    renderApp();
    await askAboutFlag(user);
    expect(patch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "This is normal for my business" }));
    expect(patch).toHaveBeenCalledWith("/insights/findings/51/review", { status: "DISMISSED", feedback: "EXPECTED_TRANSACTION" });
    expect(await screen.findByText(/This flag has left your review queue/)).toBeInTheDocument();
  });

  it("saves a thumbs rating, and pressing it again clears it", async () => {
    const user = userEvent.setup();
    renderApp();
    await askAboutFlag(user);
    const helpful = screen.getByRole("button", { name: "Helpful" });
    await user.click(helpful);
    expect(put).toHaveBeenLastCalledWith("/ai/conversations/9/messages/102/feedback", { feedback: "up" });
    await waitFor(() => expect(helpful).toHaveAttribute("aria-pressed", "true"));
    await user.click(helpful);
    expect(put).toHaveBeenLastCalledWith("/ai/conversations/9/messages/102/feedback", { feedback: null });
  });
});
