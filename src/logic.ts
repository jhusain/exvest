import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createSelector } from 'reselect';
import { niceStep, computeAskPas, computeBidPas } from './shared/pas';
import type {
  AccountSummary,
  BrokerAdapter,
  ConnectionInfo,
  OptionQuote,
  OrderState,
  TradingMode,
  TradingSession
} from './shared/types';

export interface OpenOrderView {
  id: string;
  optionId: string;
  conId: number;
  qty: number;
  limitPrice: number;
  pas: number;
  status: OrderState['status'];
  filled: number;
  remaining: number;
}

export interface ProvisionalOrder {
  id: string;
  optionId: string;
  limitPrice: number;
  pas: number;
  qty: number;
  strike: number;
}

interface MarketState {
  symbol: string;
  price: number;
  lastTs: number;
  history: { t: number; p: number }[];
  options: OptionQuote[];
  expiry: string | null;
  expiryIsToday: boolean;
  sessions: TradingSession[];
  priceRange: { min: number; max: number };
  fixedRange: { min: number; max: number };
  /** Whether the axis scale has been derived from a real price yet. */
  rangesInitialized: boolean;
  /** False once the user pans/zooms, so auto-fitting stops fighting them. */
  autoRange: boolean;
}

/**
 * Derives the axis scales from the current price. Kept separate so it can run
 * both from the explicit action and automatically on the first real tick.
 */
function applyRanges(s: MarketState) {
  const twoX = s.price * 2;
  s.fixedRange = { min: 0, max: twoX };
  const span = s.price * 0.8;
  s.priceRange = { min: Math.max(0, s.price - span / 2), max: s.price + span / 2 };
}

const marketSlice = createSlice({
  name: 'market',
  initialState: {
    symbol: 'SPY',
    price: 100,
    lastTs: 0,
    history: [],
    options: [],
    expiry: null,
    expiryIsToday: false,
    sessions: [],
    priceRange: { min: 60, max: 140 },
    fixedRange: { min: 0, max: 200 },
    rangesInitialized: false,
    autoRange: true
  } as MarketState,
  reducers: {
    setSymbol(s, a: PayloadAction<string>) {
      s.symbol = a.payload;
      // A different instrument needs a scale of its own.
      s.rangesInitialized = false;
    },
    setExpiry(s, a: PayloadAction<{ expiry: string; expiryIsToday: boolean; sessions: TradingSession[] }>) {
      s.expiry = a.payload.expiry;
      s.expiryIsToday = a.payload.expiryIsToday;
      s.sessions = a.payload.sessions;
    },
    underlyingTick(s, a: PayloadAction<{ price: number; time: number }>) {
      const { price, time } = a.payload;
      s.price = price;
      s.lastTs = time;
      s.history.push({ t: time, p: price });
      if (s.history.length > 300) s.history.shift();

      // The axis scale must come from a real price, not the placeholder the
      // store starts with. A fixed timer cannot do this: the first quote can
      // be many seconds out when the delayed-data fallback has to negotiate
      // first, and a scale built for $100 leaves a $740 underlying (and every
      // strike near it) clamped off the edge of the chart.
      if (!s.rangesInitialized && price > 0) {
        applyRanges(s);
        s.rangesInitialized = true;
      } else if (price > 0 && (price < s.fixedRange.min || price > s.fixedRange.max)) {
        // Price has left the scale entirely — the axis is for a different
        // instrument (e.g. the symbol changed). Rebuild rather than clamp.
        applyRanges(s);
      }
    },
    optionQuotes(s, a: PayloadAction<OptionQuote[]>) {
      s.options = a.payload;
    },
    initRanges(s) {
      applyRanges(s);
      s.rangesInitialized = true;
    },
    setPriceViewport(s, a: PayloadAction<{ min: number; max: number }>) {
      s.priceRange = a.payload;
      // An explicit viewport change is the user taking control.
      s.autoRange = false;
    },

    /**
     * Fits the axis to where the option PAS values actually are.
     *
     * Scaling from the underlying price alone does not work for this
     * strategy: every PAS is `strike - premium + commission`, which for a
     * near-the-money chain clusters within a dollar or so. A price-derived
     * span (740 +/- 40% => ~$590 wide) squeezes that entire cluster into
     * well under a pixel, which is why the bid/ask rectangles were invisible.
     */
    fitRangeToPas(s, a: PayloadAction<{ min: number; max: number; price: number }>) {
      if (!s.autoRange) return;
      const lo = Math.min(a.payload.min, a.payload.price);
      const hi = Math.max(a.payload.max, a.payload.price);
      // Floor the span so a chain whose PAS values coincide does not zoom to
      // an absurd magnification.
      const span = Math.max(hi - lo, Math.max(0.5, a.payload.price * 0.002));
      const pad = span * 0.25;
      s.priceRange = { min: lo - pad, max: hi + pad };
      // The pan/zoom extent stays a comfortable multiple of the data span, so
      // the viewport handle in the overview bar remains grabbable.
      s.fixedRange = { min: Math.max(0, lo - span * 8), max: hi + span * 8 };
      s.rangesInitialized = true;
    }
  }
});

const ORDER_FIELDS = ['status', 'qty', 'limitPrice', 'filled', 'remaining', 'optionId', 'conId', 'pas'] as const;
type OrderField = (typeof ORDER_FIELDS)[number];

const applyOrderFields = (target: OpenOrderView, update: Partial<OpenOrderView>) => {
  for (const field of ORDER_FIELDS as readonly OrderField[]) {
    if (Object.prototype.hasOwnProperty.call(update, field)) {
      (target as any)[field] = (update as any)[field];
    }
  }
};

interface OrdersState {
  commission: number;
  availableCash: number;
  openOrders: OpenOrderView[];
  provisional: ProvisionalOrder | null;
}

const ordersSlice = createSlice({
  name: 'orders',
  initialState: {
    commission: 0.75,
    availableCash: 100000,
    openOrders: [],
    provisional: null
  } as OrdersState,
  reducers: {
    setProvisional(s, a: PayloadAction<ProvisionalOrder | null>) {
      s.provisional = a.payload;
    },
    clearProvisional(s) {
      s.provisional = null;
    },
    setAvailableCash(s, a: PayloadAction<number>) {
      s.availableCash = a.payload;
    },
    mergeOrders(s, a: PayloadAction<Partial<OpenOrderView>[]>) {
      const updates = Array.isArray(a.payload) ? a.payload : [];
      if (!updates.length) return;

      const byId = new Map(s.openOrders.map((order) => [order.id, order]));

      for (const upd of updates) {
        if (!upd || upd.id === undefined || upd.id === null) continue;
        const existing = byId.get(upd.id);
        if (existing) {
          applyOrderFields(existing, upd);
        } else {
          const newOrder = { id: upd.id } as OpenOrderView;
          applyOrderFields(newOrder, upd);
          s.openOrders.push(newOrder);
          byId.set(newOrder.id, newOrder);
        }
      }
      s.openOrders = s.openOrders.filter((o) => o.status !== 'Cancelled' && o.status !== 'Rejected');
    }
  }
});

interface SettingsState {
  minProbITM: number;
  minBidSize: number;
  depthMode: string;
  timeWindowMin: number;
}

const settingsSlice = createSlice({
  name: 'settings',
  initialState: { minProbITM: 80, minBidSize: 1, depthMode: 'bidSize', timeWindowMin: 30 } as SettingsState,
  reducers: {}
});

interface ConnectionState {
  mode: TradingMode;
  connected: boolean;
  accountId: string | null;
  fellBackFrom?: TradingMode;
  reason?: string;
}

const connectionSlice = createSlice({
  name: 'connection',
  initialState: { mode: 'sim-client', connected: false, accountId: null } as ConnectionState,
  reducers: {
    connectionStatus(_s, a: PayloadAction<ConnectionInfo>) {
      return { ...a.payload };
    }
  }
});

export interface ToastItem {
  id: string;
  message: string;
}

interface ToastState {
  /** Newest last; the host renders them stacked from the bottom-right. */
  items: ToastItem[];
}

let toastSeq = 0;

/** Cap on simultaneously visible toasts. */
const MAX_VISIBLE_TOASTS = 5;

const toastSlice = createSlice({
  name: 'toast',
  initialState: { items: [] } as ToastState,
  reducers: {
    showToast(s, a: PayloadAction<string>) {
      s.items.push({ id: `t${++toastSeq}`, message: a.payload });
      // A burst of per-contract errors should not bury the screen.
      if (s.items.length > MAX_VISIBLE_TOASTS) s.items.splice(0, s.items.length - MAX_VISIBLE_TOASTS);
    },
    dismissToast(s, a: PayloadAction<string>) {
      s.items = s.items.filter((t) => t.id !== a.payload);
    },
    clearToast(s) {
      s.items = [];
    }
  }
});

interface SessionState {
  liveOrderAcknowledged: boolean;
  pendingLiveConfirm: { optionId: string; qty: number } | null;
}

const sessionSlice = createSlice({
  name: 'session',
  initialState: { liveOrderAcknowledged: false, pendingLiveConfirm: null } as SessionState,
  reducers: {
    setPendingLiveConfirm(s, a: PayloadAction<{ optionId: string; qty: number } | null>) {
      s.pendingLiveConfirm = a.payload;
    },
    acknowledgeLiveOrder(s) {
      s.liveOrderAcknowledged = true;
      s.pendingLiveConfirm = null;
    }
  }
});

/**
 * The active BrokerAdapter is created at runtime (web build vs. Electron, and
 * whether IB Gateway was reachable), so it can't be a static import like the
 * old broker.js singleton. RootApp calls setBroker() once during bootstrap,
 * and again if it swaps to the sim fallback after an IB disconnect.
 */
let activeBroker: BrokerAdapter | null = null;
export function setBroker(broker: BrokerAdapter): void {
  activeBroker = broker;
}
function getBroker(): BrokerAdapter {
  if (!activeBroker) throw new Error('Broker not initialized — call setBroker() before dispatching broker thunks');
  return activeBroker;
}

// thunk to finalize a provisional order and track it as open
export const commitProvisional = (option: OptionQuote) => async (dispatch: any, getState: any) => {
  const st = getState();
  const provisional: ProvisionalOrder | null = st.orders.provisional;
  if (!provisional) return;
  const commission = st.orders.commission;
  const premium = Math.round((option.strike + commission - provisional.pas) * 100) / 100;
  const qty = provisional.qty;
  dispatch(ordersSlice.actions.clearProvisional());

  const mode: TradingMode = st.connection.mode;
  if (mode === 'ib-live' && !st.session.liveOrderAcknowledged) {
    dispatch(sessionSlice.actions.setPendingLiveConfirm({ optionId: option.id, qty }));
    // Stash the pending request so the confirmation modal can resume it.
    pendingCommit = { option, premium, qty };
    return;
  }

  await placeOrderAndTrack(dispatch, option, premium, qty);
};

let pendingCommit: { option: OptionQuote; premium: number; qty: number } | null = null;

// Only the broker's 'orderUpdate' event (see applyOrderUpdate below) ever adds
// an order to openOrders — placeOrder's own resolved value is used solely to
// decide whether to toast a rejection, so a fill isn't recorded twice.
async function placeOrderAndTrack(dispatch: any, option: OptionQuote, premium: number, qty: number) {
  try {
    const res = await getBroker().placeOrder({ optionId: option.id, conId: option.conId, qty, limitPrice: premium });
    if (res.status === 'Rejected') {
      dispatch(toastSlice.actions.showToast(res.message || 'Order not filled.'));
    }
  } catch (e) {
    dispatch(toastSlice.actions.showToast('Order failed: ' + (e instanceof Error ? e.message : String(e))));
  }
}

// resumes a commitProvisional that was parked behind the mode-4 first-order confirmation
export const confirmPendingLiveOrder = () => async (dispatch: any) => {
  if (!pendingCommit) return;
  const { option, premium, qty } = pendingCommit;
  pendingCommit = null;
  dispatch(sessionSlice.actions.acknowledgeLiveOrder());
  await placeOrderAndTrack(dispatch, option, premium, qty);
};

export const cancelPendingLiveOrder = () => (dispatch: any) => {
  pendingCommit = null;
  dispatch(sessionSlice.actions.setPendingLiveConfirm(null));
};

// thunk to cancel an open order. Removal from openOrders happens via the
// broker's 'orderUpdate' event (status: 'Cancelled'), not here directly —
// cancelOrder() rejects if the cancel didn't actually succeed, so we must
// not optimistically remove the order ourselves.
export const cancelOpenOrder = (id: string) => async (dispatch: any) => {
  try {
    await getBroker().cancelOrder(id);
  } catch (e) {
    dispatch(toastSlice.actions.showToast('Cancel failed: ' + (e instanceof Error ? e.message : String(e))));
  }
};

/** Transmits a staged (Draft) order. Held orders have no submit path here. */
export const transmitOpenOrder = (id: string) => async (dispatch: any) => {
  try {
    await getBroker().transmitOrder(id);
  } catch (e) {
    dispatch(toastSlice.actions.showToast('Submit failed: ' + (e instanceof Error ? e.message : String(e))));
  }
};

// applies a broker orderUpdate event to the openOrders list
export const applyOrderUpdate = (order: OrderState) => (dispatch: any, getState: any) => {
  const st = getState();
  const existing = st.orders.openOrders.find((o: OpenOrderView) => o.id === order.id);
  const update: Partial<OpenOrderView> = {
    id: order.id,
    optionId: order.optionId,
    conId: order.conId,
    qty: order.qty,
    limitPrice: order.limitPrice,
    status: order.status,
    filled: order.filled,
    remaining: order.remaining
  };
  if (!existing) {
    // pas is a UI-derived concept (strike - premium + commission), not part of the
    // broker's OrderState. Derive it for orders we haven't seen before (e.g. a
    // resting order discovered via IB's order snapshot on reconnect); status-only
    // updates for orders we already track leave the original pas untouched.
    const match: OptionQuote | undefined = st.market.options.find((o: OptionQuote) => o.id === order.optionId);
    update.pas = match ? computeAskPas(match.strike, order.limitPrice, st.orders.commission) : order.limitPrice;
  }
  dispatch(ordersSlice.actions.mergeOrders([update]));
};

export const applyAccountUpdate = (account: AccountSummary) => (dispatch: any) => {
  dispatch(ordersSlice.actions.setAvailableCash(account.availableFunds));
};

export const applyBrokerError = (err: { code?: number; message: string }) => (dispatch: any) => {
  dispatch(toastSlice.actions.showToast(err.message));
};

export const actions = {
  ...marketSlice.actions,
  ...ordersSlice.actions,
  ...settingsSlice.actions,
  ...connectionSlice.actions,
  ...sessionSlice.actions,
  ...toastSlice.actions,
  commitProvisional,
  cancelOpenOrder,
  transmitOpenOrder,
  confirmPendingLiveOrder,
  cancelPendingLiveOrder,
  applyOrderUpdate,
  applyAccountUpdate,
  applyBrokerError
};

export const ordersReducer = ordersSlice.reducer;

export const store = configureStore({
  reducer: {
    market: marketSlice.reducer,
    orders: ordersSlice.reducer,
    settings: settingsSlice.reducer,
    connection: connectionSlice.reducer,
    session: sessionSlice.reducer,
    toast: toastSlice.reducer
  }
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const selectMarket = (s: RootState) => s.market;
export const selectOrders = (s: RootState) => s.orders;
export const selectSettings = (s: RootState) => s.settings;
export const selectConnection = (s: RootState) => s.connection;
export const selectSession = (s: RootState) => s.session;
export const selectToast = (s: RootState) => s.toast;
export const selectPriceRange = (s: RootState) => s.market.priceRange;

export interface OptionsWithPas extends OptionQuote {
  askPAS: number;
  bidPAS: number;
}

export const selectOptionsWithPas = createSelector(
  [(s: RootState) => s.market.options, selectOrders],
  (opts, orders): OptionsWithPas[] =>
    (opts || []).map((o) => ({
      ...o,
      askPAS: computeAskPas(o.strike, o.askPremium, orders.commission),
      bidPAS: computeBidPas(o.strike, o.bidPremium, orders.commission)
    }))
);

export const selectFilteredOptions = createSelector([selectOptionsWithPas, selectSettings], (opts, settings) =>
  (opts || []).filter((o) => o.probITM >= settings.minProbITM && o.bidSize >= settings.minBidSize)
);

export const makePasToX = () =>
  createSelector(
    [selectPriceRange, (_s: RootState, width: number) => Math.max(1, width || 1)],
    (range, width) => {
      const span = Math.max(0.01, range.max - range.min);
      return (pas: number) => ((pas - range.min) / span) * width;
    }
  );

export const makeGridlinesPx = () =>
  createSelector(
    [selectPriceRange, (_s: RootState, width: number) => Math.max(1, width || 1)],
    (range, width) => {
      const desiredPx = 90;
      const step = niceStep(1, (range.max - range.min) / Math.max(1, Math.floor(width / desiredPx)));
      const start = Math.ceil(range.min / step) * step;
      const arr: number[] = [];
      for (let v = start; v <= range.max + 1e-6; v += step) arr.push(Math.round(v * 100) / 100);
      return { values: arr, toPx: (pas: number) => ((pas - range.min) / (range.max - range.min)) * width, step };
    }
  );

export const selectOptionPasBounds = createSelector([selectFilteredOptions], (opts) => {
  if (!opts || !opts.length) return { min: null as number | null, max: null as number | null };
  return { min: Math.min(...opts.map((o) => o.askPAS)), max: Math.max(...opts.map((o) => o.bidPAS)) };
});
