import { describe, it, expect, afterEach } from 'vitest';
import { SimBrokerAdapter } from '../src/broker/SimBrokerAdapter';

describe('SimBrokerAdapter', () => {
  let broker: SimBrokerAdapter | null = null;

  afterEach(() => {
    broker?.unsubscribeMarketData();
    broker = null;
  });

  it('connects and reports a sim account', async () => {
    broker = new SimBrokerAdapter();
    const info = await broker.connect();
    expect(info.mode).toBe('sim-client');
    expect(info.connected).toBe(true);
    expect(info.accountId).toBeTruthy();
  });

  it('setUnderlying returns today as the expiry, marked as today', async () => {
    broker = new SimBrokerAdapter();
    const result = await broker.setUnderlying('SPY');
    expect(result.expiryIsToday).toBe(true);
    const today = new Date();
    const expected = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    expect(result.expiry).toBe(expected);
  });

  it('emits an underlying tick and a 12-option chain once subscribed', async () => {
    broker = new SimBrokerAdapter();
    await broker.connect();

    const tick = await new Promise<{ price: number }>((resolve) => {
      const off = broker!.on('underlyingTick', (t) => {
        off();
        resolve(t);
      });
      broker!.subscribeMarketData();
    });
    expect(tick.price).toBeGreaterThan(0);

    const quotes = await new Promise<unknown[]>((resolve) => {
      const off = broker!.on('optionQuotes', (q) => {
        off();
        resolve(q);
      });
    });
    expect(quotes).toHaveLength(12);
  });

  it('rejects placeOrder for an option that no longer exists in the last quote snapshot', async () => {
    broker = new SimBrokerAdapter();
    await broker.connect();
    const result = await broker.placeOrder({ optionId: 'put-does-not-exist', conId: 1, qty: 1, limitPrice: 10 });
    expect(result.status).toBe('Rejected');
  });
});
