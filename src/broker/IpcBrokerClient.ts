/**
 * Renderer-side BrokerAdapter that forwards every call to the Electron main
 * process over the window.exvest bridge exposed by electron/preload.ts. The
 * main process owns the actual IbBrokerAdapter instance; this class exists so
 * the renderer's createBroker() can hand out one BrokerAdapter type
 * regardless of which mode is active.
 */
import type {
  AccountSummary,
  BrokerAdapter,
  BrokerEvent,
  BrokerEventMap,
  ConnectionInfo,
  OrderState,
  PlaceOrderRequest,
  SetUnderlyingResult
} from '../shared/types';
import type { ExvestBridge } from '../shared/preloadApi';

export class IpcBrokerClient implements BrokerAdapter {
  constructor(private bridge: ExvestBridge) {}

  connect(): Promise<ConnectionInfo> {
    return this.bridge.connect();
  }

  disconnect(): Promise<void> {
    return this.bridge.disconnect();
  }

  setUnderlying(symbol: string): Promise<SetUnderlyingResult> {
    return this.bridge.setUnderlying(symbol);
  }

  subscribeMarketData(): void {
    this.bridge.subscribeMarketData();
  }

  unsubscribeMarketData(): void {
    this.bridge.unsubscribeMarketData();
  }

  placeOrder(req: PlaceOrderRequest): Promise<OrderState> {
    return this.bridge.placeOrder(req);
  }

  cancelOrder(orderId: string): Promise<void> {
    return this.bridge.cancelOrder(orderId);
  }

  getAccountSummary(): Promise<AccountSummary> {
    return this.bridge.getAccountSummary();
  }

  on<E extends BrokerEvent>(event: E, fn: (payload: BrokerEventMap[E]) => void): () => void {
    return this.bridge.on(event, fn);
  }
}
