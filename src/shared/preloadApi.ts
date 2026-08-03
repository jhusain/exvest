/**
 * The shape of window.exvest, exposed by electron/preload.ts via contextBridge.
 * IpcBrokerClient (renderer) is a thin pass-through that implements
 * BrokerAdapter purely in terms of this bridge — the renderer never talks to
 * @stoqey/ib or Node directly.
 */
import type {
  AccountSummary,
  BrokerEvent,
  BrokerEventMap,
  ConnectionInfo,
  OrderState,
  PlaceOrderRequest,
  SetUnderlyingResult
} from './types';

export interface ExvestBridge {
  connect(): Promise<ConnectionInfo>;
  disconnect(): Promise<void>;
  setUnderlying(symbol: string): Promise<SetUnderlyingResult>;
  subscribeMarketData(): void;
  unsubscribeMarketData(): void;
  placeOrder(req: PlaceOrderRequest): Promise<OrderState>;
  transmitOrder(orderId: string): Promise<void>;
  cancelOrder(orderId: string): Promise<void>;
  getAccountSummary(): Promise<AccountSummary>;
  on<E extends BrokerEvent>(event: E, fn: (payload: BrokerEventMap[E]) => void): () => void;
}

declare global {
  interface Window {
    exvest?: ExvestBridge;
  }
}
