/**
 * BrokerAdapter is the single interface between the front-end (Redux + React)
 * and any source of market/account/order data. It is modeled on IB's own
 * request/subscribe/event semantics (see @stoqey/ib) rather than on the shape
 * of the original client-side simulator, so that a simulated adapter and a
 * real IB Gateway adapter are interchangeable behind it.
 *
 * Every implementation (SimBrokerAdapter, IbBrokerAdapter, IpcBrokerClient)
 * must be safe to import from the browser bundle EXCEPT IbBrokerAdapter,
 * which uses Node sockets and only ever runs in the Electron main process.
 */

import type { TradingSession } from './marketClock';

export type { TradingSession };

export type TradingMode = 'sim-client' | 'ib-paper' | 'ib-live-confirm' | 'ib-live';

export interface OptionContract {
  conId: number;
  symbol: string;
  strike: number;
  right: 'P';
  expiry: string; // YYYYMMDD
  exchange: string;
  currency: string;
  multiplier: number;
}

/**
 * probITM has no direct IB field. It is derived from the option's model
 * delta (generic tick 106 / tickOptionComputation): for a put,
 * probITM ~= |delta| * 100. The simulator approximates the same 0..100 scale
 * with its own sigmoid so downstream selectors need no special-casing.
 */
export interface OptionQuote {
  id: string; // stable key, `put-${strike}`, used as React key + order linkage
  conId: number;
  strike: number;
  expiry: string;
  bidPremium: number;
  askPremium: number;
  bidSize: number;
  askSize: number;
  probITM: number; // 0..100
  time: number; // ms epoch
}

export interface UnderlyingTick {
  conId: number;
  price: number;
  time: number;
}

export interface AccountSummary {
  accountId: string;
  availableFunds: number;
  netLiquidation: number;
  buyingPower: number;
  currency: string;
}

export type OrderStatus =
  /** Placed with transmit:false — sitting at the broker awaiting OUR submit. */
  | 'Draft'
  /**
   * Accepted by the broker but parked pending a manual confirmation only the
   * broker's own UI can give (e.g. IB error 163, a precautionary price
   * constraint). Distinct from Draft: the app cannot clear this one.
   */
  | 'Held'
  | 'PendingSubmit'
  | 'PreSubmitted'
  | 'Submitted'
  | 'Filled'
  | 'Cancelled'
  | 'Inactive'
  | 'Rejected';

export interface OrderState {
  id: string; // stringified IB orderId, or ORD-... in sim mode
  conId: number;
  optionId: string;
  action: 'SELL';
  qty: number;
  limitPrice: number;
  status: OrderStatus;
  filled: number;
  remaining: number;
  avgFillPrice: number | null;
  transmitted: boolean;
  message?: string;
}

export interface ConnectionInfo {
  mode: TradingMode;
  connected: boolean;
  accountId: string | null;
  fellBackFrom?: TradingMode;
  reason?: string;
}

export interface SetUnderlyingResult {
  symbol: string;
  conId: number;
  expiry: string; // YYYYMMDD
  expiryIsToday: boolean;
  /**
   * Trading sessions for this contract as absolute epoch-ms ranges, taken
   * from the broker's own schedule where available (IB's ContractDetails
   * liquidHours). Empty when the broker cannot supply one — e.g. the
   * simulator, or IB with "Expose entire trading schedule to API" disabled —
   * in which case the UI falls back to assuming a regular 09:30-16:00 ET day.
   */
  sessions: TradingSession[];
}

export interface PlaceOrderRequest {
  optionId: string;
  conId: number;
  qty: number;
  limitPrice: number;
}

export interface BrokerError {
  code?: number;
  message: string;
}

export type BrokerEventMap = {
  underlyingTick: UnderlyingTick;
  optionQuotes: OptionQuote[];
  orderUpdate: OrderState;
  accountUpdate: AccountSummary;
  connectionStatus: ConnectionInfo;
  error: BrokerError;
};

export type BrokerEvent = keyof BrokerEventMap;

export interface BrokerAdapter {
  connect(): Promise<ConnectionInfo>;
  disconnect(): Promise<void>;
  setUnderlying(symbol: string): Promise<SetUnderlyingResult>;
  subscribeMarketData(): void;
  unsubscribeMarketData(): void;
  placeOrder(req: PlaceOrderRequest): Promise<OrderState>;
  /**
   * Transmits an order previously placed with transmit:false (status Draft).
   * Only meaningful in ib-live-confirm; a no-op elsewhere. Cannot clear a
   * Held order — that confirmation lives in the broker's own UI.
   */
  transmitOrder(orderId: string): Promise<void>;
  cancelOrder(orderId: string): Promise<void>;
  getAccountSummary(): Promise<AccountSummary>;
  on<E extends BrokerEvent>(event: E, fn: (payload: BrokerEventMap[E]) => void): () => void;
}
