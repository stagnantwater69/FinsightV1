import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react-native';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { FaqsScreen, TutorialsScreen, ContactScreen, PrivacyScreen, TermsScreen } from '../../src/screens/HelpScreens';
import { FAQS, PRIVACY_SECTIONS, PRIVACY_DISCLAIMER, TERMS_SECTIONS, TERMS_DISCLAIMER, LEGAL_DISCLAIMER_HEADING, TUTORIALS } from '../../src/lib/helpContent';

const withTheme = (screen: React.ReactNode) => <ThemeProvider initialMode="light">{screen}</ThemeProvider>;

describe('help and legal screens', () => {
  it.each([
    ['Privacy', PrivacyScreen, PRIVACY_SECTIONS, PRIVACY_DISCLAIMER],
    ['Terms', TermsScreen, TERMS_SECTIONS, TERMS_DISCLAIMER],
  ] as const)('%s keeps every legal paragraph and the development disclaimer visible', async (_name, Component, sections, disclaimer) => {
    const screen = await render(withTheme(<Component />));
    for (const section of sections) {
      expect(screen.getByText(section.heading)).toBeTruthy();
      for (const paragraph of section.body) expect(screen.getByText(paragraph)).toBeTruthy();
    }
    expect(screen.getByText(LEGAL_DISCLAIMER_HEADING)).toBeTruthy();
    expect(screen.getByText(disclaimer)).toBeTruthy();
  });

  it('opens and closes canonical answers', async () => {
    const screen = await render(withTheme(<FaqsScreen />));
    expect(screen.queryByText(FAQS[0].a)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: FAQS[0].q }));
    expect(screen.getByText(FAQS[0].a)).toBeTruthy();
    expect(screen.getByRole('button', { name: FAQS[0].q }).props.accessibilityState.expanded).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: FAQS[0].q }));
    expect(screen.queryByText(FAQS[0].a)).toBeNull();
  });

  it('searches answer text and lets the user recover from no matches', async () => {
    const screen = await render(withTheme(<FaqsScreen />));
    await fireEvent.changeText(screen.getByLabelText('Search questions'), 'chart of accounts');
    expect(screen.getByRole('button', { name: FAQS[1].q })).toBeTruthy();
    expect(screen.queryByRole('button', { name: FAQS[0].q })).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('Search questions'), 'zzzz-no-result');
    expect(screen.getByText('No matching questions')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Clear search' }));
    for (const faq of FAQS) expect(screen.getByRole('button', { name: faq.q })).toBeTruthy();
  });

  it('retains every written tutorial and labels videos as unavailable', async () => {
    const screen = await render(withTheme(<TutorialsScreen />));
    for (const tutorial of TUTORIALS) {
      expect(screen.getByText(tutorial.title)).toBeTruthy();
      expect(screen.getByText(tutorial.body)).toBeTruthy();
    }
    expect(screen.getByText('Video walkthroughs coming soon')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /play/i })).toBeNull();
  });

  it('does not offer a placeholder support inbox and opens available help destinations', async () => {
    const navigate = vi.fn();
    const screen = await render(withTheme(<ContactScreen navigation={{ navigate }} />));
    expect(screen.getByText('Email support is not available yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open email app' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: /^Questions & answers/ }));
    expect(navigate).toHaveBeenCalledWith('Faqs');
    await fireEvent.press(screen.getByRole('button', { name: /^Tutorials/ }));
    expect(navigate).toHaveBeenCalledWith('Tutorials');
  });
});
