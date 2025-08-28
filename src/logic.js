import { configureStore, createSlice } from '@reduxjs/toolkit';
import { createSelector } from 'reselect';

/** === constants for tag layout === */
export const TAG_ROW_H = 24;
export const TAG_TOP_PAD = 6;
export const TAG_HEIGHT = 22;

/** === utilities === */
/** pretty grid spacing */
export function niceStep(_pxPerTick, approx) {
  const steps = [1, 2, 5];
  let n = Math.pow(10, Math.floor(Math.log10(Math.max(approx, 1e-6))));
  let best = steps[0] * n,
    err = Infinity;
  for (const k of steps) {
    for (const m of [n / 10, n, n * 10, n * 100]) {
      const s = k * m,
        e = Math.abs(s - approx);
      if (e < err) {
        err = e;
        best = s;
      }
    }
  }
  return Math.max(best, 0.01);
}

export function priceColor(curr, prev) {
  if (prev == null || curr === prev) return 'white';
  return curr > prev ? 'green' : 'red';
}

/** Estimate tag width for stacking */
export function estimateTagWidth(text) {
  const len = String(text || '').length;
  return Math.max(48, 12 + len * 8 + 12);
}

/** Stack tags greedily to avoid overlap */
export function layoutTags(tags, width) {
  const ordered = tags.slice().sort((a, b) => a.x - b.x);
  const rowEnds = [];
  const placed = [];
  for (const t of ordered) {
    const w = estimateTagWidth(t.text);
    const left = t.x - w / 2;
    let row = 0;
    while (true) {
      if (rowEnds[row] == null || left > rowEnds[row] + 6) {
        rowEnds[row] = left + w;
        break;
      }
      row++;
    }
    placed.push({ ...t, top: TAG_TOP_PAD + row * TAG_ROW_H, row });
  }
  return placed;
}
export function layoutTagsGrouped(groups, width) {
  const all = [];
  let base = 0;
  let totalRows = 0;
  for (const g of groups) {
    const placed = layoutTags(g, width);
    let maxRow = -1;
    for (const p of placed) {
      all.push({ ...p, top: TAG_TOP_PAD + (base + p.row) * TAG_ROW_H, row: base + p.row });
      maxRow = Math.max(maxRow, p.row);
    }
    const used = Math.max(1, maxRow + 1);
    base += used;
    totalRows += used;
  }
  return { placed: all, totalRows };
}

/** === Redux slices === */
const marketSlice = createSlice({
  name: 'market',
  initialState: { symbol: 'SPY', price: 100, lastTs: 0, history: [], options: [], priceRange: { min: 60, max: 140 }, fixedRange: { min: 0, max: 200 } },
  reducers: {
    setSymbol(s, a) { s.symbol = a.payload; },
    streamUpdate(s, a) {
      const { price, now, options } = a.payload;
      s.price = price; s.lastTs = now; s.options = options;
      s.history.push({ t: now, p: price }); if (s.history.length > 300) s.history.shift();
    },
    initRanges(s) {
      const twoX = s.price * 2;
      s.fixedRange = { min: 0, max: twoX };
      const span = s.price * 0.8;
      s.priceRange = { min: Math.max(0, s.price - span / 2), max: s.price + span / 2 };
    },
    setPriceViewport(s, a) { const { min, max } = a.payload; s.priceRange = { min, max }; }
  }
});

const ordersSlice = createSlice({
  name: 'orders',
  initialState: { commission: 0.75, availableCash: 100000, openOrders: [], provisional: null },
  reducers: {
    setProvisional(s, a) { s.provisional = a.payload; },
    clearProvisional(s) { s.provisional = null; },
    addOpenOrder(s, a) { s.openOrders.push(a.payload); },
    removeOpenOrder(s, a) { s.openOrders = s.openOrders.filter(o => o.id !== a.payload); }
  }
});

const settingsSlice = createSlice({
  name: 'settings',
  initialState: { minProbITM: 80, minBidSize: 1, depthMode: 'bidSize', timeWindowMin: 30 },
  reducers: {}
});

export const actions = {
  ...marketSlice.actions,
  ...ordersSlice.actions,
  ...settingsSlice.actions
};

export const store = configureStore({
  reducer: { market: marketSlice.reducer, orders: ordersSlice.reducer, settings: settingsSlice.reducer }
});

/** === selectors (reselect) === */
export const selectMarket = (s) => s.market;
export const selectOrders = (s) => s.orders;
export const selectSettings = (s) => s.settings;
export const selectPriceRange = (s) => s.market.priceRange;

export const selectFilteredOptions = createSelector(
  [s => s.market.options, selectSettings],
  (opts, settings) => (opts || []).filter(o => o.probITM >= settings.minProbITM && o.bidSize >= settings.minBidSize)
);

export const makePasToX = () => createSelector(
  [selectPriceRange, (_s, width) => Math.max(1, width || 1)],
  (range, width) => {
    const span = Math.max(0.01, range.max - range.min);
    return (pas) => ((pas - range.min) / span) * width;
  }
);

export const makeGridlinesPx = () => createSelector(
  [selectPriceRange, (_s, width) => Math.max(1, width || 1)],
  (range, width) => {
    const desiredPx = 90;
    const step = niceStep(1, (range.max - range.min) / Math.max(1, Math.floor(width / desiredPx)));
    const start = Math.ceil(range.min / step) * step;
    const arr = [];
    for (let v = start; v <= range.max + 1e-6; v += step) arr.push(Math.round(v * 100) / 100);
    return { values: arr, toPx: (pas) => ((pas - range.min) / (range.max - range.min)) * width, step };
  }
);

export const selectOptionPasBounds = createSelector([selectFilteredOptions], (opts) => {
  if (!opts || !opts.length) return { min: null, max: null };
  return { min: Math.min(...opts.map(o => o.askPAS)), max: Math.max(...opts.map(o => o.bidPAS)) };
});
