// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSendResponse, Conversation, ConversationDetail } from "../lib/types";
import { BusinessOwnedBoundary } from "../components/BusinessOwnedBoundary";
import { AiChatProvider, useAiChat } from "./AiChatContext";

const profileA = { id: 1, name: "First store" };
const profileB = { id: 2, name: "Second store" };
let selectedProfile = profileA;

vi.mock("./BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: selectedProfile }),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

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

let confirmRequest: Deferred<boolean>;
vi.mock("../components/ConfirmDialog", () => ({
  useConfirm: () => () => confirmRequest.promise,
}));
vi.mock("../components/Toast", () => ({ useToast: () => vi.fn() }));

function conversation(businessProfileId: number): Conversation {
  return {
    id: businessProfileId,
    title: businessProfileId === profileA.id ? "First store chat" : "Second store chat",
    originModule: "Dashboard",
    createdAt: "2026-09-01T00:00:00.000Z",
    lastMessageAt: "2026-09-01T00:00:00.000Z",
  };
}

function message(id: number, content: string): ChatMessage {
  return { id, role: "assistant", content, createdAt: "2026-09-01T00:00:00.000Z" };
}

function Probe() {
  const chat = useAiChat();
  const first = chat.conversations[0];
  return (
    <div>
      <button type="button" onClick={() => chat.openChat("Dashboard")}>Open chat</button>
      <input
        aria-label="Chat draft"
        value={chat.input}
        onChange={(event) => chat.setInput(event.target.value)}
      />
      <button type="button" onClick={() => chat.send(chat.input)}>Send draft</button>
      <button type="button" disabled={!first} onClick={() => first && chat.selectConversation(first.id)}>
        Select first
      </button>
      <button type="button" disabled={!first} onClick={() => first && chat.rename(first.id, "Renamed chat")}>
        Rename first
      </button>
      <button type="button" disabled={!first} onClick={() => first && chat.remove(first)}>
        Delete first
      </button>
      <output data-testid="conversation-titles">{chat.conversations.map((item) => item.title).join("|")}</output>
      <output data-testid="messages">{chat.messages.map((item) => item.content).join("|")}</output>
    </div>
  );
}

const tree = () => (
  <BusinessOwnedBoundary>
    <AiChatProvider>
      <Probe />
    </AiChatProvider>
  </BusinessOwnedBoundary>
);

beforeEach(() => {
  selectedProfile = profileA;
  confirmRequest = deferred<boolean>();
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  del.mockReset();
  get.mockImplementation(async (url: string, config?: { params?: { businessProfileId?: number } }) => {
    if (url === "/ai/conversations") {
      const id = config?.params?.businessProfileId ?? selectedProfile.id;
      return { data: [conversation(id)] };
    }
    const id = Number(url.split("/").pop());
    const detail: ConversationDetail = { ...conversation(id), messages: [message(id * 10, `Detail ${id}`)] };
    return { data: detail };
  });
  post.mockResolvedValue({ data: {} });
  patch.mockResolvedValue({ data: {} });
  del.mockResolvedValue({ data: {} });
});

describe("business-scoped Ask FinSight state", () => {
  it("drops an old draft and delayed conversation selection on a business switch", async () => {
    const detail = deferred<{ data: ConversationDetail }>();
    get.mockImplementation((url: string, config?: { params?: { businessProfileId?: number } }) => {
      if (url === "/ai/conversations") {
        const id = config?.params?.businessProfileId ?? selectedProfile.id;
        return Promise.resolve({ data: [conversation(id)] });
      }
      return detail.promise;
    });
    const { rerender } = render(tree());
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    await waitFor(() => expect(screen.getByTestId("conversation-titles")).toHaveTextContent("First store chat"));
    await userEvent.type(screen.getByLabelText("Chat draft"), "private first-store draft");
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));

    selectedProfile = profileB;
    rerender(tree());
    expect(screen.getByLabelText("Chat draft")).toHaveValue("");
    expect(screen.getByTestId("messages")).toHaveTextContent("");
    expect(screen.getByTestId("conversation-titles")).toHaveTextContent("");

    await act(async () => {
      detail.resolve({ data: { ...conversation(1), messages: [message(10, "Late first-store detail")] } });
      await detail.promise;
    });
    expect(screen.getByTestId("messages")).not.toHaveTextContent("Late first-store detail");
  });

  it("ignores a delayed send and rename result from the previous business", async () => {
    const sendRequest = deferred<{ data: ChatSendResponse }>();
    const renameRequest = deferred<{ data: unknown }>();
    post.mockReturnValue(sendRequest.promise);
    patch.mockReturnValue(renameRequest.promise);
    const { rerender } = render(tree());
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    await waitFor(() => expect(screen.getByTestId("conversation-titles")).toHaveTextContent("First store chat"));

    await userEvent.type(screen.getByLabelText("Chat draft"), "Question for A");
    fireEvent.click(screen.getByRole("button", { name: "Send draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename first" }));
    expect(screen.getByTestId("conversation-titles")).toHaveTextContent("Renamed chat");

    selectedProfile = profileB;
    rerender(tree());
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    await waitFor(() => expect(screen.getByTestId("conversation-titles")).toHaveTextContent("Second store chat"));

    await act(async () => {
      sendRequest.resolve({
        data: {
          conversation: conversation(1),
          userMessage: { ...message(101, "Question for A"), role: "user" },
          assistantMessage: message(102, "Late answer for A"),
          provider: "gemini",
          detectedAmount: null,
        },
      });
      renameRequest.reject(new Error("Rename failed"));
      await Promise.allSettled([sendRequest.promise, renameRequest.promise]);
    });

    expect(screen.getByTestId("conversation-titles")).toHaveTextContent("Second store chat");
    expect(screen.getByTestId("conversation-titles")).not.toHaveTextContent("First store chat");
    expect(screen.getByTestId("messages")).not.toHaveTextContent("Late answer for A");
  });

  it("does not delete an old business conversation after its confirmation resolves", async () => {
    const { rerender } = render(tree());
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    await waitFor(() => expect(screen.getByTestId("conversation-titles")).toHaveTextContent("First store chat"));
    fireEvent.click(screen.getByRole("button", { name: "Delete first" }));

    selectedProfile = profileB;
    rerender(tree());
    await act(async () => {
      confirmRequest.resolve(true);
      await confirmRequest.promise;
    });

    expect(del).not.toHaveBeenCalled();
  });
});
