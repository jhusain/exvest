import { describe, it, expect, afterEach } from 'vitest';
import { store, actions, selectFilteredOptions, selectOptionPasBounds } from '../src/logic';
import type { OptionQuote } from '../src/shared/types';

describe('PAS computation', () => {
  it('derives PAS values when missing from broker data', () => {
    const option: OptionQuote = {
      id: 'put-101',
      conId: 1,
      strike: 101,
      expiry: '20260101',
      bidSize: 10,
      askSize: 10,
      probITM: 90,
      askPremium: 7,
      bidPremium: 6.5,
      time: 0
    };
    store.dispatch(actions.underlyingTick({ price: 100, time: 0 }));
    store.dispatch(actions.optionQuotes([option]));
    const opts = selectFilteredOptions(store.getState());
    expect(opts).toHaveLength(1);
    const computed = opts[0];
    const commission = store.getState().orders.commission;
    expect(computed.askPAS).toBeCloseTo(101 - 7 + commission, 2);
    expect(computed.bidPAS).toBeCloseTo(101 - 6.5 + commission, 2);
    const bounds = selectOptionPasBounds(store.getState());
    expect(bounds.min).toBeCloseTo(computed.askPAS, 2);
    expect(bounds.max).toBeCloseTo(computed.bidPAS, 2);
  });
});

afterEach(() => {
  store.dispatch(actions.optionQuotes([]));
});
