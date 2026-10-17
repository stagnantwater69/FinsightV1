import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Linking, ScrollView } from 'react-native';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { FaqsScreen, TutorialsScreen, ContactScreen, PrivacyScreen, TermsScreen } from '../../src/screens/HelpScreens';
import { FAQS, PRIVACY_SECTIONS, PRIVACY_DISCLAIMER, TERMS_SECTIONS, TERMS_DISCLAIMER, LEGAL_DISCLAIMER_HEADING, TUTORIALS } from '../../src/lib/helpContent';

const support = vi.hoisted(() => ({ email: null as string | null }));
vi.mock('../../src/lib/helpContent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/helpContent')>();
  return { ...actual, get SUPPORT_EMAIL() { return support.email ?? actual.SUPPORT_EMAIL; } };
});
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));

beforeEach(() => { support.email = null; vi.clearAllMocks(); });
afterEach(async () => { await cleanup(); vi.restoreAllMocks(); });

const withTheme = (screen: React.ReactNode) => <ThemeProvider initialMode="light">{screen}</ThemeProvider>;

function pressHandler(node: { unstable_fiber?: any }): () => unknown {
  let fiber = node.unstable_fiber;
  while (fiber) {
    if (typeof fiber.memoizedProps?.onPress === 'function') return fiber.memoizedProps.onPress;
    fiber = fiber.return;
  }
  throw new Error('Button has no press handler');
}

describe('help and legal screens', () => {
  it.each([
    ['Privacy', PrivacyScreen, PRIVACY_SECTIONS],
    ['Terms', TermsScreen, TERMS_SECTIONS],
  ] as const)('%s opens its section index and jumps to the measured section without collapsing the page', async (_name, Component, sections) => {
    const scrollTo = vi.spyOn(ScrollView.prototype, 'scrollTo');
    const screen = await render(withTheme(<Component />));
    expect(screen.getByRole('button', { name: 'On this page' }).props.accessibilityState.expanded).toBe(false);
    expect(screen.queryByRole('button', { name: `Jump to ${sections[0].heading}` })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'On this page' }));
    for (const section of sections) expect(screen.getByRole('button', { name: `Jump to ${section.heading}` })).toBeTruthy();
    const destination = sections[sections.length - 1];
    const jump = screen.getByRole('button', { name: `Jump to ${destination.heading}` });
    await fireEvent.press(jump);
    expect(scrollTo).not.toHaveBeenCalled();
    let section = screen.getByRole('header', { name: destination.heading });
    while (!section.props.onLayout && section.parent) section = section.parent;
    expect(section.props.onLayout).toBeTypeOf('function');
    await fireEvent(section, 'layout', { nativeEvent: { layout: { x: 0, y: 840, width: 320, height: 200 } } });
    await fireEvent.press(jump);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 832, animated: false });
    expect(screen.getByRole('button', { name: 'On this page' }).props.accessibilityState.expanded).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'On this page' }));
    expect(screen.queryByRole('button', { name: `Jump to ${destination.heading}` })).toBeNull();
    expect(screen.getByRole('header', { name: destination.heading })).toBeTruthy();
  });

  it.each([
    ['Privacy', PrivacyScreen, PRIVACY_SECTIONS, PRIVACY_DISCLAIMER],
    ['Terms', TermsScreen, TERMS_SECTIONS, TERMS_DISCLAIMER],
  ] as const)('%s keeps every legal paragraph and the development disclaimer visible', async (_name, Component, sections, disclaimer) => {
    const screen = await render(withTheme(<Component />));
    for (const section of sections) {
      expect(screen.getByRole('header', { name: section.heading })).toBeTruthy();
      for (const paragraph of section.body) expect(screen.getByText(paragraph).props.selectable).toBe(true);
    }
    expect(screen.getByRole('header', { name: LEGAL_DISCLAIMER_HEADING })).toBeTruthy();
    expect(screen.getByText(disclaimer).props.selectable).toBe(true);
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

  it('opens a different FAQ answer without leaving the previous answer expanded', async () => {
    const screen = await render(withTheme(<FaqsScreen />));
    await fireEvent.press(screen.getByRole('button', { name: FAQS[0].q }));
    await fireEvent.press(screen.getByRole('button', { name: FAQS[1].q }));
    expect(screen.queryByText(FAQS[0].a)).toBeNull();
    expect(screen.getByRole('button', { name: FAQS[0].q }).props.accessibilityState.expanded).toBe(false);
    expect(screen.getByText(FAQS[1].a)).toBeTruthy();
    expect(screen.getByRole('button', { name: FAQS[1].q }).props.accessibilityState.expanded).toBe(true);
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

  it('opens the written tutorials from questions and answers', async () => {
    const navigate = vi.fn();
    const screen = await render(withTheme(<FaqsScreen navigation={{ navigate }} />));
    await fireEvent.press(screen.getByRole('button', { name: /^Browse written tutorials\./ }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('Tutorials');
  });

  it('opens every exact written tutorial and labels videos as unavailable', async () => {
    const screen = await render(withTheme(<TutorialsScreen />));
    for (const tutorial of TUTORIALS) {
      expect(screen.getByText(tutorial.title)).toBeTruthy();
      const label = `Step ${tutorial.n}: ${tutorial.title}`;
      expect(screen.queryByText(tutorial.body)).toBeNull();
      expect(screen.getByRole('button', { name: label }).props.accessibilityState.expanded).toBe(false);
      await fireEvent.press(screen.getByRole('button', { name: label }));
      expect(screen.getByText(tutorial.body).props.selectable).toBe(true);
      expect(screen.getByRole('button', { name: label }).props.accessibilityState.expanded).toBe(true);
      await fireEvent.press(screen.getByRole('button', { name: label }));
      expect(screen.queryByText(tutorial.body)).toBeNull();
    }
    expect(screen.getByText('Video walkthroughs coming soon')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /play/i })).toBeNull();
  });

  it('opens a second tutorial while closing the previously expanded guide', async () => {
    const screen = await render(withTheme(<TutorialsScreen />));
    const first = TUTORIALS[0];
    const second = TUTORIALS[1];
    const firstLabel = `Step ${first.n}: ${first.title}`;
    const secondLabel = `Step ${second.n}: ${second.title}`;
    await fireEvent.press(screen.getByRole('button', { name: firstLabel }));
    expect(screen.getByText(first.body)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: secondLabel }));
    expect(screen.queryByText(first.body)).toBeNull();
    expect(screen.getByRole('button', { name: firstLabel }).props.accessibilityState.expanded).toBe(false);
    expect(screen.getByText(second.body)).toBeTruthy();
    expect(screen.getByRole('button', { name: secondLabel }).props.accessibilityState.expanded).toBe(true);
  });

  it('does not offer a placeholder support inbox and opens available help destinations', async () => {
    const navigate = vi.fn();
    const openEmail = vi.spyOn(Linking, 'openURL');
    const screen = await render(withTheme(<ContactScreen navigation={{ navigate }} />));
    expect(screen.getByText('Email support is not available yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open email app' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: /^Questions & answers/ }));
    expect(navigate).toHaveBeenCalledWith('Faqs');
    await fireEvent.press(screen.getByRole('button', { name: /^Tutorials/ }));
    expect(navigate).toHaveBeenCalledWith('Tutorials');
    expect(openEmail).not.toHaveBeenCalled();
  });

  it('opens a configured support inbox only once while the email app is pending', async () => {
    support.email = 'support@finsight.test';
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const openEmail = vi.spyOn(Linking, 'openURL').mockReturnValue(pending);
    const screen = await render(withTheme(<ContactScreen navigation={{ navigate: vi.fn() }} />));
    expect(screen.getByText(support.email).props.selectable).toBe(true);
    const open = pressHandler(screen.getByRole('button', { name: 'Open email app' }));
    await act(() => { void open(); void open(); });
    expect(openEmail).toHaveBeenCalledTimes(1);
    expect(openEmail).toHaveBeenCalledWith('mailto:support@finsight.test');
    expect(screen.getByRole('button', { name: 'Open email app' })).toBeDisabled();
    await act(async () => { finish(); await pending; });
    expect(screen.getByRole('button', { name: 'Open email app' })).not.toBeDisabled();
  });

  it('keeps the configured address copyable after email app failure and allows retry', async () => {
    support.email = 'support@finsight.test';
    const openEmail = vi.spyOn(Linking, 'openURL').mockRejectedValueOnce(new Error('No email app')).mockResolvedValueOnce(undefined);
    const screen = await render(withTheme(<ContactScreen navigation={{ navigate: vi.fn() }} />));
    await fireEvent.press(screen.getByRole('button', { name: 'Open email app' }));
    const fallback = "We couldn't open your email app. Press and hold the address above to copy it into your preferred mail app.";
    expect(await screen.findByText(fallback)).toBeTruthy();
    expect(screen.getByText(support.email).props.selectable).toBe(true);
    expect(screen.getByRole('button', { name: 'Open email app' })).not.toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Open email app' }));
    await waitFor(() => expect(openEmail).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(fallback)).toBeNull();
    expect(openEmail).toHaveBeenLastCalledWith('mailto:support@finsight.test');
  });

  it.each([
    ['Questions & answers', FaqsScreen],
    ['Tutorials', TutorialsScreen],
    ['Contact us', ContactScreen],
    ['Privacy', PrivacyScreen],
    ['Terms of use', TermsScreen],
  ] as const)('%s exposes its header and returns through stack back or More fallback', async (title, Component) => {
    const navigation = { navigate: vi.fn(), goBack: vi.fn(), canGoBack: vi.fn().mockReturnValue(true) };
    const screen = await render(withTheme(<Component navigation={navigation} />));
    expect(screen.getByRole('header', { name: title })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Go back' }));
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).not.toHaveBeenCalled();
    navigation.canGoBack.mockReturnValue(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Go back' }));
    expect(navigation.navigate).toHaveBeenCalledWith('MoreHome');
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });
});
