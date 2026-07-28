/**
 * Client-side simulated market data + fills, behind the BrokerAdapter interface.
 * This is the mode-1 (sim-client) implementation, and also what the renderer
 * falls back to when it can't reach IB Gateway. Must stay Node-free so the
 * static web build can bundle it directly.
 */
import { clamp } from '../shared/pas';
import { TypedEmitter } from '../shared/emitter';
import type {
  AccountSummary,
  BrokerAdapter,
  BrokerEventMap,
  ConnectionInfo,
  OptionQuote,
  OrderState,
  PlaceOrderRequest,
  SetUnderlyingResult
} from '../shared/types';

function mulberry32(a: number): () => number {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Perlin1D {
  private rand: () => number;
  private grad: number[];
  constructor(seed = 1) {
    this.rand = mulberry32(seed);
    this.grad = [...Array(512)].map(() => this.rand() * 2 - 1);
  }
  private fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }
  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }
  noise(x: number): number {
    const X = Math.floor(x) & 255;
    const xf = x - Math.floor(x);
    const g0 = this.grad[X];
    const g1 = this.grad[(X + 1) & 255];
    const u = this.fade(xf);
    return this.lerp(g0 * xf, g1 * (xf - 1), u);
  }
}

const MIN_PREMIUM_SPREAD = 7;
const SIM_ACCOUNT_ID = 'DU0000000';
const SIM_AVAILABLE_FUNDS = 100000;

function todayYYYYMMDD(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function synthOptions(under: number, now: number, expiry: string): OptionQuote[] {
  const arr: OptionQuote[] = [];
  const startStrike = Math.ceil(under * 1.01);
  const perlinOpt = new Perlin1D(9001);
  const round2 = (n: number) => Math.round(n * 100) / 100;
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
    const askSize = Math.max(1, Math.round((12 - i) * (0.5 + Math.random())));
    const depth = (strike - under) / Math.max(under * 0.01, 0.5);
    const sigmoid = 1 / (1 + Math.exp(-0.6 * depth));
    const probITM = clamp(0.65 + 0.35 * sigmoid + 0.05 * (bidSize / 20), 0.5, 0.995);
    arr.push({
      id: `put-${strike}`,
      conId: 900000 + strike,
      strike,
      expiry,
      bidSize,
      askSize,
      probITM: Math.round(probITM * 100),
      askPremium: round2(askPremium),
      bidPremium: round2(bidPremium),
      time: now
    });
  }
  return arr;
}

export class SimBrokerAdapter implements BrokerAdapter {
  private emitter = new TypedEmitter<BrokerEventMap>();
  private noise: Perlin1D;
  private t = 0;
  private base = 100;
  private vol = 1.2;
  private handle: ReturnType<typeof setInterval> | null = null;
  private orders = new Map<string, OrderState>();
  private lastQuotes: OptionQuote[] = [];
  private symbol = 'SPY';
  private connected = false;

  constructor(seed = 1337) {
    this.noise = new Perlin1D(seed);
  }

  async connect(): Promise<ConnectionInfo> {
    this.connected = true;
    const info: ConnectionInfo = { mode: 'sim-client', connected: true, accountId: SIM_ACCOUNT_ID };
    this.emitter.emit('connectionStatus', info);
    return info;
  }

  async disconnect(): Promise<void> {
    this.unsubscribeMarketData();
    this.connected = false;
  }

  async setUnderlying(symbol: string): Promise<SetUnderlyingResult> {
    this.symbol = symbol;
    return { symbol, conId: 1, expiry: todayYYYYMMDD(), expiryIsToday: true };
  }

  subscribeMarketData(): void {
    if (this.handle) return;
    this.handle = setInterval(() => this.tick(), 600);
    this.tick();
    void this.getAccountSummary().then((a) => this.emitter.emit('accountUpdate', a));
  }

  unsubscribeMarketData(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  private tick(): void {
    this.t += 0.05;
    this.base = this.base + this.noise.noise(this.t) * 0.35;
    const price = clamp(this.base + this.noise.noise(this.t * 0.25) * this.vol, 5, 2000);
    const now = Date.now();
    this.lastQuotes = synthOptions(price, now, todayYYYYMMDD());
    this.emitter.emit('underlyingTick', { conId: 1, price, time: now });
    this.emitter.emit('optionQuotes', this.lastQuotes);
  }

  async placeOrder(req: PlaceOrderRequest): Promise<OrderState> {
    const option = this.lastQuotes.find((o) => o.id === req.optionId);
    const orderId = `ORD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    await new Promise((r) => setTimeout(r, 350 + Math.random() * 500));

    if (!option) {
      const rejected: OrderState = {
        id: orderId,
        conId: req.conId,
        optionId: req.optionId,
        action: 'SELL',
        qty: req.qty,
        limitPrice: req.limitPrice,
        status: 'Rejected',
        filled: 0,
        remaining: req.qty,
        avgFillPrice: null,
        transmitted: true,
        message: 'Option no longer quoted'
      };
      this.emitter.emit('orderUpdate', rejected);
      return rejected;
    }

    // A short put fills more readily the closer the limit premium sits to the bid.
    const spread = Math.max(0.01, option.askPremium - option.bidPremium);
    const closeness = clamp(1 - (req.limitPrice - option.bidPremium) / spread, 0, 1);
    const sizeFactor = clamp(option.bidSize / 50, 0, 1);
    const p = 0.15 + 0.6 * closeness + 0.25 * sizeFactor;
    const filled = Math.random() < p;

    const state: OrderState = {
      id: orderId,
      conId: req.conId,
      optionId: req.optionId,
      action: 'SELL',
      qty: req.qty,
      limitPrice: req.limitPrice,
      status: filled ? 'Filled' : 'Rejected',
      filled: filled ? req.qty : 0,
      remaining: filled ? 0 : req.qty,
      avgFillPrice: filled ? req.limitPrice : null,
      transmitted: true,
      message: filled ? undefined : 'Order not filled (simulated). Try closer to bid or higher bid size.'
    };
    if (filled) this.orders.set(orderId, state);
    this.emitter.emit('orderUpdate', state);
    return state;
  }

  async cancelOrder(orderId: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 400));
    const existing = this.orders.get(orderId);
    if (!existing) {
      throw new Error(`Cancel failed: order ${orderId} not found`);
    }
    if (Math.random() >= 0.95) {
      throw new Error('Cancel failed (simulated)');
    }
    this.orders.delete(orderId);
    this.emitter.emit('orderUpdate', { ...existing, status: 'Cancelled', remaining: 0 });
  }

  async getAccountSummary(): Promise<AccountSummary> {
    return {
      accountId: SIM_ACCOUNT_ID,
      availableFunds: SIM_AVAILABLE_FUNDS,
      netLiquidation: SIM_AVAILABLE_FUNDS,
      buyingPower: SIM_AVAILABLE_FUNDS,
      currency: 'USD'
    };
  }

  on<E extends keyof BrokerEventMap>(event: E, fn: (payload: BrokerEventMap[E]) => void): () => void {
    return this.emitter.on(event, fn);
  }
}
