import React, { useState } from 'react';
import { StyleSheet } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react-native';
import { CodeInput } from '../../src/components/CodeInput';
import { ThemeProvider } from '../../src/context/ThemeContext';

function CodeField({ editable = true, error }: { editable?: boolean; error?: string }) {
  const [value, setValue] = useState('');
  return (
    <ThemeProvider initialMode="light">
      <CodeInput label="Recovery code" value={value} onChangeText={setValue} editable={editable} error={error} />
    </ThemeProvider>
  );
}

describe('segmented recovery code', () => {
  it('starts with six decorative cells and one accessible code input', async () => {
    const queries = await render(<CodeField />);
    expect(queries.getAllByLabelText('Recovery code')).toHaveLength(1);
    expect(queries.getByLabelText('Recovery code')).toHaveProp('value', '');
    expect(queries.queryAllByTestId(/code-input-cell-/)).toHaveLength(0);
    expect(queries.getAllByTestId(/code-input-cell-/, { includeHiddenElements: true })).toHaveLength(6);
  });

  it.each([
    ['08 2450', '082450'],
    ['0753-2474', '07532474'],
    ['01234 56789', '0123456789'],
    ['01234567890', '01234567890'],
    ['012a-45', '012a45'],
  ])('retains the complete value %s while showing its meaningful characters', async (raw, displayed) => {
    const queries = await render(<CodeField />);
    await fireEvent.changeText(queries.getByLabelText('Recovery code'), raw);
    expect(queries.getByLabelText('Recovery code')).toHaveProp('value', raw);
    const cells = queries.getAllByTestId(/code-input-cell-/, { includeHiddenElements: true });
    expect(cells).toHaveLength(displayed.length);
    for (let index = 0; index < displayed.length; index += 1) {
      expect(cells[index]).toHaveTextContent(displayed[index]);
    }
  });

  it('retains the field error in its accessible name', async () => {
    const queries = await render(<CodeField error="The code is digits only." />);
    expect(queries.getByLabelText('Recovery code, The code is digits only.')).toHaveProp('value', '');
    expect(queries.getByText('The code is digits only.')).toBeTruthy();
  });

  it('maps a tap on a wrapped cell to the matching digit after a separator', async () => {
    const queries = await render(<CodeField />);
    const input = queries.getByLabelText('Recovery code');
    await fireEvent.changeText(input, '0753-2474');
    await fireEvent(input, 'focus');
    const cells = queries.getAllByTestId(/code-input-cell-/, { includeHiddenElements: true });
    for (let index = 0; index < cells.length; index += 1) {
      await fireEvent(cells[index], 'layout', { nativeEvent: { layout: {
        x: (index % 4) * 48, y: Math.floor(index / 4) * 64, width: 40, height: 56,
      } } });
    }
    const touch = { nativeEvent: { locationX: 20, locationY: 92 } };
    await fireEvent(input, 'touchStart', touch);
    await fireEvent(input, 'touchEnd', touch);
    expect(StyleSheet.flatten(cells[4].props.style).borderWidth).toBe(2);
    expect(StyleSheet.flatten(cells[3].props.style).borderWidth).toBe(1);
    expect(input).toHaveProp('value', '0753-2474');
  });

  it('marks the field disabled without losing the code value', async () => {
    const onChangeText = vi.fn();
    const queries = await render(
      <ThemeProvider initialMode="dark">
        <CodeInput label="Recovery code" value="082450" onChangeText={onChangeText} editable={false} />
      </ThemeProvider>,
    );
    const input = queries.getByLabelText('Recovery code');
    expect(input).toHaveProp('editable', false);
    expect(input).toBeDisabled();
    expect(input).toHaveProp('value', '082450');
  });
});
