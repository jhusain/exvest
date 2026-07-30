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

describe('fitRangeToPas', () => {
  it('fits the axis to the PAS cluster, not to a fraction of the price', () => {
    // Real SPY figures: every PAS lands within ~$0.40 of the others, while the
    // underlying is ~$740. A price-derived span made these sub-pixel.
    store.dispatch(actions.underlyingTick({ price: 740.59, time: Date.now() }));
    store.dispatch(actions.fitRangeToPas({ min: 741.09, max: 741.46, price: 740.59 }));

    const { priceRange } = store.getState().market;
    const span = priceRange.max - priceRange.min;
    // Tight enough that a $0.19 bid/ask rectangle is several percent of the
    // width rather than a fraction of a pixel.
    expect(span).toBeLessThan(5);
    expect(0.19 / span).toBeGreaterThan(0.02);
    // The whole cluster and the price remain visible.
    expect(priceRange.min).toBeLessThan(740.59);
    expect(priceRange.max).toBeGreaterThan(741.46);
  });

  it('floors the span so a degenerate cluster does not zoom absurdly', () => {
    store.dispatch(actions.fitRangeToPas({ min: 741.2, max: 741.2, price: 741.2 }));
    const { priceRange } = store.getState().market;
    expect(priceRange.max - priceRange.min).toBeGreaterThan(0.5);
  });

  it('stops auto-fitting once the user sets a viewport', () => {
    store.dispatch(actions.setPriceViewport({ min: 700, max: 800 }));
    store.dispatch(actions.fitRangeToPas({ min: 741.09, max: 741.46, price: 740.59 }));
    expect(store.getState().market.priceRange).toEqual({ min: 700, max: 800 });
  });
});
