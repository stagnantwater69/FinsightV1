import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { BusinessProfile, ChatSendResponse, InteractionModule } from '../../src/lib/types';
import type { ChatStore } from '../../src/lib/chatStore';
import * as fixtures from './support/fixtures';
import { chatConversation, chatMetadata, chatResponse, deferred } from './support/chatFixtures';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPut = vi.fn();
const apiPatch = vi.fn();
const apiDelete = vi.fn();
const navigate = vi.fn();
const onClose = vi.fn();
let selected: BusinessProfile | null = fixtures.businessProfile;

vi.mock('../../src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
    put: (...args: unknown[]) => apiPut(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
  },
  errorMessage: (error: unknown) => error instanceof Error ? error.message : 'Request failed.',
}));
vi.mock('../../src/context/BusinessProfileContext', () => ({
  useBusinessProfiles: () => ({ selected, profiles: selected ? [selected] : [], categories: fixtures.categories }),
}));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate }) }));
vi.mock('../../src/lib/useReducedMotion', () => ({ useReducedMotion: () => true }));

const { AskFinSight } = await import('../../src/components/AskFinSight');
const { AiChatProvider, useAiChat } = await import('../../src/context/AiChatContext');
const { ThemeProvider, useThemeControl } = await import('../../src/context/ThemeContext');
let setTheme: (mode: 'light' | 'dark') => void;
let exposedChat: ChatStore;

function ThemeProbe() {
  setTheme = useThemeControl().setMode;
  return null;
}

function ChatProbe() {
  exposedChat = useAiChat();
  return null;
}

function tree(module: InteractionModule = 'Expense Insights', visible = true) {
  return <ThemeProvider initialMode="light">
    <ThemeProbe />
    <AiChatProvider><ChatProbe /><AskFinSight visible={visible} onClose={onClose} module={module} /></AiChatProvider>
  </ThemeProvider>;
}

async function ask(queries: Awaited<ReturnType<typeof render>>, question = 'Which category is highest?') {
  await fireEvent.changeText(queries.getByLabelText('Ask about your business'), question);
  await fireEvent.press(queries.getByRole('button', { name: 'Send' }));
}

function mockMissingSendStatus() {
  apiGet.mockImplementation((path: string) => path.startsWith('/ai/send-requests/')
    ? Promise.reject(Object.assign(new Error('Send request not found'), { status: 404 }))
    : Promise.resolve([]));
}

beforeEach(() => {
  selected = fixtures.businessProfile;
  for (const spy of [apiGet, apiPost, apiPut, apiPatch, apiDelete, navigate, onClose]) spy.mockReset();
  apiGet.mockResolvedValue([]);
  apiPost.mockImplementation((_path: string, body: { question: string }) => {
    const response = chatResponse(body.question);
    const offset = (apiPost.mock.calls.length - 1) * 2;
    return Promise.resolve({
      ...response,
      userMessage: { ...response.userMessage, id: 101 + offset },
      assistantMessage: { ...response.assistantMessage, id: 102 + offset },
    });
  });
  apiPut.mockResolvedValue(undefined);
});
afterEach(async () => { await cleanup(); vi.restoreAllMocks(); });

describe('Ask FinSight native chat interactions', () => {
  it('shows the selected business and module, and fills starter questions without sending', async () => {
    const queries = await render(tree());
    expect(queries.getByText(fixtures.businessProfile.name)).toBeTruthy();
    expect(queries.getAllByText(/Expense Insights/).length).toBeGreaterThan(0);
    expect(queries.queryByText(/Sample Sari-Sari|October 2026|demo/i)).toBeNull();
    await fireEvent.press(queries.getByRole('button', { name: 'Use this question: Which category is highest?' }));
    expect(queries.getByLabelText('Ask about your business').props.value).toBe('Which category is highest?');
    expect(apiPost).not.toHaveBeenCalled();
    await fireEvent.press(queries.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledExactlyOnceWith('/ai/conversations', expect.objectContaining({
      businessProfileId: fixtures.businessProfile.id, originModule: 'Expense Insights', question: 'Which category is highest?',
    })));
    expect(await queries.findByText(/Stock is your largest recorded expense/)).toBeTruthy();
  });

  it('keeps an existing thread origin and draft across close, reopen and theme changes', async () => {
    const queries = await render(tree());
    await ask(queries);
    await queries.findByText(/Stock is your largest recorded expense/);
    await fireEvent.changeText(queries.getByLabelText('Ask about your business'), 'A later question I have not sent');
    await act(async () => { setTheme('dark'); });
    expect(queries.getByLabelText('Ask about your business').props.value).toBe('A later question I have not sent');
    await queries.rerender(tree('Dashboard', false));
    await queries.rerender(tree('Dashboard', true));
    expect(queries.getAllByText(/Expense Insights/).length).toBeGreaterThan(0);
    expect(queries.getByLabelText('Ask about your business').props.value).toBe('A later question I have not sent');
    expect(queries.getByText(/Stock is your largest recorded expense/)).toBeTruthy();
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiGet.mock.calls.filter(([path]) => path === '/ai/conversations')).toHaveLength(1);
  });

  it('keeps a selected starter module with an edited draft when reopening from another screen', async () => {
    const queries = await render(tree());
    await fireEvent.press(queries.getByRole('button', { name: 'Use this question: What if I spend ₱11,000 on a fridge?' }));
    await fireEvent.changeText(queries.getByLabelText('Ask about your business'), 'What if I spend 12000 on a freezer?');
    await queries.rerender(tree('Dashboard', false));
    await queries.rerender(tree('Dashboard', true));
    expect(queries.getByLabelText('Ask about your business').props.value).toBe('What if I spend 12000 on a freezer?');
    expect(apiPost).not.toHaveBeenCalled();
    await fireEvent.press(queries.getByRole('button', { name: 'Send' }));
    expect(apiPost.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      businessProfileId: fixtures.businessProfile.id,
      originModule: 'Spending Impact',
      question: 'What if I spend 12000 on a freezer?',
    }));
  });

  it('clears replaced finding context when a different starter is explicitly selected', async () => {
    const queries = await render(tree());
    await act(async () => { exposedChat.prepareQuestion('Explain this finding', undefined, { kind: 'finding', findingId: 51 }); });
    await fireEvent.press(queries.getByRole('button', { name: 'Use this question: Which category is highest?' }));
    expect(exposedChat.getState().pendingFocus).toBeNull();
    expect(apiPost).not.toHaveBeenCalled();
    await fireEvent.press(queries.getByRole('button', { name: 'Send' }));
    expect(apiPost.mock.calls[0]?.[1].question).toBe('Which category is highest?');
    expect(apiPost.mock.calls[0]?.[1]).not.toHaveProperty('focus');
  });

  it('fills follow-up questions without sending and saves explicit feedback', async () => {
    const queries = await render(tree());
    await ask(queries);
    const question = chatMetadata.followUps[0]!;
    await fireEvent.press(await queries.findByRole('button', { name: `Use this question: ${question}` }));
    expect(queries.getByLabelText('Ask about your business').props.value).toBe(question);
    expect(apiPost).toHaveBeenCalledTimes(1);
    await fireEvent.press(queries.getByRole('button', { name: 'Helpful' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledExactlyOnceWith('/ai/conversations/17/messages/102/feedback', { feedback: 'up' }));
    expect(queries.getByRole('button', { name: 'Helpful', selected: true })).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Helpful' }));
    await waitFor(() => expect(apiPut).toHaveBeenLastCalledWith('/ai/conversations/17/messages/102/feedback', { feedback: null }));
  });

  it('keeps the failed original question and a newer draft separate while retrying', async () => {
    const first = deferred<ChatSendResponse>();
    const retry = deferred<ChatSendResponse>();
    apiPost.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    mockMissingSendStatus();
    const queries = await render(tree());
    await ask(queries, 'Original expense question');
    expect(queries.getByRole('button', { name: 'Send', disabled: true })).toBeTruthy();
    expect(queries.getByRole('button', { name: 'Chat history', disabled: false })).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'New chat', disabled: false }));
    expect(exposedChat.getState().pendingSend?.body).toEqual(apiPost.mock.calls[0]?.[1]);
    expect(apiPost).toHaveBeenCalledTimes(1);
    await fireEvent.changeText(queries.getByLabelText('Ask about your business'), 'Unsent next question');
    await act(async () => { first.reject(new Error('Network unavailable')); await first.promise.catch(() => undefined); });
    expect(queries.getByLabelText('Ask about your business').props.value).toBe('Unsent next question');
    expect(queries.getByText(/FinSight did not confirm whether this question finished/)).toBeTruthy();
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiGet.mock.calls.filter(([path]) => String(path).startsWith('/ai/send-requests/'))).toHaveLength(0);
    await fireEvent.press(queries.getByRole('button', { name: 'Retry question' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(apiGet).toHaveBeenCalledWith(`/ai/send-requests/${apiPost.mock.calls[0]?.[1].idempotencyKey}`, { businessProfileId: fixtures.businessProfile.id });
    expect(apiPost.mock.calls[1]?.[1]).toEqual(apiPost.mock.calls[0]?.[1]);
    expect(apiPost.mock.calls[1]?.[1].question).toBe('Original expense question');
    expect(queries.getByLabelText('Ask about your business').props.value).toBe('Unsent next question');
    await act(async () => { retry.resolve(chatResponse('Original expense question')); await retry.promise; });
    expect(queries.queryByRole('button', { name: 'Retry question' })).toBeNull();
    expect(queries.getByLabelText('Ask about your business').props.value).toBe('Unsent next question');
    expect(exposedChat.getState().activeId).toBeNull();
    expect(exposedChat.getState().pendingSend).toBeNull();
    await fireEvent.press(queries.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(3));
    expect(apiPost.mock.calls[2]?.[1].question).toBe('Unsent next question');
    expect(apiPost.mock.calls[2]?.[1].idempotencyKey).not.toBe(apiPost.mock.calls[0]?.[1].idempotencyKey);
  });

  it('retries a focused failure with its original server context', async () => {
    const first = deferred<ChatSendResponse>();
    apiPost.mockReturnValueOnce(first.promise);
    mockMissingSendStatus();
    const queries = await render(tree());
    await act(async () => { exposedChat.prepareQuestion('Please explain this stock change', undefined, { kind: 'finding', findingId: 51 }); });
    await fireEvent.press(queries.getByRole('button', { name: 'Send' }));
    await act(async () => { first.reject(new Error('Connection interrupted')); await first.promise.catch(() => undefined); });
    expect(queries.getByLabelText('Ask about your business').props.value).toBe('Please explain this stock change');
    expect(apiPost).toHaveBeenCalledTimes(1);
    await fireEvent.press(queries.getByRole('button', { name: 'Retry question' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(apiGet).toHaveBeenCalledWith(`/ai/send-requests/${apiPost.mock.calls[0]?.[1].idempotencyKey}`, { businessProfileId: fixtures.businessProfile.id });
    expect(apiPost.mock.calls[1]?.[1]).toEqual(apiPost.mock.calls[0]?.[1]);
    expect(apiPost.mock.calls[1]?.[1].focus).toEqual({ kind: 'finding', findingId: 51 });
  });

  it('does not treat a failed feedback save as a send failure', async () => {
    apiPut.mockRejectedValueOnce(new Error('Feedback could not be saved'));
    const queries = await render(tree());
    await ask(queries);
    await fireEvent.press(await queries.findByRole('button', { name: 'Helpful' }));
    expect(await queries.findByText('Feedback could not be saved')).toBeTruthy();
    expect(queries.queryByRole('button', { name: 'Retry question' })).toBeNull();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'failure'])('drops a late %s after the selected business changes', async (outcome) => {
    const pending = deferred<ChatSendResponse>();
    apiPost.mockReturnValueOnce(pending.promise);
    const queries = await render(tree());
    await ask(queries, 'Private first-business question');
    selected = { ...fixtures.businessProfile, id: 2, name: 'Second business' };
    await queries.rerender(tree());
    await act(async () => {
      if (outcome === 'success') pending.resolve(chatResponse('Private first-business question'));
      else pending.reject(new Error('Old business send failed'));
      await pending.promise.catch(() => undefined);
    });
    expect(queries.getByText('Second business')).toBeTruthy();
    expect(queries.getByLabelText('Ask about your business').props.value).toBe('');
    expect(queries.queryByText(/Private first-business question|Stock is your largest recorded expense|Old business send failed/)).toBeNull();
    expect(queries.queryByRole('button', { name: 'Retry question' })).toBeNull();
  });

  it('does not restore an obsolete draft after switching away from and back to a business', async () => {
    const pending = deferred<ChatSendResponse>();
    apiPost.mockReturnValueOnce(pending.promise);
    const queries = await render(tree());
    await ask(queries, 'Old activation question');
    await fireEvent.changeText(queries.getByLabelText('Ask about your business'), 'Draft from old activation');
    selected = { ...fixtures.businessProfile, id: 2, name: 'Second business' };
    await queries.rerender(tree());
    selected = fixtures.businessProfile;
    await queries.rerender(tree());
    await act(async () => { pending.resolve(chatResponse('Old activation question')); await pending.promise; });
    expect(queries.getByLabelText('Ask about your business').props.value).toBe('');
    expect(queries.queryByText(/Old activation question|Draft from old activation|Stock is your largest recorded expense/)).toBeNull();
    expect(queries.queryByRole('button', { name: 'Retry question' })).toBeNull();
  });

  it('keeps provider-unavailable, parsed-amount and trimmed-answer disclosures', async () => {
    apiPost.mockResolvedValueOnce(chatResponse('What if I spend 11000?', {
      provider: 'unavailable', detectedAmount: 11000,
      assistantMessage: {
        ...chatResponse().assistantMessage,
        metadata: { ...chatMetadata, amountCheck: 'trimmed' },
      },
    }));
    const queries = await render(tree('Spending Impact'));
    await ask(queries, 'What if I spend 11000?');
    expect(await queries.findByText(/unreachable right now.*placeholder/)).toBeTruthy();
    expect(queries.getByText(/FinSight read PHP 11,000/)).toBeTruthy();
    expect(queries.getByText(/Part of this answer was removed/)).toBeTruthy();
    expect(queries.queryByRole('button', { name: 'Retry question' })).toBeNull();
  });

  it('returns from history without clearing the composer or sending a question', async () => {
    apiGet.mockResolvedValueOnce([chatConversation]);
    const queries = await render(tree());
    await fireEvent.changeText(queries.getByLabelText('Ask about your business'), 'Keep this draft');
    await fireEvent.press(queries.getByRole('button', { name: 'Chat history' }));
    expect(queries.queryByLabelText('Ask about your business')).toBeNull();
    expect(await queries.findByRole('button', { name: 'Open conversation: Review stock purchases' })).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Back to this conversation' }));
    expect(queries.getByLabelText('Ask about your business').props.value).toBe('Keep this draft');
    expect(apiPost).not.toHaveBeenCalled();
  });
});
