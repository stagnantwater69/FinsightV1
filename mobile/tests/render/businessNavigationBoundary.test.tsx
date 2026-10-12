import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';

import * as fixtures from './support/fixtures';
import type { ChatStore } from '../../src/lib/chatStore';
import type { BusinessProfile, ChatSendResponse, Conversation } from '../../src/lib/types';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
const apiDelete = vi.fn();
const businessA = fixtures.businessProfile;
const businessB = { ...fixtures.businessProfile, id: 2, name: 'Second business' } as BusinessProfile;
let currentBusinessProfile: BusinessProfile = businessA;
let exposedChat: ChatStore | null = null;

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
  },
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : 'Something went wrong.',
  ApiError: class ApiError extends Error {},
}));

vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({
    profiles: [businessA, businessB],
    selected: currentBusinessProfile,
    categories: fixtures.categories,
    loading: false,
    error: null,
  }),
}));

const { BusinessNavigationBoundary } = await import(
  '../../src/components/BusinessNavigationBoundary'
);
const { AiChatProvider, useAiChat } = await import('../../src/context/AiChatContext');

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Count ${count}`} onPress={() => setCount((n) => n + 1)}>
      <Text>{count}</Text>
    </Pressable>
  );
}

function ChatProbe() {
  const chat = useAiChat();
  exposedChat = chat;
  return (
    <>
      <Text>{chat.input ? `Draft: ${chat.input}` : 'No draft'}</Text>
      <Text>{chat.conversations.length ? chat.conversations.map((item) => item.title).join(', ') : 'No conversations'}</Text>
      <Text>{chat.messages.length ? chat.messages.map((item) => item.content).join(', ') : 'No messages'}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Write A draft" onPress={() => chat.setInput('Business A draft')}>
        <Text>Write</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Load chats" onPress={() => chat.ensureList()}>
        <Text>Load</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Rename A chat" onPress={() => void chat.rename(17, 'Renamed A chat')}>
        <Text>Rename</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Send A draft" onPress={() => void chat.send(chat.input)}>
        <Text>Send</Text>
      </Pressable>
    </>
  );
}

function boundaryTree(child: React.ReactNode) {
  return (
    <BusinessNavigationBoundary businessProfileId={currentBusinessProfile.id}>
      {child}
    </BusinessNavigationBoundary>
  );
}

const conversationA: Conversation = {
  id: 17,
  title: 'Business A chat',
  originModule: 'Dashboard',
  createdAt: '2026-09-01T00:00:00.000Z',
  lastMessageAt: '2026-09-01T00:00:00.000Z',
};

const sendResponseA: ChatSendResponse = {
  conversation: conversationA,
  userMessage: {
    id: 101,
    role: 'user',
    content: 'Business A draft',
    createdAt: '2026-09-01T00:01:00.000Z',
  },
  assistantMessage: {
    id: 102,
    role: 'assistant',
    content: 'Business A answer',
    createdAt: '2026-09-01T00:01:01.000Z',
  },
  provider: 'gemini',
  detectedAmount: null,
};

beforeEach(() => {
  currentBusinessProfile = businessA;
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiDelete.mockReset();
  exposedChat = null;
});

afterEach(cleanup);

describe('BusinessNavigationBoundary', () => {
  it('preserves child state for the same business and remounts it for a new business', async () => {
    const queries = await render(boundaryTree(<Counter />));
    await fireEvent.press(queries.getByRole('button', { name: 'Count 0' }));
    expect(queries.getByRole('button', { name: 'Count 1' })).toBeTruthy();

    await queries.rerender(boundaryTree(<Counter />));
    expect(queries.getByRole('button', { name: 'Count 1' })).toBeTruthy();

    currentBusinessProfile = businessB;
    await queries.rerender(boundaryTree(<Counter />));
    expect(queries.getByRole('button', { name: 'Count 0' })).toBeTruthy();
  });

  it('starts B with an empty chat even when A has a draft and delayed send and rename completions', async () => {
    let resolveSend: (response: ChatSendResponse) => void = () => {};
    let rejectRename: (reason: Error) => void = () => {};
    const delayedSend = new Promise<ChatSendResponse>((resolve) => {
      resolveSend = resolve;
    });
    const delayedRename = new Promise<void>((_resolve, reject) => {
      rejectRename = reject;
    });
    apiGet.mockResolvedValue([conversationA]);
    apiPost.mockReturnValue(delayedSend);
    apiPatch.mockReturnValue(delayedRename);

    const queries = await render(boundaryTree(
      <AiChatProvider>
        <ChatProbe />
      </AiChatProvider>,
    ));

    await fireEvent.press(queries.getByRole('button', { name: 'Load chats' }));
    expect(await queries.findByText('Business A chat')).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Write A draft' }));
    expect(queries.getByText('Draft: Business A draft')).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Rename A chat' }));
    expect(await queries.findByText('Renamed A chat')).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Send A draft' }));
    const oldChat = exposedChat!;

    currentBusinessProfile = businessB;
    await queries.rerender(boundaryTree(
      <AiChatProvider>
        <ChatProbe />
      </AiChatProvider>,
    ));
    expect(queries.getByText('No draft')).toBeTruthy();
    expect(queries.getByText('No conversations')).toBeTruthy();
    expect(queries.getByText('No messages')).toBeTruthy();

    await act(async () => {
      resolveSend(sendResponseA);
      rejectRename(new Error('Late A rename failure'));
      await Promise.allSettled([delayedSend, delayedRename]);
    });
    await waitFor(() => expect(queries.getByText('No draft')).toBeTruthy());
    expect(queries.getByText('No conversations')).toBeTruthy();
    expect(queries.getByText('No messages')).toBeTruthy();
    expect(queries.queryByText('Business A answer')).toBeNull();
    expect(oldChat.getState()).toMatchObject({
      input: '',
      conversations: [],
      messages: [],
      activeId: null,
      sending: false,
    });
  });

  it('deactivates captured A chat mutations before stale native callbacks can run under B', async () => {
    apiGet.mockResolvedValue([conversationA]);
    const queries = await render(boundaryTree(
      <AiChatProvider>
        <ChatProbe />
      </AiChatProvider>,
    ));
    await fireEvent.press(queries.getByRole('button', { name: 'Load chats' }));
    expect(await queries.findByText('Business A chat')).toBeTruthy();
    const oldChat = exposedChat!;

    currentBusinessProfile = businessB;
    await queries.rerender(boundaryTree(
      <AiChatProvider>
        <ChatProbe />
      </AiChatProvider>,
    ));

    const getCalls = apiGet.mock.calls.length;
    await act(async () => {
      oldChat.setInput('stale A draft');
      oldChat.prepareQuestion('stale A question');
      await oldChat.selectConversation(conversationA.id);
      await oldChat.send('stale A question');
      await oldChat.rename(conversationA.id, 'Stale A rename');
      await oldChat.remove(conversationA.id);
    });

    expect(apiGet).toHaveBeenCalledTimes(getCalls);
    expect(apiPost).not.toHaveBeenCalled();
    expect(apiPatch).not.toHaveBeenCalled();
    expect(apiDelete).not.toHaveBeenCalled();
    expect(oldChat.getState()).toMatchObject({ input: '', conversations: [], messages: [] });
    expect(queries.getByText('No draft')).toBeTruthy();
  });
});
