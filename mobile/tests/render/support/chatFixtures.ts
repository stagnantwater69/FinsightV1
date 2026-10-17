import type { ChatAnswerMetadata, ChatSendResponse, Conversation } from '../../../src/lib/types';

export const chatConversation: Conversation = {
  id: 17,
  title: 'Review stock purchases',
  originModule: 'Expense Insights',
  createdAt: '2026-10-05T03:00:00.000Z',
  lastMessageAt: '2026-10-12T04:00:00.000Z',
};

export const chatMetadata: ChatAnswerMetadata = {
  references: [
    { kind: 'record', recordType: 'expense', id: 41, label: 'Weekly stock', amount: 6800.25, date: '2026-10-12' },
    { kind: 'record', recordType: 'sales', id: 42, label: 'Counter sales', amount: 5400.75, date: '2026-10-05' },
  ],
  pages: [{ key: 'expense-insights', label: 'Expense Insights' }],
  actions: [],
  followUps: ['How do stock purchases compare with sales?'],
  period: 'October 2026',
  amountCheck: 'passed',
};

export function chatResponse(question = 'Which category is highest?', overrides: Partial<ChatSendResponse> = {}): ChatSendResponse {
  const createdAt = '2026-10-12T04:00:00.000Z';
  return {
    conversation: chatConversation,
    userMessage: { id: 101, role: 'user', content: question, createdAt },
    assistantMessage: {
      id: 102, role: 'assistant', content: '**Stock** is your largest recorded expense.', createdAt, metadata: chatMetadata,
    },
    provider: 'gemini',
    detectedAmount: null,
    ...overrides,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
