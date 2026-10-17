import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '../../src/context/ThemeContext';
import type { BusinessProfile, ChatAction, ChatAnswerMetadata, RecordItem } from '../../src/lib/types';
import * as fixtures from './support/fixtures';
import { chatMetadata, deferred } from './support/chatFixtures';

const apiGet = vi.fn();
const apiPatch = vi.fn();
const navigate = vi.fn();
const onFollowUp = vi.fn();
const onRate = vi.fn();
const onLeave = vi.fn();
let selected: BusinessProfile | null = fixtures.businessProfile;

vi.mock('../../src/lib/api', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args), patch: (...args: unknown[]) => apiPatch(...args) },
}));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate }) }));
vi.mock('../../src/context/BusinessProfileContext', () => ({ useBusinessProfiles: () => ({ selected }) }));
const { ChatReplyExtras, ChatMarkdown } = await import('../../src/components/ChatReply');

const reviewAction: ChatAction = {
  kind: 'review-finding', findingId: 51, label: 'Mark expected', status: 'DISMISSED', feedback: 'EXPECTED_TRANSACTION',
};
const record = { id: 41, type: 'expense', businessProfileId: 1, amount: 6800.25, date: '2026-10-12' } as RecordItem;
function tree(metadata: ChatAnswerMetadata = chatMetadata, latest = true, feedback: 'up' | 'down' | null = null) {
  return <ThemeProvider initialMode="light"><ChatReplyExtras metadata={metadata} latest={latest} feedback={feedback}
    scopeKey={`${selected?.id ?? 'none'}:17`} onFollowUp={onFollowUp} onRate={onRate} onLeave={onLeave} /></ThemeProvider>;
}

function pressHandler(node: ReturnType<Awaited<ReturnType<typeof render>>['getByRole']>): () => void {
  type Fiber = { return?: Fiber; memoizedProps?: { onPress?: () => void } };
  let fiber = (node as unknown as { unstable_fiber: Fiber }).unstable_fiber;
  while (!fiber.memoizedProps?.onPress && fiber.return) fiber = fiber.return;
  expect(fiber.memoizedProps?.onPress).toBeTypeOf('function');
  return fiber.memoizedProps!.onPress!;
}

beforeEach(() => {
  selected = fixtures.businessProfile;
  for (const spy of [apiGet, apiPatch, navigate, onFollowUp, onRate, onLeave]) spy.mockReset();
  apiGet.mockResolvedValue(record);
  apiPatch.mockResolvedValue(undefined);
});
afterEach(async () => { await cleanup(); vi.restoreAllMocks(); });

describe('chat reply record references and actions', () => {
  it('expands server-provided records with exact decimal amounts and dates without fetching', async () => {
    const queries = await render(tree());
    const records = queries.getByRole('button', { name: 'Records mentioned (2)', expanded: false });
    expect(queries.queryByRole('link', { name: /^Open record Weekly stock/ })).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
    await fireEvent.press(records);
    expect(queries.getByRole('button', { name: 'Records mentioned (2)', expanded: true })).toBeTruthy();
    const stock = queries.getByRole('link', { name: /^Open record Weekly stock/ });
    const sales = queries.getByRole('link', { name: /^Open record Counter sales/ });
    expect(stock.props.accessibilityLabel).toBe('Open record Weekly stock, PHP 6,800.25, Oct 12, 2026');
    expect(sales.props.accessibilityLabel).toBe('Open record Counter sales, PHP 5,400.75, Oct 5, 2026');
    expect(queries.getByText(/PHP 6,800\.25/)).toBeTruthy();
    expect(queries.getByText(/PHP 5,400\.75/)).toBeTruthy();
    expect(apiGet).not.toHaveBeenCalled();
    await fireEvent.press(queries.getByRole('button', { name: 'Records mentioned (2)' }));
    expect(queries.queryByRole('link', { name: /^Open record Weekly stock/ })).toBeNull();
  });

  it('loads record details through the owner endpoint before leaving and navigating', async () => {
    const pending = deferred<RecordItem>();
    apiGet.mockReturnValueOnce(pending.promise);
    const queries = await render(tree());
    await fireEvent.press(queries.getByRole('button', { name: 'Records mentioned (2)' }));
    await fireEvent.press(queries.getByRole('link', { name: /^Open record Weekly stock/ }));
    expect(apiGet.mock.calls[0]?.[0]).toBe('/records/expenses/41');
    expect(onLeave).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(record); await pending.promise; });
    await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith('Records', { screen: 'EditRecord', params: { record } }));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('opens page metadata using only the fixed route map and never runs follow-ups automatically', async () => {
    const queries = await render(tree());
    const question = chatMetadata.followUps[0]!;
    await fireEvent.press(queries.getByRole('button', { name: `Use this question: ${question}` }));
    expect(onFollowUp).toHaveBeenCalledExactlyOnceWith(question);
    expect(apiGet).not.toHaveBeenCalled();
    expect(apiPatch).not.toHaveBeenCalled();
    await fireEvent.press(queries.getByRole('link', { name: /Open Expense Insights/ }));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('Insights', { screen: 'ExpenseBehavior' });
  });

  it('withholds follow-ups and actions from old replies while keeping their evidence and feedback', async () => {
    const queries = await render(tree({ ...chatMetadata, actions: [reviewAction] }, false));
    expect(queries.queryByRole('button', { name: /Use this question/ })).toBeNull();
    expect(queries.queryByRole('button', { name: 'Mark expected' })).toBeNull();
    expect(queries.getByRole('button', { name: 'Records mentioned (2)' })).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Not helpful' }));
    expect(onRate).toHaveBeenCalledExactlyOnceWith('down');
    expect(apiPatch).not.toHaveBeenCalled();
    await queries.rerender(tree(chatMetadata, false, 'down'));
    await fireEvent.press(queries.getByRole('button', { name: 'Not helpful', selected: true }));
    expect(onRate).toHaveBeenLastCalledWith(null);
  });

  it('serializes same-frame review presses and submits only the server action fields', async () => {
    const pending = deferred<void>();
    apiPatch.mockReturnValueOnce(pending.promise);
    const queries = await render(tree({ ...chatMetadata, actions: [reviewAction] }));
    expect(apiPatch).not.toHaveBeenCalled();
    const run = pressHandler(queries.getByRole('button', { name: 'Mark expected' }));
    await act(async () => { run(); run(); });
    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(apiPatch.mock.calls[0]?.slice(0, 2)).toEqual(['/insights/findings/51/review', {
      status: 'DISMISSED', feedback: 'EXPECTED_TRANSACTION',
    }]);
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(await queries.findByText(/Saved: Mark expected/)).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'])('discards a late record %s after a business change', async (outcome) => {
    const pending = deferred<RecordItem>();
    apiGet.mockReturnValueOnce(pending.promise);
    const queries = await render(tree());
    await fireEvent.press(queries.getByRole('button', { name: 'Records mentioned (2)' }));
    await fireEvent.press(queries.getByRole('link', { name: /^Open record Weekly stock/ }));
    selected = { ...fixtures.businessProfile, id: 2, name: 'Second business' };
    await queries.rerender(tree());
    await act(async () => {
      if (outcome === 'success') pending.resolve(record);
      else pending.reject(new Error('Expired owner result'));
      await pending.promise.catch(() => undefined);
    });
    expect(onLeave).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(queries.queryByText(/couldn't be opened|Expired owner result/)).toBeNull();
  });

  it('drops an in-flight review completion when the answer is no longer latest', async () => {
    const pending = deferred<void>();
    apiPatch.mockReturnValueOnce(pending.promise);
    const metadata = { ...chatMetadata, actions: [reviewAction] };
    const queries = await render(tree(metadata));
    await fireEvent.press(queries.getByRole('button', { name: 'Mark expected' }));
    await queries.rerender(tree(metadata, false));
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(queries.queryByText(/Saved: Mark expected/)).toBeNull();
    expect(queries.queryByRole('button', { name: 'Mark expected' })).toBeNull();
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('allows a new-scope record fetch while preventing an old result from unlocking or opening it', async () => {
    const oldRequest = deferred<RecordItem>();
    const newRequest = deferred<RecordItem>();
    apiGet.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const queries = await render(tree());
    await fireEvent.press(queries.getByRole('button', { name: 'Records mentioned (2)' }));
    await fireEvent.press(queries.getByRole('link', { name: /^Open record Weekly stock/ }));
    selected = { ...fixtures.businessProfile, id: 2, name: 'Second business' };
    const metadata: ChatAnswerMetadata = {
      ...chatMetadata,
      references: [{ ...chatMetadata.references[0]!, id: 43, label: 'Second business stock' }],
    };
    await queries.rerender(tree(metadata));
    await fireEvent.press(queries.getByRole('button', { name: 'Records mentioned (1)' }));
    await fireEvent.press(queries.getByRole('link', { name: /^Open record Second business stock/ }));
    expect(apiGet.mock.calls.map(([path]) => path)).toEqual(['/records/expenses/41', '/records/expenses/43']);
    await act(async () => { oldRequest.resolve(record); await oldRequest.promise; });
    expect(queries.getByRole('link', { name: /^Open record Second business stock/, disabled: true, busy: true })).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    expect(onLeave).not.toHaveBeenCalled();
    const newRecord = { ...record, id: 43, businessProfileId: 2 };
    await act(async () => { newRequest.resolve(newRecord); await newRequest.promise; });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('Records', { screen: 'EditRecord', params: { record: newRecord } });
  });

  it('ignores malformed record, page and action identities without issuing requests', async () => {
    const metadata = {
      ...chatMetadata,
      references: [{ ...chatMetadata.references[0]!, id: 0 }],
      pages: [{ key: '__proto__', label: 'External location' }],
      actions: [{ ...reviewAction, findingId: Number.NaN }],
    } as unknown as ChatAnswerMetadata;
    const queries = await render(tree(metadata));
    const records = queries.queryByRole('button', { name: /Records mentioned/ });
    if (records) await fireEvent.press(records);
    for (const node of [
      queries.queryByRole('link', { name: /^Open record Weekly stock/ }),
      queries.queryByRole('link', { name: /External location/ }),
      queries.queryByRole('button', { name: 'Mark expected' }),
    ]) if (node) await fireEvent.press(node);
    expect(apiGet).not.toHaveBeenCalled();
    expect(apiPatch).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('renders markup-looking model text as text rather than a navigable link', async () => {
    const text = '<script>wrong()</script> [Pay here](https://example.invalid) **PHP 1,234.56**';
    const queries = await render(<ThemeProvider initialMode="light"><ChatMarkdown text={text} color="#1a2022" /></ThemeProvider>);
    expect(queries.getByText(/<script>wrong\(\)<\/script> \[Pay here\]\(https:\/\/example\.invalid\) PHP 1,234\.56/)).toBeTruthy();
    expect(queries.queryByRole('link')).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });
});
