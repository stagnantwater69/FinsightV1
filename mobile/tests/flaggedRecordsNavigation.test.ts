import { CommonActions, StackActions, StackRouter, TabActions, TabRouter } from '@react-navigation/routers';
import { describe, expect, it, vi } from 'vitest';
import { openFlagDetail, openReviewTab, returnFromFlagDetail } from '../src/lib/flaggedRecordsNavigation';
import type { RecordItem } from '../src/lib/types';

function journey() {
  const recordsRouter = StackRouter({ initialRouteName: 'RecordsList' });
  const recordsOptions = { routeNames: ['RecordsList', 'FlagDetail', 'ImportCsv'], routeParamList: {}, routeGetIdList: {} };
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
    rootDetail: () => dispatchRecords(CommonActions.reset({ index: 0, routes: [{ name: 'FlagDetail' }] })),
  };
}

const record = { id: 201, type: 'expense' } as RecordItem;

describe('Review tab navigation', () => {
  it('opens a flagged record and returns to the retained Review tab, leaving Records on its list', () => {
    const j = journey();
    const expenseKey = j.insights().routes[0]!.key;
    for (let visit = 0; visit < 2; visit += 1) {
      openFlagDetail(j.navigation, record);
      expect(j.navigation.navigate).toHaveBeenLastCalledWith('Records', {
        screen: 'FlagDetail', initial: false, params: { record },
      });
      expect(j.tab()).toBe('Records');
      expect(j.records().routes.map((route) => route.name)).toEqual(['RecordsList', 'FlagDetail']);
      returnFromFlagDetail(j.navigation);
      expect(j.tab()).toBe('Insights');
      const current = j.insights().routes[j.insights().index]!;
      expect(current.name).toBe('ExpenseBehavior');
      expect(current.key).toBe(expenseKey);
      expect(current.params).toMatchObject({ section: 'alerts' });
      j.tapRecords();
      expect(j.records().routes.map((route) => route.name)).toEqual(['RecordsList']);
    }
  });

  it('opens the Review tab from another tab', () => {
    const j = journey();
    j.tapDashboard();
    openReviewTab(j.navigation);
    expect(j.tab()).toBe('Insights');
    expect(j.navigation.navigate).toHaveBeenLastCalledWith('Insights', { screen: 'ExpenseBehavior', params: { section: 'alerts' } });
  });

  it('restores a root RecordsList when a record was the only screen in the stack', () => {
    const j = journey();
    j.tapRecords();
    j.rootDetail();
    returnFromFlagDetail(j.navigation);
    expect(j.records().routes.map((route) => route.name)).toEqual(['RecordsList']);
    expect(j.tab()).toBe('Insights');
    expect(j.navigation.goBack).not.toHaveBeenCalled();
  });
});
