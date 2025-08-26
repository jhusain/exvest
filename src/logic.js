import { configureStore, createSlice } from '@reduxjs/toolkit';
import { createSelector } from 'reselect';

/** === constants for tag layout === */
export const TAG_ROW_H = 24;
export const TAG_TOP_PAD = 6;
export const TAG_HEIGHT = 22;

/** === utilities (Perlin + helpers) === */
export function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export class Perlin1D {
  constructor(seed = 1) {
    this.rand = mulberry32(seed);
    this.grad = [...Array(512)].map(() => this.rand() * 2 - 1);
  }
  fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }
  lerp(a, b, t) {
    return a + (b - a) * t;
  }
  noise(x) {
    const X = Math.floor(x) & 255;
    const xf = x - Math.floor(x);
    const g0 = this.grad[X];
    const g1 = this.grad[(X + 1) & 255];
    const u = this.fade(xf);
    return this.lerp(g0 * xf, g1 * (xf - 1), u);
  }
}
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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

/** === fake brokerage with Perlin-based streams + mock orders === */
export const mkBroker = (seed = 42) => {
  const noise = new Perlin1D(seed);
  let t = 0,
    base = 100,
    vol = 1.2;
  const listeners = new Set();
  const orders = new Map();

  function tick() {
    t += 0.05;
    base = base + noise.noise(t) * 0.35;
    const price = clamp(base + noise.noise(t * 0.25) * vol, 5, 2000);
    const now = Date.now();
    const opts = synthOptions(price, now);
    listeners.forEach((fn) => fn({ price, now, options: opts }));
  }
  let h = null;

  return {
    start() {
      if (!h) {
        h = setInterval(tick, 600);
        tick();
      }
    },
    stop() {
      if (h) {
        clearInterval(h);
        h = null;
      }
    },
    onUpdate(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async openOrder({ option, limitPrice, qty }) {
      const spread = Math.max(0.01, option.bidPremium - option.askPremium);
      const closeness = clamp(1 - (option.bidPremium - limitPrice) / spread, 0, 1);
      const sizeFactor = clamp(option.bidSize / 50, 0, 1);
      const p = 0.15 + 0.6 * closeness + 0.25 * sizeFactor;
      await new Promise((r) => setTimeout(r, 350 + Math.random() * 500));
      if (Math.random() >= p) return { ok: false };
      const orderId = `ORD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      orders.set(orderId, { option, limitPrice, qty, created: Date.now() });
      return { ok: true, orderId };
    },
    async cancelOrder(orderId) {
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 400));
      if (!orders.has(orderId)) return { ok: false, reason: 'not_found' };
      const ok = Math.random() < 0.95;
      if (ok) orders.delete(orderId);
      return { ok };
    }
  };
};

export function synthOptions(under, now) {
  const commission = 0.75;
  const MIN_PREMIUM_SPREAD = 7;
  const arr = [];
  const startStrike = Math.ceil(under * 1.01);
  const perlinOpt = new Perlin1D(9001);
  const round2 = (n) => Math.round(n * 100) / 100;
  for (let i = 0; i < 12; i++) {
    const strike = startStrike + i;
    const intrinsic = Math.max(0, strike - under);
    const timeExtr = clamp(0.35 + i / 12, 0.1, 3.0);
    const n = perlinOpt.noise(now * 0.0008 + i * 0.2);
    let askPremium = intrinsic + 0.1 + timeExtr * 0.5 + n * 0.15;
    if (askPremium < MIN_PREMIUM_SPREAD + 0.01) askPremium = MIN_PREMIUM_SPREAD + 0.01;
    let bidPremium = askPremium - (0.05 + 0.15 * Math.exp(-i / 3)) + n * 0.05;
    if (askPremium - bidPremium < MIN_PREMIUM_SPREAD) bidPremium = askPremium - MIN_PREMIUM_SPREAD;
    askPremium = clamp(askPremium, 0.05, 1000);
    bidPremium = clamp(bidPremium, 0.01, askPremium - 0.01);
    const bidSize = Math.max(1, Math.round((12 - i) * (0.5 + Math.random())));
    const depth = (strike - under) / Math.max(under * 0.01, 0.5);
    const sigmoid = 1 / (1 + Math.exp(-0.6 * depth));
    const probITM = clamp(0.65 + 0.35 * sigmoid + 0.05 * (bidSize / 20), 0.5, 0.995);
    const askPAS = strike - askPremium + commission;
    const bidPAS = strike - bidPremium + commission;
    arr.push({
      id: `put-${strike}`,
      strike,
      bidSize,
      probITM: Math.round(probITM * 100),
      askPremium: round2(askPremium),
      bidPremium: round2(bidPremium),
      askPAS: round2(askPAS),
      bidPAS: round2(bidPAS)
    });
  }
  return arr;
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

/** expose single broker instance */
export const broker = mkBroker(1337);
