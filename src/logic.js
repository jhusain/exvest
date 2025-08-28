import { configureStore, createSlice } from '@reduxjs/toolkit';

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

