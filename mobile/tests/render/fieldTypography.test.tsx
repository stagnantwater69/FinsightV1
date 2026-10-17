import React, { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { Field } from '../../src/components/ui';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { font } from '../../src/theme/tokens';

function ExpenseDescription() {
  const [value, setValue] = useState('');
  return (
    <ThemeProvider initialMode="light">
      <Field label="Description" value={value} onChangeText={setValue} error="Describe this expense." />
    </ThemeProvider>
  );
}

describe('Field typography', () => {
  it('uses the interface font for editable values while preserving input and validation semantics', async () => {
    const q = await render(<ExpenseDescription />);
    const input = q.getByLabelText('Description, Describe this expense.');
    expect(StyleSheet.flatten(input.props.style).fontFamily).toBe(font.sans);

    await fireEvent.changeText(input, 'Rice — ₱1,234.50');

    expect(q.getByLabelText('Description, Describe this expense.').props.value).toBe('Rice — ₱1,234.50');
    expect(q.getByText('Describe this expense.')).toBeTruthy();
  });
});
