import { CommonActions, StackActions, StackRouter, TabActions, TabRouter } from '@react-navigation/routers';
import { describe, expect, it, vi } from 'vitest';
import { openOperatingScheduleFromRecovery, returnFromOperatingSchedule } from '../src/lib/operatingScheduleNavigation';

function journey() {
  const moreRouter = StackRouter({ initialRouteName: 'MoreHome' });
  const moreOptions = { routeNames: ['MoreHome', 'BusinessProfiles', 'BusinessProfileForm', 'OperatingSchedule'], routeParamList: {}, routeGetIdList: {} };
  let more = moreRouter.getInitialState(moreOptions);
  const tabsRouter = TabRouter({ initialRouteName: 'Insights', backBehavior: 'history' });
  const tabsOptions = { routeNames: ['Home', 'Records', 'Insights', 'More'], routeParamList: {}, routeGetIdList: {} };
  let tabs = tabsRouter.getInitialState(tabsOptions);

  function dispatchMore(action: Parameters<typeof moreRouter.getStateForAction>[1]) {
    const next = moreRouter.getStateForAction(more, action, moreOptions);
    if (!next) throw new Error(`Unhandled More action ${action.type}`);
    more = moreRouter.getRehydratedState(next, moreOptions);
  }

  function dispatchTabs(action: Parameters<typeof tabsRouter.getStateForAction>[1]) {
    const next = tabsRouter.getStateForAction(tabs, action, tabsOptions);
    if (!next) throw new Error(`Unhandled tab action ${action.type}`);
    tabs = tabsRouter.getRehydratedState(next, tabsOptions);
  }

  const navigation = {
    getState: () => more,
    canGoBack: vi.fn(() => true),
    goBack: vi.fn(() => dispatchMore(CommonActions.goBack())),
    popToTop: vi.fn(() => dispatchMore(StackActions.popToTop())),
    reset: vi.fn((state: { index: number; routes: { name: string }[] }) => dispatchMore(CommonActions.reset(state))),
    setParams: vi.fn((params: { from: undefined }) => dispatchMore(CommonActions.setParams(params))),
    navigate: vi.fn((name: string, params?: object) => {
      if (name === 'More' || name === 'Insights') {
        dispatchTabs(CommonActions.navigate(name, params));
        const target = params as { screen?: string; params?: object; initial?: boolean } | undefined;
        if (name === 'More' && target?.screen) {
          expect(target.initial).toBe(false);
          dispatchMore(CommonActions.navigate(target.screen, target.params));
        }
      } else dispatchMore(CommonActions.navigate(name, params));
    }),
  };

  return {
    navigation,
    more: () => more,
    tabs: () => tabs,
    tab: () => tabs.routes[tabs.index]!.name,
    screen: () => more.routes[more.index]!.name,
    tapMore: () => dispatchTabs(TabActions.jumpTo('More')),
    push: (name: string, params?: object) => dispatchMore(StackActions.push(name, params)),
    resetToSchedule: () => dispatchMore(CommonActions.reset({ index: 0, routes: [{ name: 'OperatingSchedule', params: { from: 'RecoveryTarget' } }] })),
  };
}

describe('Operating schedule return navigation', () => {
  it('returns to Recovery and leaves MoreHome ready on the first More visit and repeated visits', () => {
    const j = journey();
    expect(j.tab()).toBe('Insights');
    for (let visit = 0; visit < 2; visit += 1) {
      openOperatingScheduleFromRecovery(j.navigation);
      expect(j.navigation.navigate).toHaveBeenLastCalledWith('More', {
        screen: 'OperatingSchedule', initial: false, params: { from: 'RecoveryTarget' },
      });
      expect(j.tab()).toBe('More');
      expect(j.more().routes.map((route) => route.name)).toEqual(['MoreHome', 'OperatingSchedule']);
      expect(j.screen()).toBe('OperatingSchedule');
      returnFromOperatingSchedule(j.navigation, 'RecoveryTarget');
      expect(j.tab()).toBe('Insights');
      expect(j.tabs().routes[j.tabs().index]!.params).toMatchObject({ screen: 'RecoveryTarget' });
      expect(j.more().routes.map((route) => route.name)).toEqual(['MoreHome']);
      j.tapMore();
      expect(j.tab()).toBe('More');
      expect(j.screen()).toBe('MoreHome');
    }
    expect(j.navigation.canGoBack).not.toHaveBeenCalled();
  });

  it('repairs a legacy root schedule instead of using a parent back action', () => {
    const j = journey();
    j.tapMore();
    j.resetToSchedule();
    returnFromOperatingSchedule(j.navigation, 'RecoveryTarget');
    expect(j.tab()).toBe('Insights');
    j.tapMore();
    expect(j.screen()).toBe('MoreHome');
    expect(j.more().routes).toHaveLength(1);
    expect(j.navigation.goBack).not.toHaveBeenCalled();
    expect(j.navigation.canGoBack).not.toHaveBeenCalled();
  });

  it('returns ordinary business-profile entry to the preceding local screen', () => {
    const j = journey();
    j.tapMore();
    j.push('BusinessProfiles');
    j.push('BusinessProfileForm');
    j.push('OperatingSchedule', { from: undefined });
    returnFromOperatingSchedule(j.navigation);
    expect(j.tab()).toBe('More');
    expect(j.screen()).toBe('BusinessProfileForm');
    expect(j.more().routes.map((route) => route.name)).toEqual(['MoreHome', 'BusinessProfiles', 'BusinessProfileForm']);
    expect(j.navigation.goBack).toHaveBeenCalledOnce();
    expect(j.navigation.popToTop).not.toHaveBeenCalled();
  });

  it('restores MoreHome for a root schedule without a Recovery origin', () => {
    const j = journey();
    j.tapMore();
    j.resetToSchedule();
    returnFromOperatingSchedule(j.navigation);
    expect(j.tab()).toBe('More');
    expect(j.screen()).toBe('MoreHome');
    expect(j.navigation.goBack).not.toHaveBeenCalled();
    expect(j.navigation.canGoBack).not.toHaveBeenCalled();
  });
});
