import React from 'react';
import { Platform, View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';

type PickerProps = {
  value: Date;
  maximumDate?: Date;
  display: string;
  onChange: (event: { type: string }, picked?: Date) => void;
};
let picker: PickerProps | null = null;
vi.mock('@react-native-community/datetimepicker', () => ({
  default: (props: PickerProps) => {
    picker = props;
    return <View testID="business-date-picker" />;
  },
}));

const { DateField } = await import('../../src/components/DateField');
const { ThemeProvider } = await import('../../src/context/ThemeContext');
const originalPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
const onChange = vi.fn();

function mount(value: string, today = '2026-10-13', allowFuture = false) {
  return render(
    <ThemeProvider initialMode="light">
      <DateField label="Record date" value={value} today={today} allowFuture={allowFuture} onChange={onChange} />
    </ThemeProvider>,
  );
}
function calendarDate(date: Date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()];
}

beforeEach(() => {
  picker = null;
  onChange.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 12, 12));
});
afterEach(async () => {
  await cleanup();
  Object.defineProperty(Platform, 'OS', originalPlatform);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DateField business reference day', () => {
  it.each([
    { platform: 'ios', deviceDay: 12, display: 'spinner' },
    { platform: 'android', deviceDay: 14, display: 'default' },
  ] as const)('uses business today when the $platform device has a different calendar day', async ({ platform, deviceDay, display }) => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
    vi.setSystemTime(new Date(2026, 9, deviceDay, 12));
    const screen = await mount('2026-10-13');
    expect(new Date().getDate()).toBe(deviceDay);
    expect(screen.getByText('Today')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Record date. Today. Opens a date picker.' }));
    expect(calendarDate(picker!.value)).toEqual([2026, 10, 13]);
    expect(calendarDate(picker!.maximumDate!)).toEqual([2026, 10, 13]);
    expect(picker!.display).toBe(display);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('speaks yesterday relative to the business even when that date is device today', async () => {
    const screen = await mount('2026-10-12');
    expect(screen.getByText('Yesterday')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Record date. Yesterday. Opens a date picker.' }));
    expect(calendarDate(picker!.value)).toEqual([2026, 10, 12]);
    expect(calendarDate(picker!.maximumDate!)).toEqual([2026, 10, 13]);
  });

  it('starts a future stored value at the business cap without silently changing the record', async () => {
    vi.setSystemTime(new Date(2026, 9, 14, 12));
    const screen = await mount('2026-10-14');
    await fireEvent.press(screen.getByRole('button', { name: /^Record date\./ }));
    expect(calendarDate(picker!.value)).toEqual([2026, 10, 13]);
    expect(calendarDate(picker!.maximumDate!)).toEqual([2026, 10, 13]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('allows a planned future date without the business-day cap', async () => {
    const screen = await mount('2026-10-20', '2026-10-13', true);
    await fireEvent.press(screen.getByRole('button', { name: /^Record date\./ }));
    expect(calendarDate(picker!.value)).toEqual([2026, 10, 20]);
    expect(picker!.maximumDate).toBeUndefined();
  });

  it('ignores dismissal and sends the selected local calendar date unchanged', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    const screen = await mount('2026-10-13');
    await fireEvent.press(screen.getByRole('button', { name: 'Record date. Today. Opens a date picker.' }));
    const dismissed = picker!.onChange;
    await act(() => dismissed({ type: 'dismissed' }, new Date(2026, 9, 11)));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('business-date-picker')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Record date. Today. Opens a date picker.' }));
    await act(() => picker!.onChange({ type: 'set' }, new Date(2026, 9, 13)));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('2026-10-13');
  });
});
