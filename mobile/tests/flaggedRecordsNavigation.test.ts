import { CommonActions, StackActions, StackRouter, TabActions, TabRouter } from '@react-navigation/routers';
import { describe, expect, it, vi } from 'vitest';
import { openFlaggedRecords, returnFromFlaggedRecords } from '../src/lib/flaggedRecordsNavigation';

function journey() {
  const recordsRouter = StackRouter({ initialRouteName: 'RecordsList' });
  const recordsOptions = { routeNames: ['RecordsList', 'FlaggedRecords', 'ImportCsv'], routeParamList: {}, routeGetIdList: {} };
  let records = recordsRouter.getInitialState(recordsOptions);
  const insightsRouter = StackRouter({ initialRouteName: 'ExpenseBehavior' });
  const insightsOptions = { routeNames: ['ExpenseBehavior', 'RecoveryTarget'], routeParamList: {}, routeGetIdList: {} };
  let insights = insightsRouter.getInitialState(insightsOptions);
  const tabsRouter = TabRouter({ initialRouteName: 'Insights', backBehavior: 'history' });
  const tabsOptions = { routeNames: ['Dashboard', 'Records', 'Insights', 'More'], routeParamList: {}, routeGetIdList: {} };
  let tabs = tabsRouter.getInitialState(tabsOptions);

  function dispatchRecords(action: Parameters<typeof recordsRouter.getStateForAction>[1]) {
    const next = recordsRouter.getStateForAction(records, action, recordsOptions);
    if (!next) throw new Error(`Unhandled Records action ${action.type}`);
    records = recordsRouter.getRehydratedState(next, recordsOptions);
  }

  function dispatchTabs(action: Parameters<typeof tabsRouter.getStateForAction>[1]) {
    const next = tabsRouter.getStateForAction(tabs, action, tabsOptions);
    if (!next) throw new Error(`Unhandled tab action ${action.type}`);
    tabs = tabsRouter.getRehydratedState(next, tabsOptions);
  }

  const navigation = {
    getState: () => records,
    canGoBack: vi.fn(() => true),
    goBack: vi.fn(() => dispatchRecords(CommonActions.goBack())),
    reset: vi.fn((state: { index: number; routes: { name: string }[] }) => dispatchRecords(CommonActions.reset(state))),
    setParams: vi.fn((params: { from: undefined }) => dispatchRecords(CommonActions.setParams(params))),
    navigate: vi.fn((name: string, params?: object) => {
      if (tabsOptions.routeNames.includes(name)) {
        dispatchTabs(CommonActions.navigate(name, params));
        const target = params as { screen?: string; params?: object; initial?: boolean } | undefined;
        if (name === 'Records' && target?.screen) {
          expect(target.initial).toBe(false);
          dispatchRecords(CommonActions.navigate(target.screen, target.params));
        }
        if (name === 'Insights' && target?.screen) {
          const next = insightsRouter.getStateForAction(insights, CommonActions.navigate(target.screen, target.params), insightsOptions);
          if (!next) throw new Error('Unhandled insight destination');
          insights = insightsRouter.getRehydratedState(next, insightsOptions);
        }
      } else dispatchRecords(CommonActions.navigate(name, params));
    }),
  };

  return {
    navigation,
    tab: () => tabs.routes[tabs.index]!.name,
    records: () => records,
    insights: () => insights,
    tapRecords: () => dispatchTabs(TabActions.jumpTo('Records')),
    tapDashboard: () => dispatchTabs(TabActions.jumpTo('Dashboard')),
    pushImport: () => dispatchRecords(StackActions.push('ImportCsv')),
    rootFlagged: () => dispatchRecords(CommonActions.reset({ index: 0, routes: [{ name: 'FlaggedRecords' }] })),
  };
}

describe('Flagged review return navigation', () => {
  it('returns first and repeat expense reviews to the retained ExpenseBehavior route and restores RecordsList', () => {
    const j = journey();
    const expenseKey = j.insights().routes[0]!.key;
    for (let visit = 0; visit < 2; visit += 1) {
      openFlaggedRecords(j.navigation, 'ExpenseBehavior');
      expect(j.navigation.navigate).toHaveBeenLastCalledWith('Records', {
        screen: 'FlaggedRecords', initial: false, params: { from: 'ExpenseBehavior' },
      });
      expect(j.tab()).toBe('Records');
      expect(j.records().routes.map((route) => route.name)).toEqual(['RecordsList', 'FlaggedRecords']);
      returnFromFlaggedRecords(j.navigation, 'ExpenseBehavior');
      expect(j.tab()).toBe('Insights');
      expect(j.insights().routes[j.insights().index]!.name).toBe('ExpenseBehavior');
      expect(j.insights().routes[j.insights().index]!.key).toBe(expenseKey);
      j.tapRecords();
      expect(j.records().routes.map((route) => route.name)).toEqual(['RecordsList']);
    }
    expect(j.navigation.canGoBack).not.toHaveBeenCalled();
  });

  it('returns a dashboard-origin review to Home and leaves RecordsList available', () => {
    const j = journey();
    j.tapDashboard();
    openFlaggedRecords(j.navigation, 'Dashboard');
    expect(j.records().routes[j.records().index]!.params).toMatchObject({ from: 'Dashboard' });
    returnFromFlaggedRecords(j.navigation, 'Dashboard');
    expect(j.tab()).toBe('Dashboard');
    j.tapRecords();
    expect(j.records().routes.map((route) => route.name)).toEqual(['RecordsList']);
  });

  it('keeps a later direct Records entry local after a previous expense-origin visit', () => {
    const j = journey();
    openFlaggedRecords(j.navigation, 'ExpenseBehavior');
    returnFromFlaggedRecords(j.navigation, 'ExpenseBehavior');
    j.tapRecords();
    j.pushImport();
    j.navigation.navigate('FlaggedRecords', { from: undefined });
    expect(j.records().routes[j.records().index]!.params).toEqual({ from: undefined });
    returnFromFlaggedRecords(j.navigation);
    expect(j.tab()).toBe('Records');
    expect(j.records().routes[j.records().index]!.name).toBe('ImportCsv');
    expect(j.navigation.navigate).toHaveBeenLastCalledWith('FlaggedRecords', { from: undefined });
  });

  it.each(['ExpenseBehavior', 'Dashboard', undefined])('restores a legacy root RecordsList with origin %s', (origin) => {
    const j = journey();
    j.tapRecords();
    j.rootFlagged();
    returnFromFlaggedRecords(j.navigation, origin);
    expect(j.records().routes.map((route) => route.name)).toEqual(['RecordsList']);
    expect(j.tab()).toBe(origin === 'ExpenseBehavior' ? 'Insights' : origin === 'Dashboard' ? 'Dashboard' : 'Records');
    expect(j.navigation.goBack).not.toHaveBeenCalled();
    expect(j.navigation.canGoBack).not.toHaveBeenCalled();
  });
});
