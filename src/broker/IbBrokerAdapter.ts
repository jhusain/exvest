/**
 * BrokerAdapter backed by a real IB Gateway/TWS connection via @stoqey/ib.
 * Main-process only — never imported from the renderer bundle (the web build
 * must not pull in Node sockets).
 */
import {
  IBApi,
  EventName,
  Stock,
  Option as IBOption,
  OptionType,
  OrderAction,
  LimitOrder,
  OrderStatus as IBOrderStatus,
  BarSizeSetting,
  WhatToShow,
  type Contract,
  type ContractDetails,
  type Order as IBOrder,
  type TickType
} from '@stoqey/ib';
import { TypedEmitter } from '../shared/emitter';
import { createLogger, isIbWarningCode } from '../shared/log';
import { parseIbTradingHours } from '../shared/marketClock';
import type {
  AccountSummary,
  BrokerAdapter,
  BrokerEventMap,
  ConnectionInfo,
  OptionQuote,
  OrderState,
  OrderStatus,
  PlaceOrderRequest,
  SetUnderlyingResult,
  TradingMode,
  TradingSession
} from '../shared/types';

// TickType is exported as a type only (see @stoqey/ib's index.d.ts); the runtime
// enum values are stable per the TWS API tick-type reference, so we mirror the
// handful this adapter needs rather than deep-importing the package's internal path.
const TICK = { BID_SIZE: 0, BID: 1, ASK: 2, ASK_SIZE: 3, LAST: 4, CLOSE: 9 } as const;

const OPTION_CHAIN_SIZE = 12;
const QUOTE_EMIT_THROTTLE_MS = 250;
const CONNECT_TIMEOUT_MS = 5000;
/** How long to wait for an underlying price before reporting that the chain cannot be built. */
const CHAIN_WATCHDOG_MS = 8000;
/** Cap on waiting for an IB request's *End event, so a missing one cannot hang startup. */
const REQUEST_TIMEOUT_MS = 10000;

/**
 * IB codes meaning "you are not entitled to live data for this instrument":
 * 10089/10090 (subscription required) and 354 (market data not subscribed).
 * @see https://interactivebrokers.github.io/tws-api/message_codes.html
 */
const MARKET_DATA_ENTITLEMENT_CODES = [354, 10089, 10090];
/**
 * Codes that report a degraded-but-working state rather than a failure, so
 * they are logged but never surfaced to the UI as errors:
 *  - 10167: "Requested market data is not subscribed. Displaying delayed
 *    market data." — delayed data IS flowing, which is what we asked for.
 *  - 300: "Can't find EId with tickerId" — a cancel for a subscription that
 *    was not outstanding. Bookkeeping the user cannot act on.
 */
const NON_FATAL_NOTICE_CODES = [300, 10167];
/** reqMarketDataType(4): delayed, falling back to the last snapshot when the market is closed. */
const IB_MARKET_DATA_TYPE_DELAYED_FROZEN = 4;

const log = createLogger('ib');

export interface IbBrokerAdapterOptions {
  host?: string;
  port: number;
  clientId?: number;
  mode: TradingMode;
}

function todayYYYYMMDD(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function mapOrderStatus(status: IBOrderStatus | string): OrderStatus {
  switch (status) {
    case IBOrderStatus.PendingSubmit:
      return 'PendingSubmit';
    case IBOrderStatus.PreSubmitted:
      return 'PreSubmitted';
    case IBOrderStatus.Submitted:
      return 'Submitted';
    case IBOrderStatus.Filled:
      return 'Filled';
    case IBOrderStatus.Cancelled:
    case IBOrderStatus.ApiCancelled:
    case IBOrderStatus.PendingCancel:
      return 'Cancelled';
    case IBOrderStatus.Inactive:
      return 'Inactive';
    default:
      return 'Draft';
  }
}

interface PendingOption {
  conId: number;
  strike: number;
  reqId: number;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  delta: number | null;
}

export class IbBrokerAdapter implements BrokerAdapter {
  private emitter = new TypedEmitter<BrokerEventMap>();
  private ib: IBApi;
  private nextReqId = 1;
  private symbol = 'SPY';
  private underlyingConId = 0;
  private underlyingReqId = 0;
  private underlyingPrice = 0;
  private nearestExpiry = todayYYYYMMDD();
  private allStrikes: number[] = [];
  private optionsByReqId = new Map<number, PendingOption>();
  private optionsSubscribed = false;
  private delayedDataFallbackDone = false;
  private underlyingSessions: TradingSession[] = [];
  private quoteFlushHandle: ReturnType<typeof setTimeout> | null = null;
  private chainWatchdog: ReturnType<typeof setTimeout> | null = null;
  /**
   * reqIds with a live reqMktData subscription. IB answers cancelMktData for
   * an unknown id with error 300 ("Can't find EId with tickerId"), so every
   * cancel is gated on this set.
   */
  private activeMktDataReqIds = new Set<number>();
  private accountId: string | null = null;
  private pendingOrders = new Map<number, { conId: number; optionId: string; qty: number; limitPrice: number; resolve: (s: OrderState) => void; reject: (e: Error) => void }>();
  private orderIdByReqOrderId = new Map<number, string>();

  constructor(private opts: IbBrokerAdapterOptions) {
    this.ib = new IBApi({ host: opts.host ?? '127.0.0.1', port: opts.port, clientId: opts.clientId ?? 0 });
    this.wireEvents();
  }

  private wireEvents() {
    this.ib.on(EventName.error, (error: Error, code: unknown, reqId: number) => {
      const errCode = typeof code === 'number' ? code : Number(code);

      // IB delivers status notices ("Market data farm connection is OK") over
      // the same event as real errors. Log them, but never surface as errors.
      if (isIbWarningCode(errCode)) {
        log.info(`notice ${errCode}: ${error?.message ?? ''}`);
        return;
      }

      if (NON_FATAL_NOTICE_CODES.includes(errCode)) {
        log.warn(`notice ${errCode} (reqId ${reqId}): ${error?.message ?? String(error)}`);
        return;
      }

      log.error(`error ${errCode} (reqId ${reqId}): ${error?.message ?? String(error)}`);

      // No live market-data entitlement for this instrument. IB offers free
      // delayed data, but only if the client explicitly opts in — switch the
      // whole session to delayed-frozen and re-issue the subscriptions.
      // (Frozen so a closed market still returns the last snapshot rather
      // than nothing at all.)
      if (MARKET_DATA_ENTITLEMENT_CODES.includes(errCode) && !this.delayedDataFallbackDone) {
        this.delayedDataFallbackDone = true;
        log.warn('no live market-data entitlement — retrying with delayed-frozen data (IB market data type 4)');
        this.ib.reqMarketDataType(IB_MARKET_DATA_TYPE_DELAYED_FROZEN);
        this.resubscribeMarketData();
        return;
      }

      // Connection-fatal codes: surface as a connectionStatus drop so the
      // renderer can fall back to the client simulator.
      if ([502, 504, 1100, 1300].includes(errCode)) {
        this.emitter.emit('connectionStatus', {
          mode: this.opts.mode,
          connected: false,
          accountId: this.accountId,
          reason: error?.message || `IB error ${errCode}`
        });
        return;
      }
      const pending = this.pendingOrders.get(reqId);
      if (pending) {
        this.pendingOrders.delete(reqId);
        const state: OrderState = {
          id: String(reqId),
          conId: pending.conId,
          optionId: pending.optionId,
          action: 'SELL',
          qty: pending.qty,
          limitPrice: pending.limitPrice,
          status: 'Rejected',
          filled: 0,
          remaining: pending.qty,
          avgFillPrice: null,
          transmitted: true,
          message: error?.message
        };
        pending.resolve(state);
        this.emitter.emit('orderUpdate', state);
        return;
      }
      this.emitter.emit('error', { code: errCode, message: error?.message ?? String(error) });
    });

    this.ib.on(EventName.disconnected, () => {
      log.warn('disconnected from IB');
      this.emitter.emit('connectionStatus', {
        mode: this.opts.mode,
        connected: false,
        accountId: this.accountId,
        reason: 'IB Gateway connection closed'
      });
    });

    this.ib.on(EventName.contractDetails, (reqId: number, details: ContractDetails) => {
      if (reqId !== this.underlyingReqId) return;
      if (details.contract.conId) this.underlyingConId = details.contract.conId;
      // The broker's own schedule — accounts for holidays and half days that
      // a hardcoded close time cannot. Requires "Expose entire trading
      // schedule to API" in TWS; absent that, liquidHours is undefined and
      // the UI falls back to the regular-session assumption.
      this.underlyingSessions = parseIbTradingHours(
        details.liquidHours ?? details.tradingHours,
        details.timeZoneId ?? ''
      );
    });

    this.ib.on(EventName.securityDefinitionOptionParameter, (_reqId, _exchange, _underConId, _tradingClass, _multiplier, expirations: string[], strikes: number[]) => {
      const today = todayYYYYMMDD();
      const sorted = [...expirations].sort();
      const nearest = sorted.find((e) => e >= today) ?? sorted[0];
      if (nearest && (!this.nearestExpiry || nearest < this.nearestExpiry || this.nearestExpiry < today)) {
        this.nearestExpiry = nearest;
      }
      this.allStrikes = Array.from(new Set([...this.allStrikes, ...strikes])).sort((a, b) => a - b);
    });

    this.ib.on(EventName.tickPrice, (reqId: number, field: TickType, value: number) => {
      if (reqId === this.underlyingReqId) {
        if (field === TICK.LAST || field === TICK.CLOSE) {
          this.underlyingPrice = value;
          this.emitter.emit('underlyingTick', { conId: this.underlyingConId, price: value, time: Date.now() });
          this.maybeSubscribeOptionChain();
        }
        return;
      }
      const pending = this.optionsByReqId.get(reqId);
      if (!pending) return;
      if (field === TICK.BID) pending.bid = value;
      if (field === TICK.ASK) pending.ask = value;
      this.scheduleQuoteFlush();
    });

    this.ib.on(EventName.tickSize, (reqId: number, field?: TickType, value?: number) => {
      const pending = this.optionsByReqId.get(reqId);
      if (!pending || value === undefined) return;
      if (field === TICK.BID_SIZE) pending.bidSize = value;
      if (field === TICK.ASK_SIZE) pending.askSize = value;
      this.scheduleQuoteFlush();
    });

    this.ib.on(EventName.tickOptionComputation, (reqId: number, _field, _attrib, _iv, delta) => {
      const pending = this.optionsByReqId.get(reqId);
      if (!pending || delta === undefined) return;
      pending.delta = delta;
      this.scheduleQuoteFlush();
    });

    this.ib.on(EventName.orderStatus, (orderId: number, status: IBOrderStatus, filled: number, remaining: number, avgFillPrice: number) => {
      const id = String(orderId);
      const trackedOptionId = this.orderIdByReqOrderId.get(orderId);
      log.info(`orderStatus ${orderId}: ${status} (filled ${filled}, remaining ${remaining})`);
      const state: OrderState = {
        id,
        conId: 0,
        optionId: trackedOptionId ?? '',
        action: 'SELL',
        qty: filled + remaining,
        limitPrice: 0,
        status: mapOrderStatus(status),
        filled,
        remaining,
        avgFillPrice: avgFillPrice || null,
        transmitted: true
      };
      this.emitter.emit('orderUpdate', state);
    });

    this.ib.on(EventName.accountSummary, (_reqId: number, account: string, tag: string, value: string, currency: string) => {
      this.accountId = account;
      this.lastAccountValues.set(tag, value);
      this.lastAccountCurrency = currency;
      this.scheduleAccountFlush();
    });
  }

  private lastAccountValues = new Map<string, string>();
  private lastAccountCurrency = 'USD';
  private accountFlushHandle: ReturnType<typeof setTimeout> | null = null;
  private scheduleAccountFlush() {
    if (this.accountFlushHandle) return;
    this.accountFlushHandle = setTimeout(() => {
      this.accountFlushHandle = null;
      const num = (tag: string) => Number(this.lastAccountValues.get(tag) ?? 0);
      this.emitter.emit('accountUpdate', {
        accountId: this.accountId ?? '',
        availableFunds: num('AvailableFunds'),
        netLiquidation: num('NetLiquidation'),
        buyingPower: num('BuyingPower'),
        currency: this.lastAccountCurrency
      });
    }, QUOTE_EMIT_THROTTLE_MS);
  }

  private nextId(): number {
    return this.nextReqId++;
  }

  async connect(): Promise<ConnectionInfo> {
    const host = this.opts.host ?? '127.0.0.1';
    log.info(
      `connecting to ${host}:${this.opts.port} (clientId ${this.opts.clientId ?? 0}, mode ${this.opts.mode}, timeout ${CONNECT_TIMEOUT_MS}ms)`
    );

    const info = await new Promise<ConnectionInfo>((resolve) => {
      const timeout = setTimeout(() => {
        log.error(
          `connect timed out after ${CONNECT_TIMEOUT_MS}ms — is TWS/Gateway running on ${host}:${this.opts.port} with "Enable ActiveX and Socket Clients" turned on?`
        );
        resolve({ mode: this.opts.mode, connected: false, accountId: null, reason: 'IB Gateway connect timed out' });
      }, CONNECT_TIMEOUT_MS);

      this.ib.once(EventName.connected, () => {
        clearTimeout(timeout);
        // Detach the connect-scoped error handler, or later unrelated errors
        // (e.g. a market-data entitlement notice) get logged as "connect failed".
        this.ib.removeListener(EventName.error, onError);
        log.info(`connected to ${host}:${this.opts.port}`);
        this.ib.reqAccountSummary(this.nextId(), 'All', 'AvailableFunds,NetLiquidation,BuyingPower');
        resolve({ mode: this.opts.mode, connected: true, accountId: null });
      });

      // Only a genuine error aborts the attempt. IB's 2100-series status
      // notices routinely arrive around connect time and must not be mistaken
      // for a failure, or a healthy session gets torn down before it starts.
      const onError = (error: Error, code: unknown) => {
        const errCode = typeof code === 'number' ? code : Number(code);
        if (isIbWarningCode(errCode)) {
          log.info(`notice ${errCode} during connect: ${error?.message ?? ''}`);
          return;
        }
        this.ib.removeListener(EventName.error, onError);
        clearTimeout(timeout);
        log.error(`connect failed (${errCode}): ${error?.message ?? String(error)}`);
        resolve({ mode: this.opts.mode, connected: false, accountId: null, reason: error?.message });
      };
      this.ib.on(EventName.error, onError);

      this.ib.connect();
    });
    return info;
  }

  async disconnect(): Promise<void> {
    this.unsubscribeMarketData();
    this.ib.disconnect();
  }

  /**
   * Issues a request and waits for its matching *End event, with a timeout.
   *
   * Without the timeout a missing end-event strands setUnderlying() forever,
   * which in turn strands the renderer's bootstrap: no expiry, no chain, and
   * no indication of why. Resolving on timeout lets the caller continue with
   * whatever partial data arrived.
   */
  private awaitEnd(event: EventName, reqId: number, what: string, send: () => void): Promise<void> {
    // @stoqey/ib types on()/removeListener() as a union of per-event
    // overloads, which a variable EventName cannot satisfy; the payload we
    // need (the request id) is the first argument for every *End event.
    const emitter = this.ib as unknown as {
      on(event: EventName, listener: (reqId: number) => void): void;
      removeListener(event: EventName, listener: (reqId: number) => void): void;
    };
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        emitter.removeListener(event, onEnd);
        if (timedOut) {
          log.warn(`timed out after ${REQUEST_TIMEOUT_MS}ms waiting for ${what} (reqId ${reqId}) — continuing with partial data`);
        }
        resolve();
      };
      const onEnd = (rid: number) => {
        if (rid === reqId) finish(false);
      };
      const timer = setTimeout(() => finish(true), REQUEST_TIMEOUT_MS);
      emitter.on(event, onEnd);
      send();
    });
  }

  async setUnderlying(symbol: string): Promise<SetUnderlyingResult> {
    this.symbol = symbol;
    this.underlyingConId = 0;
    this.underlyingSessions = [];
    this.allStrikes = [];
    this.nearestExpiry = todayYYYYMMDD();

    const stock = new Stock(symbol, 'SMART', 'USD');
    this.underlyingReqId = this.nextId();

    await this.awaitEnd(
      EventName.contractDetailsEnd,
      this.underlyingReqId,
      'contract details',
      () => this.ib.reqContractDetails(this.underlyingReqId, stock)
    );

    const optParamsReqId = this.nextId();
    await this.awaitEnd(
      EventName.securityDefinitionOptionParameterEnd,
      optParamsReqId,
      'option chain definition',
      () => this.ib.reqSecDefOptParams(optParamsReqId, symbol, '', 'STK', this.underlyingConId)
    );

    const today = todayYYYYMMDD();
    if (!this.underlyingConId) {
      log.warn(`no contract details returned for ${symbol} — check the symbol and your market-data permissions`);
    }
    log.info(
      `underlying ${symbol}: conId ${this.underlyingConId}, nearest expiry ${this.nearestExpiry}, ${this.allStrikes.length} strikes`
    );
    return {
      symbol,
      conId: this.underlyingConId,
      expiry: this.nearestExpiry,
      expiryIsToday: this.nearestExpiry === today,
      sessions: this.underlyingSessions
    };
  }

  subscribeMarketData(): void {
    if (!this.underlyingReqId) {
      // setUnderlying() allocates the request id and resolves the contract.
      // Subscribing first would issue reqMktData under id 0 and then ignore
      // every tick, since the id would no longer match once it is assigned.
      log.error('subscribeMarketData() called before setUnderlying() — ignoring; no market data will flow');
      return;
    }
    log.info(`subscribing to market data for ${this.symbol} (reqId ${this.underlyingReqId})`);
    const stock = new Stock(this.symbol, 'SMART', 'USD');
    this.ib.reqMktData(this.underlyingReqId, stock, '', false, false);
    this.activeMktDataReqIds.add(this.underlyingReqId);

    // The option chain is only subscribed once an underlying price arrives
    // (the strike window is centred on it), and that happens off the tick
    // handler. If no tick ever comes — the usual case outside market hours
    // with no data entitlement — nothing errors and the UI just stays empty.
    // Report that explicitly instead of failing silently.
    if (this.chainWatchdog) clearTimeout(this.chainWatchdog);
    this.chainWatchdog = setTimeout(() => {
      this.chainWatchdog = null;
      if (this.optionsSubscribed) return;
      if (!this.allStrikes.length) {
        log.warn(`no strikes returned by reqSecDefOptParams for ${this.symbol} — cannot build a chain`);
        return;
      }
      if (!this.underlyingPrice) {
        log.warn(
          `no underlying price for ${this.symbol} after ${CHAIN_WATCHDOG_MS}ms — falling back to the last daily close so the chain can still be built`
        );
        this.requestReferencePriceFromHistory();
      }
    }, CHAIN_WATCHDOG_MS);
  }

  /**
   * Outside market hours no tick arrives, and the strike window is chosen
   * relative to the underlying price — so without a reference price there is
   * no chain to show at all. Historical bars are served when streaming quotes
   * are not, so fall back to the most recent daily close.
   *
   * The resulting price is a stale close, not a live quote: it is good enough
   * to centre the strike window, which is all it is used for. It is still
   * emitted as an underlyingTick so the header shows something rather than
   * $0.00.
   */
  private requestReferencePriceFromHistory(): void {
    const reqId = this.nextId();
    const stock = new Stock(this.symbol, 'SMART', 'USD');

    // This @stoqey/ib version has no historicalDataEnd event: the decoder
    // marks the end of the stream with a final historicalData row whose time
    // starts with "finished" and whose numeric fields are -1. Bars arrive
    // oldest-first, so keep the last real close rather than the first.
    let latestClose = 0;

    const onBar = (rid: number, time: string, _open: number, _high: number, _low: number, close: number) => {
      if (rid !== reqId) return;

      if (typeof time === 'string' && time.startsWith('finished')) {
        this.ib.removeListener(EventName.historicalData, onBar);
        if (!latestClose) {
          log.warn(
            `historical data returned no usable close for ${this.symbol} — no strikes can be displayed until a price is available`
          );
          return;
        }
        if (this.underlyingPrice) return; // a real tick beat us to it
        this.underlyingPrice = latestClose;
        log.info(`using last close ${latestClose} for ${this.symbol} as the strike-window reference price`);
        this.emitter.emit('underlyingTick', { conId: this.underlyingConId, price: latestClose, time: Date.now() });
        this.maybeSubscribeOptionChain();
        return;
      }

      if (close > 0) latestClose = close;
    };

    this.ib.on(EventName.historicalData, onBar);

    log.info(`requesting last daily close for ${this.symbol} (reqId ${reqId})`);
    this.ib.reqHistoricalData(
      reqId,
      stock,
      '', // now
      '2 D', // a 2-day window so a weekend/holiday still yields a bar
      BarSizeSetting.DAYS_ONE,
      WhatToShow.TRADES,
      1, // regular trading hours only
      1, // formatDate: yyyymmdd strings
      false
    );
  }

  private maybeSubscribeOptionChain(): void {
    if (this.optionsSubscribed || !this.allStrikes.length || !this.underlyingPrice) return;
    this.optionsSubscribed = true;

    const minStrike = Math.ceil(this.underlyingPrice * 1.01);
    const strikes = this.allStrikes.filter((s) => s >= minStrike).slice(0, OPTION_CHAIN_SIZE);
    log.info(
      `underlying at ${this.underlyingPrice}; subscribing to ${strikes.length} put strikes for ${this.nearestExpiry}`
    );
    if (!strikes.length) {
      log.warn(`no strikes at or above ${minStrike} in the chain — nothing to quote`);
    }

    for (const strike of strikes) {
      const contract = new IBOption(this.symbol, this.nearestExpiry, strike, OptionType.Put, 'SMART', 'USD');
      const reqId = this.nextId();
      this.optionsByReqId.set(reqId, { conId: 0, strike, reqId, bid: null, ask: null, bidSize: null, askSize: null, delta: null });

      const detailsReqId = this.nextId();
      this.ib.on(EventName.contractDetails, (rid: number, details: ContractDetails) => {
        if (rid === detailsReqId) {
          const pending = this.optionsByReqId.get(reqId);
          if (pending && details.contract.conId) pending.conId = details.contract.conId;
        }
      });
      this.ib.reqContractDetails(detailsReqId, contract);
      this.ib.reqMktData(reqId, contract, '106', false, false);
      this.activeMktDataReqIds.add(reqId);
    }
  }

  /**
   * Re-issues every active market-data request under the currently selected
   * market data type. Used after switching to delayed data, since the type
   * only applies to subscriptions made after reqMarketDataType.
   */
  /** Cancels a market-data request only if one is actually outstanding (see error 300). */
  private cancelMktDataIfActive(reqId: number): void {
    if (!this.activeMktDataReqIds.delete(reqId)) return;
    this.ib.cancelMktData(reqId);
  }

  private resubscribeMarketData(): void {
    if (this.underlyingReqId) {
      this.cancelMktDataIfActive(this.underlyingReqId);
      const stock = new Stock(this.symbol, 'SMART', 'USD');
      this.ib.reqMktData(this.underlyingReqId, stock, '', false, false);
      this.activeMktDataReqIds.add(this.underlyingReqId);
    }
    for (const [reqId, pending] of this.optionsByReqId) {
      this.cancelMktDataIfActive(reqId);
      const contract = new IBOption(this.symbol, this.nearestExpiry, pending.strike, OptionType.Put, 'SMART', 'USD');
      this.ib.reqMktData(reqId, contract, '106', false, false);
      this.activeMktDataReqIds.add(reqId);
    }
    log.info(`re-subscribed underlying + ${this.optionsByReqId.size} option contracts with delayed data`);
  }

  unsubscribeMarketData(): void {
    if (this.chainWatchdog) {
      clearTimeout(this.chainWatchdog);
      this.chainWatchdog = null;
    }
    if (this.underlyingReqId) this.cancelMktDataIfActive(this.underlyingReqId);
    for (const reqId of this.optionsByReqId.keys()) this.cancelMktDataIfActive(reqId);
    this.optionsByReqId.clear();
    this.optionsSubscribed = false;
    if (this.quoteFlushHandle) {
      clearTimeout(this.quoteFlushHandle);
      this.quoteFlushHandle = null;
    }
  }

  private scheduleQuoteFlush(): void {
    if (this.quoteFlushHandle) return;
    this.quoteFlushHandle = setTimeout(() => {
      this.quoteFlushHandle = null;
      this.flushQuotes();
    }, QUOTE_EMIT_THROTTLE_MS);
  }

  private flushQuotes(): void {
    const now = Date.now();
    const quotes: OptionQuote[] = [];
    for (const p of this.optionsByReqId.values()) {
      if (p.bid == null || p.ask == null) continue;
      quotes.push({
        id: `put-${p.strike}`,
        conId: p.conId,
        strike: p.strike,
        expiry: this.nearestExpiry,
        bidPremium: p.bid,
        askPremium: p.ask,
        bidSize: p.bidSize ?? 0,
        askSize: p.askSize ?? 0,
        probITM: p.delta != null ? Math.round(Math.abs(p.delta) * 100) : 0,
        time: now
      });
    }
    log.debug(`flushing ${quotes.length}/${this.optionsByReqId.size} option quotes`);
    if (quotes.length) this.emitter.emit('optionQuotes', quotes.sort((a, b) => a.strike - b.strike));
  }

  async placeOrder(req: PlaceOrderRequest): Promise<OrderState> {
    const orderId = await new Promise<number>((resolve) => {
      this.ib.once(EventName.nextValidId, (id: number) => resolve(id));
      this.ib.reqIds();
    });

    const contract: Contract = { conId: req.conId, secType: 'OPT' as any, exchange: 'SMART', currency: 'USD' };
    const order: IBOrder = new LimitOrder(OrderAction.SELL, req.limitPrice, req.qty, this.opts.mode !== 'ib-live-confirm');

    this.orderIdByReqOrderId.set(orderId, req.optionId);

    return new Promise<OrderState>((resolve, reject) => {
      this.pendingOrders.set(orderId, { conId: req.conId, optionId: req.optionId, qty: req.qty, limitPrice: req.limitPrice, resolve, reject });
      const onOpenOrder = (oid: number, _c: Contract, _o: IBOrder, orderState: { status: IBOrderStatus }) => {
        if (oid !== orderId) return;
        this.ib.removeListener(EventName.openOrder, onOpenOrder);
        const pending = this.pendingOrders.get(orderId);
        this.pendingOrders.delete(orderId);
        const state: OrderState = {
          id: String(orderId),
          conId: req.conId,
          optionId: req.optionId,
          action: 'SELL',
          qty: req.qty,
          limitPrice: req.limitPrice,
          status: mapOrderStatus(orderState.status),
          filled: 0,
          remaining: req.qty,
          avgFillPrice: null,
          transmitted: this.opts.mode !== 'ib-live-confirm'
        };
        pending?.resolve(state);
        this.emitter.emit('orderUpdate', state);
      };
      this.ib.on(EventName.openOrder, onOpenOrder);
      log.info(
        `placing SELL ${req.qty} @ ${req.limitPrice} on conId ${req.conId} (orderId ${orderId}, transmit ${this.opts.mode !== 'ib-live-confirm'})`
      );
      this.ib.placeOrder(orderId, contract, order);
    });
  }

  async cancelOrder(orderId: string): Promise<void> {
    log.info(`cancelling order ${orderId}`);
    this.ib.cancelOrder(Number(orderId));
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const num = (tag: string) => Number(this.lastAccountValues.get(tag) ?? 0);
    return {
      accountId: this.accountId ?? '',
      availableFunds: num('AvailableFunds'),
      netLiquidation: num('NetLiquidation'),
      buyingPower: num('BuyingPower'),
      currency: this.lastAccountCurrency
    };
  }

  on<E extends keyof BrokerEventMap>(event: E, fn: (payload: BrokerEventMap[E]) => void): () => void {
    return this.emitter.on(event, fn);
  }
}
