import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { api } from "../lib/api";
import { createChatStore, type ChatState, type ChatStore, type ChatTransport } from "../lib/chatStore";
import { useBusinessProfiles } from "./BusinessProfileContext";
import type { ChatSendResponse, Conversation, ConversationDetail } from "../lib/types";

/**
 * The React wrapper around lib/chatStore.
 *
 * All of the reasoning lives in the store — this file only wires it to the
 * network, to the selected business, and to React's subscription model. Kept
 * deliberately thin: the store is the part that can be tested in this project,
 * because there is no render harness (docs/PROGRESS-REPORT.md) and lib/api
 * reaches react-native through the Supabase client, so nothing that imports it
 * can be loaded by the test runner at all.
 *
 * WHERE IT IS MOUNTED. App.tsx, inside BusinessProfileProvider and ABOVE the
 * tab navigator — so it outlives every screen. That placement is the whole
 * point: a provider mounted inside a screen would take the conversation down
 * with the screen, which is the bug this replaces.
 */

const AiChatContext = createContext<ChatStore | null>(null);

/** JSON over the shared api client. The only place conversation routes are named. */
const transport: ChatTransport = {
  listConversations: (businessProfileId) =>
    api.get<Conversation[]>("/ai/conversations", { businessProfileId, limit: 50 }),
  getConversation: (id) => api.get<ConversationDetail>(`/ai/conversations/${id}`),
  createConversation: (input) => api.post<ChatSendResponse>("/ai/conversations", input),
  // Only the question, almost always: the server rebuilds the context from
  // fresh data on every message. See the store's header — `reductionOpportunity`
  // is the one deliberate exception, and it is left `undefined` here on every
  // path that does not queue one — matching `appendMessageSchema` in
  // backend/src/controllers/ai.controller.ts field-for-field.
  sendMessage: (conversationId, question, reductionOpportunity) =>
    api.post<ChatSendResponse>(`/ai/conversations/${conversationId}/messages`, {
      question,
      reductionOpportunity,
    }),
  renameConversation: async (conversationId, title) => {
    await api.patch(`/ai/conversations/${conversationId}`, { title });
  },
  deleteConversation: async (conversationId) => {
    await api.delete(`/ai/conversations/${conversationId}`);
  },
};

export function AiChatProvider({ children }: { children: ReactNode }) {
  const { selected } = useBusinessProfiles();
  // Created once for the life of the provider. A store rebuilt on any render
  // would be a conversation lost on any render.
  const storeRef = useRef<ChatStore | null>(null);
  if (!storeRef.current) storeRef.current = createChatStore(transport);
  const store = storeRef.current;

  /*
   * Keyed on the id rather than the object: BusinessProfileContext hands back
   * a new object identity on every refresh, and depending on that would clear
   * the open conversation each time one landed.
   */
  const businessProfileId = selected?.id ?? null;
  useEffect(() => {
    store.setBusinessProfile(businessProfileId);
  }, [store, businessProfileId]);

  return <AiChatContext.Provider value={store}>{children}</AiChatContext.Provider>;
}

/**
 * The live state plus the store's actions.
 *
 * `useSyncExternalStore` rather than putting the state in context state: the
 * store is the source of truth and React is only reading it, which is exactly
 * what this hook is for — and it keeps the tearing rules React's own, rather
 * than something this file invents.
 */
export function useAiChat(): ChatState & ChatStore {
  const store = useContext(AiChatContext);
  if (!store) throw new Error("useAiChat must be used inside <AiChatProvider>");
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return useMemo(() => ({ ...state, ...store }), [state, store]);
}
