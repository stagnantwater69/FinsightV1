import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react-native';
import { LaunchScreen } from '../../src/components/LaunchScreen';

describe('Launch screen', () => {
  it('waits for fonts before exposing branded text and loading feedback', async () => {
    const queries = await render(<LaunchScreen fontsReady={false} />);

    expect(queries.queryByText('FinSight')).toBeNull();
    expect(queries.queryByText('A clearer view of your business.')).toBeNull();
    expect(queries.queryByText('Opening your workspace…')).toBeNull();
    expect(queries.queryByRole('progressbar')).toBeNull();

    await queries.rerender(<LaunchScreen fontsReady />);

    expect(queries.getByRole('header', { name: 'FinSight' })).toBeTruthy();
    expect(queries.getByText('A clearer view of your business.')).toBeTruthy();
    expect(queries.getByText('Opening your workspace…')).toBeTruthy();
    const progress = queries.getByRole('progressbar', { name: 'Opening FinSight' });
    expect(progress).toHaveProp('accessibilityState', { busy: true });
  });
});
