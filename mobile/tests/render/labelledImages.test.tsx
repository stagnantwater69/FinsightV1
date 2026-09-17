import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react-native';

/**
 * An `<Image>` that was given a name should have one.
 *
 * WHY THIS FILE EXISTS. React Native only turns an Image into an accessibility
 * element when it is given `alt`, or told to be one — `accessibilityLabel`
 * alone leaves `accessible` unset on both platforms (Image.ios.js and
 * Image.android.js both decide it from `alt`). So an image can carry a
 * carefully written label that nothing ever reads. PhotoUpload had already
 * been fixed for this; the mascot on Home and the receipt photograph on a
 * saved record had not, and both are the kind of picture whose name is the
 * whole point of it being there.
 *
 * This is the same defect class as a role set on a plain View, and source
 * inspection cannot see either one: the prop is present and spelled correctly
 * in both the broken and the fixed version.
 *
 * WHAT THIS IS NOT. It does not say a screen reader announces these at a
 * useful moment or in a useful order. That needs a device.
 */

/*
 * GreetingHero asks the navigator whether Home is the visible tab, so it can
 * stop the flipbook ticking behind another screen. There is no navigator
 * mounted here; "yes, visible" is the state this test is about.
 */
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));

/* The hero reads the owner's first name for its greeting line; nothing here
 * turns on which name it is. */
vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => ({ profile: { firstName: 'Ana' } }),
}));

const { ThemeProvider } = await import('../../src/context/ThemeContext');

const withTheme = (node: React.ReactNode) => (
  <ThemeProvider initialMode="light">{node}</ThemeProvider>
);

describe('Named illustrations are reachable', () => {
  it("gives the receipt photograph on a saved record a name that is read", async () => {
    const { RecordOriginPanel } = await import('../../src/components/RecordOrigin');

    const queries = await render(
      withTheme(
        <RecordOriginPanel
          recordAmount={450}
          origin={{
            kind: 'receipt_scan',
            scanId: 7,
            scannedAt: '2026-09-01T02:00:00.000Z',
            extractedVendor: 'Sari-sari store',
            imageUrl: 'https://example.test/receipt.jpg',
            items: [],
            itemsSubtotal: 450,
            siblings: [],
          }}
        />,
      ),
    );

    // Collapsed by default — the picture is behind the disclosure, so open it
    // the way an owner does rather than reaching past the control.
    await fireEvent.press(queries.getByRole('button', { name: 'Show the receipt photo' }));

    const photo = queries.getByLabelText('The scanned receipt this record came from');
    expect(photo.props.accessible).toBe(true);
    expect(photo.props.accessibilityRole).toBe('image');
  });

  it("lets Fin introduce himself on Home rather than sitting there unnamed", async () => {
    const { GreetingHero } = await import('../../src/components/GreetingHero');

    const queries = await render(withTheme(<GreetingHero summary={null} />));

    // One named image, and the crossfade frame stacked behind it stays out of
    // the tree — the same mascot announced twice is worse than once.
    const fin = queries.getAllByRole('image');
    expect(fin).toHaveLength(1);
    expect(fin[0]!.props.accessibilityLabel).toBeTruthy();
  });
});
