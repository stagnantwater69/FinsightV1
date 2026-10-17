import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react-native';
import { ThemeProvider } from '../../src/context/ThemeContext';
import type { RecoveryScenario } from '../../src/lib/types';

const post = vi.fn();
const put = vi.fn();
const onSaved = vi.fn();
vi.mock('../../src/lib/api', () => ({
  api: { post: (...args: unknown[]) => post(...args), put: (...args: unknown[]) => put(...args) },
  errorMessage: (error: unknown) => error instanceof Error ? error.message : 'Request failed.',
}));
const { RecoveryWhatIfCard } = await import('../../src/components/RecoveryWhatIf');
const scenario = (amount: number) => ({
  assumedExpectedMonthlyExpenses: amount,
  current: { adjustedDailyTarget: 1000 },
  hypothetical: { adjustedDailyTarget: amount / 30 },
} as RecoveryScenario);
const tree = (businessProfileId = 1) => <ThemeProvider initialMode="light"><RecoveryWhatIfCard
  businessProfileId={businessProfileId} basis={30000} plan={null} onTypeAmount={() => {}} onPlanSaved={onSaved}
/></ThemeProvider>;

beforeEach(() => { post.mockReset(); put.mockReset(); onSaved.mockReset(); });

it('removes the prior result while a new assumption is loading and saves only the new result', async () => {
  let finish!: (value: RecoveryScenario) => void;
  const pending = new Promise<RecoveryScenario>((resolve) => { finish = resolve; });
  post.mockResolvedValueOnce(scenario(27000)).mockReturnValueOnce(pending);
  put.mockResolvedValue({ id: 1 });
  const screen = await render(tree());
  await fireEvent.press(screen.getByRole('button', { name: 'Try −10% of your monthly expense basis' }));
  expect(await screen.findByRole('button', { name: 'Save as my plan' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Try −20% of your monthly expense basis' }));
  expect(screen.queryByRole('button', { name: 'Save as my plan' })).toBeNull();
  expect(put).not.toHaveBeenCalled();
  expect(post.mock.calls[0]?.[2].signal.aborted).toBe(true);
  await act(async () => { finish(scenario(24000)); await pending; });
  await fireEvent.press(screen.getByRole('button', { name: 'Save as my plan' }));
  expect(put.mock.calls[0]?.[1].ownerTargetAmount).toBe(24000);
  expect(onSaved).toHaveBeenCalledTimes(1);
});

it('serializes same-frame plan saves and discards completion after the business changes', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  post.mockResolvedValue(scenario(27000)); put.mockReturnValue(pending);
  const screen = await render(tree());
  await fireEvent.press(screen.getByRole('button', { name: 'Try −10% of your monthly expense basis' }));
  const button = await screen.findByRole('button', { name: 'Save as my plan' });
  type Fiber = { return?: Fiber; memoizedProps?: { onPress?: () => void } };
  let fiber = (button as unknown as { unstable_fiber: Fiber }).unstable_fiber;
  while (!fiber.memoizedProps?.onPress && fiber.return) fiber = fiber.return;
  const save = fiber.memoizedProps!.onPress!;
  await act(async () => { save(); save(); });
  expect(put).toHaveBeenCalledTimes(1);
  const signal = put.mock.calls[0]?.[2].signal as AbortSignal;
  await screen.rerender(tree(2));
  expect(signal.aborted).toBe(true);
  await act(async () => { finish({ id: 1 }); await pending; });
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.queryByText('Saved. Your real target and sales stay the same.')).toBeNull();
});
