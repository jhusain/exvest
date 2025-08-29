import { describe, it, expect, afterEach } from 'vitest';
import { store, actions, selectFilteredOptions, selectOptionPasBounds } from '../src/logic';

describe('PAS computation', () => {
  it('derives PAS values when missing from broker data', () => {
    const option = {
      id: 'put-101',
      strike: 101,
      bidSize: 10,
      probITM: 90,
      askPremium: 7,
      bidPremium: 6.5
    };
    store.dispatch(actions.streamUpdate({ price: 100, now: 0, options: [option] }));
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
  store.dispatch(actions.streamUpdate({ price: 100, now: 0, options: [] }));
});
