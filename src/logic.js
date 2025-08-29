import { configureStore, createSlice } from '@reduxjs/toolkit';
import { createSelector } from 'reselect';
import { niceStep, computeAskPas, computeBidPas } from './util';
import broker from './broker';

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

// thunk to finalize a provisional order and track it as open
export const commitProvisional = (option) => async (dispatch, getState) => {
  const st = getState();
  const provisional = st.orders.provisional;
  if (!provisional) return;
  const premium = Math.round((option.strike + st.orders.commission - provisional.pas) * 100) / 100;
  const qty = provisional.qty;
  const pas = provisional.pas;
  dispatch(ordersSlice.actions.clearProvisional());
  const res = await broker.openOrder({ option: { ...option }, limitPrice: premium, qty });
  if (res?.ok) {
    dispatch(ordersSlice.actions.addOpenOrder({ id: res.orderId, optionId: option.id, qty, limitPrice: premium, pas }));
  } else {
    alert('Order not filled (simulated). Try closer to bid or higher bid size.');
  }
};

// thunk to cancel an open order
export const cancelOpenOrder = (id) => async (dispatch) => {
  const res = await broker.cancelOrder(id);
  if (res?.ok) {
    dispatch(ordersSlice.actions.removeOpenOrder(id));
  } else {
    alert('Cancel failed (mock)');
  }
};

export const actions = {
  ...marketSlice.actions,
  ...ordersSlice.actions,
  ...settingsSlice.actions,
  commitProvisional,
  cancelOpenOrder
};

export const store = configureStore({
  reducer: { market: marketSlice.reducer, orders: ordersSlice.reducer, settings: settingsSlice.reducer }
});

export const selectMarket = (s) => s.market;
export const selectOrders = (s) => s.orders;
export const selectSettings = (s) => s.settings;
export const selectPriceRange = (s) => s.market.priceRange;

export const selectOptionsWithPas = createSelector(
  [s => s.market.options, selectOrders],
  (opts, orders) => (opts || []).map(o => ({
    ...o,
    askPAS: computeAskPas(o.strike, o.askPremium, orders.commission),
    bidPAS: computeBidPas(o.strike, o.bidPremium, orders.commission)
  }))
);

export const selectFilteredOptions = createSelector(
  [selectOptionsWithPas, selectSettings],
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

