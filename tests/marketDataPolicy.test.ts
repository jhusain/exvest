/**
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isLiveMoneyMode, marketDataTypeForMode } from '../src/broker/IbBrokerAdapter';

const REALTIME = 1;
const DELAYED_FROZEN = 4;

afterEach(() => {
  delete process.env.EXVEST_IB_MARKET_DATA_TYPE;
});

describe('market data policy by trading mode', () => {
  it('treats only the real-money modes as live', () => {
    expect(isLiveMoneyMode('ib-live')).toBe(true);
    expect(isLiveMoneyMode('ib-live-confirm')).toBe(true);
    expect(isLiveMoneyMode('ib-paper')).toBe(false);
    expect(isLiveMoneyMode('sim-client')).toBe(false);
  });

  it('pins live-money modes to real-time data', () => {
    expect(marketDataTypeForMode('ib-live')).toBe(REALTIME);
    expect(marketDataTypeForMode('ib-live-confirm')).toBe(REALTIME);
  });

  it('ignores the env override in live-money modes', () => {
    // Delayed quotes must never price a real-money order, even if the
    // operator explicitly asks for them.
    process.env.EXVEST_IB_MARKET_DATA_TYPE = '4';
    expect(marketDataTypeForMode('ib-live')).toBe(REALTIME);
    expect(marketDataTypeForMode('ib-live-confirm')).toBe(REALTIME);
  });

  it('allows delayed data in paper mode, where nothing real is at stake', () => {
    expect(marketDataTypeForMode('ib-paper')).toBe(DELAYED_FROZEN);
  });

  it('honours the env override outside live-money modes', () => {
    process.env.EXVEST_IB_MARKET_DATA_TYPE = '1';
    expect(marketDataTypeForMode('ib-paper')).toBe(REALTIME);
  });

  it('falls back to delayed-frozen for an out-of-range override', () => {
    process.env.EXVEST_IB_MARKET_DATA_TYPE = '99';
    expect(marketDataTypeForMode('ib-paper')).toBe(DELAYED_FROZEN);
  });
});
