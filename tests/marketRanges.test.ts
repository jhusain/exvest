import { describe, it, expect } from 'vitest';
import { store, actions } from '../src/logic';

/**
 * Regression cover for the axis scale being built from the placeholder price.
 * initRanges used to run on a fixed 700ms timer, which fired long before the
 * first real quote when IB had to negotiate delayed data — leaving a $100
 * scale and a $740 underlying clamped off the chart.
 */
describe('market axis ranges', () => {
  it('rescales on the first real tick rather than keeping the placeholder scale', () => {
    // Placeholder scale the store starts with.
    expect(store.getState().market.priceRange).toEqual({ min: 60, max: 140 });

    store.dispatch(actions.underlyingTick({ price: 740.4, time: Date.now() }));

    const { priceRange, fixedRange } = store.getState().market;
    expect(fixedRange).toEqual({ min: 0, max: 740.4 * 2 });
    // 740.4 +/- 40% => the strikes near the money are comfortably on screen.
    expect(priceRange.min).toBeCloseTo(740.4 - 740.4 * 0.4, 6);
    expect(priceRange.max).toBeCloseTo(740.4 + 740.4 * 0.4, 6);
    expect(740.4).toBeGreaterThan(priceRange.min);
    expect(740.4).toBeLessThan(priceRange.max);
  });

  it('keeps the scale stable across subsequent ticks', () => {
    const before = store.getState().market.priceRange;
    store.dispatch(actions.underlyingTick({ price: 741.2, time: Date.now() }));
    expect(store.getState().market.priceRange).toEqual(before);
  });

  it('rebuilds the scale when the price leaves it entirely', () => {
    store.dispatch(actions.underlyingTick({ price: 5000, time: Date.now() }));
    const { priceRange } = store.getState().market;
    expect(5000).toBeGreaterThan(priceRange.min);
    expect(5000).toBeLessThan(priceRange.max);
  });
});
