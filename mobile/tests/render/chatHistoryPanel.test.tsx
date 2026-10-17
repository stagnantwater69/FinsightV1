import React from 'react';
import { Alert } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { chatConversation } from './support/chatFixtures';
import type { Conversation } from '../../src/lib/types';

vi.mock('../../src/lib/useReducedMotion', () => ({ useReducedMotion: () => true }));
const { ChatHistoryPanel } = await import('../../src/components/ChatHistoryPanel');
const onSelect = vi.fn();
const onRename = vi.fn();
const onDelete = vi.fn();
const conversations: Conversation[] = [
  chatConversation,
  { ...chatConversation, id: 18, title: 'Fridge purchase decision', originModule: 'Spending Impact' },
];
const tree = (items = conversations, loading = false, error: string | null = null) => <ThemeProvider initialMode="light">
  <ChatHistoryPanel conversations={items} activeId={17} loading={loading} error={error}
    onSelect={onSelect} onRename={onRename} onDelete={onDelete} />
</ThemeProvider>;

beforeEach(() => { onSelect.mockReset(); onRename.mockReset(); onDelete.mockReset(); });
afterEach(async () => { await cleanup(); vi.restoreAllMocks(); });

describe('chat history search and management', () => {
  it('offers an explicit loading retry without presenting an empty history', async () => {
    const retry = vi.fn();
    const queries = await render(<ThemeProvider initialMode="light">
      <ChatHistoryPanel conversations={[]} activeId={null} loading={false} error="History unavailable"
        onSelect={onSelect} onRename={onRename} onDelete={onDelete} onRetry={retry} />
    </ThemeProvider>);
    await fireEvent.press(queries.getByRole('button', { name: 'Retry loading conversations' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(queries.queryByText(/once you ask something/)).toBeNull();
  });

  it('keeps loaded conversations reachable while explicitly loading older history', async () => {
    const more = vi.fn();
    const queries = await render(<ThemeProvider initialMode="light">
      <ChatHistoryPanel conversations={conversations} activeId={17} loading={false} error={null}
        onSelect={onSelect} onRename={onRename} onDelete={onDelete} hasMore onLoadMore={more} />
    </ThemeProvider>);
    await fireEvent.press(queries.getByRole('button', { name: 'Load older conversations' }));
    expect(more).toHaveBeenCalledTimes(1);
    await fireEvent.press(queries.getByRole('button', { name: 'Open conversation: Review stock purchases' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(17);
  });

  it('filters titles ignoring case and surrounding whitespace, with an explicit clear action', async () => {
    const queries = await render(tree());
    await fireEvent.changeText(queries.getByLabelText('Search conversations'), '  FRIDGE  ');
    expect(queries.getByRole('button', { name: 'Open conversation: Fridge purchase decision' })).toBeTruthy();
    expect(queries.queryByRole('button', { name: 'Open conversation: Review stock purchases' })).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    await fireEvent.press(queries.getByRole('button', { name: 'Clear search' }));
    expect(queries.getByLabelText('Search conversations').props.value).toBe('');
    expect(queries.getByRole('button', { name: 'Open conversation: Review stock purchases', selected: true })).toBeTruthy();
    await fireEvent.press(queries.getByRole('button', { name: 'Open conversation: Fridge purchase decision' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(18);
  });

  it('distinguishes an unmatched search from an empty conversation list and resets search on a fresh panel', async () => {
    const queries = await render(tree());
    await fireEvent.changeText(queries.getByLabelText('Search conversations'), 'missing title');
    expect(queries.getByText(/No conversations match/i)).toBeTruthy();
    expect(queries.queryByText(/once you ask something/)).toBeNull();
    await queries.unmount();
    const reopened = await render(tree());
    expect(reopened.getByLabelText('Search conversations').props.value).toBe('');
    await reopened.rerender(tree([]));
    expect(reopened.getByText(/once you ask something/)).toBeTruthy();
    expect(reopened.queryByText(/No conversations match/i)).toBeNull();
  });

  it('keeps loading and fetch failures separate from empty search results', async () => {
    const queries = await render(tree([], true));
    expect(queries.getByText(/Loading your conversations/)).toBeTruthy();
    expect(queries.queryByText(/once you ask something|No conversations match/i)).toBeNull();
    await queries.rerender(tree([], false, 'History unavailable'));
    expect(queries.getByText('History unavailable')).toBeTruthy();
    expect(queries.queryByText(/once you ask something|No conversations match/i)).toBeNull();
  });

  it('renames inline and commits only one trimmed title', async () => {
    const alerts = vi.spyOn(Alert, 'alert');
    const queries = await render(tree());
    await fireEvent.press(queries.getByRole('button', { name: 'More options for Review stock purchases' }));
    const rename = alerts.mock.calls.at(-1)?.[2]?.find((button) => button.text === 'Rename');
    expect(rename?.onPress).toBeTypeOf('function');
    await act(async () => { rename?.onPress?.(); });
    const input = queries.getByLabelText('Rename conversation');
    await fireEvent.changeText(input, '  October stock review  ');
    const edited = queries.getByLabelText('Rename conversation');
    await act(async () => {
      edited.props.onSubmitEditing({ nativeEvent: { text: '  October stock review  ' } });
      edited.props.onBlur({ nativeEvent: { text: '  October stock review  ' } });
    });
    expect(onRename).toHaveBeenCalledExactlyOnceWith(17, 'October stock review');
    expect(onDelete).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not send a blank rename and requires separate confirmation before deleting', async () => {
    const alerts = vi.spyOn(Alert, 'alert');
    const queries = await render(tree());
    await fireEvent.press(queries.getByRole('button', { name: 'More options for Review stock purchases' }));
    await act(async () => { alerts.mock.calls.at(-1)?.[2]?.find((button) => button.text === 'Rename')?.onPress?.(); });
    await fireEvent.changeText(queries.getByLabelText('Rename conversation'), '   ');
    await fireEvent(queries.getByLabelText('Rename conversation'), 'submitEditing');
    expect(onRename).not.toHaveBeenCalled();
    await fireEvent.press(queries.getByRole('button', { name: 'More options for Review stock purchases' }));
    await act(async () => { alerts.mock.calls.at(-1)?.[2]?.find((button) => button.text === 'Delete')?.onPress?.(); });
    expect(onDelete).not.toHaveBeenCalled();
    expect(alerts.mock.calls.at(-1)?.[0]).toBe('Delete this conversation?');
    const buttons = alerts.mock.calls.at(-1)?.[2];
    expect(buttons?.find((button) => button.text === 'Keep it')?.style).toBe('cancel');
    await act(async () => { buttons?.find((button) => button.text === 'Delete')?.onPress?.(); });
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(chatConversation);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
