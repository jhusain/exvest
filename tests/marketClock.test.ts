import { describe, it, expect } from 'vitest';
import {
  exchangeNow,
  formatDuration,
  msUntilExchangeClose,
  msUntilSessionClose,
  parseIbTradingHours
} from '../src/shared/marketClock';

const HOUR = 3_600_000;
const MINUTE = 60_000;

describe('exchangeNow', () => {
  it('reports New York time, not the host timezone', () => {
    // 2026-07-30T14:24:00Z === 10:24 EDT (UTC-4).
    const { hour, minute, weekday } = exchangeNow(new Date('2026-07-30T14:24:00Z'));
    expect(hour).toBe(10);
    expect(minute).toBe(24);
    expect(weekday).toBe(4); // Thursday
  });

  it('maps a Prague morning to the pre-open New York hour', () => {
    // 10:24 in Prague (CEST, UTC+2) is 04:24 in New York — well before the
    // 09:30 open. The old countdown used the *local* 16:00, which is why it
    // showed ~5h from Prague instead of the true ~11h36m to the NY close.
    const { hour, minute } = exchangeNow(new Date('2026-07-30T10:24:00+02:00'));
    expect(hour).toBe(4);
    expect(minute).toBe(24);
  });

  it('handles the EST/EDT switch via the tz database', () => {
    // January is EST (UTC-5), so the same UTC instant is an hour earlier.
    expect(exchangeNow(new Date('2026-01-15T14:24:00Z')).hour).toBe(9);
    expect(exchangeNow(new Date('2026-07-15T14:24:00Z')).hour).toBe(10);
  });
});

describe('msUntilExchangeClose', () => {
  it('counts down to 16:00 New York from mid-session', () => {
    // 10:24 EDT → 5h36m until the 16:00 close.
    const ms = msUntilExchangeClose(new Date('2026-07-30T14:24:00Z'));
    expect(ms).toBe(5 * HOUR + 36 * MINUTE);
  });

  it('counts the full pre-open gap from a European morning', () => {
    // 10:24 Prague === 04:24 New York → 11h36m to the close, not the 5h36m
    // the old local-16:00 countdown produced.
    const ms = msUntilExchangeClose(new Date('2026-07-30T10:24:00+02:00'));
    expect(ms).toBe(11 * HOUR + 36 * MINUTE);
  });

  it('is unaffected by the observer being in another timezone', () => {
    // Same instant, expressed with a +02:00 offset: must give the same answer.
    const utc = msUntilExchangeClose(new Date('2026-07-30T14:24:00Z'));
    const prague = msUntilExchangeClose(new Date('2026-07-30T16:24:00+02:00'));
    expect(prague).toBe(utc);
  });

  it('returns 0 after the close', () => {
    expect(msUntilExchangeClose(new Date('2026-07-30T20:30:00Z'))).toBe(0); // 16:30 EDT
  });

  it('returns 0 at weekends', () => {
    expect(msUntilExchangeClose(new Date('2026-08-01T14:00:00Z'))).toBe(0); // Saturday
    expect(msUntilExchangeClose(new Date('2026-08-02T14:00:00Z'))).toBe(0); // Sunday
  });

  it('counts a full session from the open', () => {
    // 09:30 EDT → 6h30m.
    expect(msUntilExchangeClose(new Date('2026-07-30T13:30:00Z'))).toBe(6 * HOUR + 30 * MINUTE);
  });
});

describe('formatDuration', () => {
  it('renders HH:MM:SS zero-padded', () => {
    expect(formatDuration(5 * HOUR + 36 * MINUTE + 7000)).toBe('05:36:07');
    expect(formatDuration(0)).toBe('00:00:00');
  });

  it('clamps negatives to zero', () => {
    expect(formatDuration(-5000)).toBe('00:00:00');
  });
});

describe('parseIbTradingHours', () => {
  const TZ = 'US/Eastern';

  it('parses the full-schedule format into absolute instants', () => {
    const sessions = parseIbTradingHours('20260730:0930-20260730:1600', TZ);
    expect(sessions).toHaveLength(1);
    // 09:30 EDT === 13:30Z, 16:00 EDT === 20:00Z
    expect(new Date(sessions[0].start).toISOString()).toBe('2026-07-30T13:30:00.000Z');
    expect(new Date(sessions[0].end).toISOString()).toBe('2026-07-30T20:00:00.000Z');
  });

  it('parses the legacy same-day format', () => {
    const sessions = parseIbTradingHours('20260730:0930-1600', TZ);
    expect(new Date(sessions[0].end).toISOString()).toBe('2026-07-30T20:00:00.000Z');
  });

  it('skips CLOSED days — this is what fixes holiday over-reporting', () => {
    const sessions = parseIbTradingHours('20261126:CLOSED;20261127:0930-20261127:1300', TZ);
    expect(sessions).toHaveLength(1);
    // Thanksgiving is skipped; the following half day closes at 13:00, not 16:00.
    expect(new Date(sessions[0].end).toISOString()).toBe('2026-11-27T18:00:00.000Z');
  });

  it('applies the exchange offset in winter (EST) as well as summer (EDT)', () => {
    const winter = parseIbTradingHours('20260115:0930-20260115:1600', TZ);
    // 16:00 EST === 21:00Z (one hour later in UTC than the EDT case).
    expect(new Date(winter[0].end).toISOString()).toBe('2026-01-15T21:00:00.000Z');
  });

  it('handles a session wrapping past midnight in the legacy format', () => {
    const sessions = parseIbTradingHours('20260730:1700-0300', TZ);
    expect(sessions[0].end).toBeGreaterThan(sessions[0].start);
    expect(sessions[0].end - sessions[0].start).toBe(10 * 3_600_000);
  });

  it('returns [] for missing or unparseable input', () => {
    expect(parseIbTradingHours(undefined, TZ)).toEqual([]);
    expect(parseIbTradingHours('', TZ)).toEqual([]);
    expect(parseIbTradingHours('not-a-schedule', TZ)).toEqual([]);
  });
});

describe('msUntilSessionClose', () => {
  const sessions = parseIbTradingHours('20261127:0930-20261127:1300', 'US/Eastern');

  it('counts down to the broker-reported close, including half days', () => {
    // 11:00 EST on the half day → 2h to the 13:00 close.
    const ms = msUntilSessionClose(sessions, new Date('2026-11-27T16:00:00Z'));
    expect(ms).toBe(2 * 3_600_000);
  });

  it('returns null outside any session rather than guessing', () => {
    expect(msUntilSessionClose(sessions, new Date('2026-11-27T19:00:00Z'))).toBeNull(); // after close
    expect(msUntilSessionClose(sessions, new Date('2026-11-27T12:00:00Z'))).toBeNull(); // pre-open
    expect(msUntilSessionClose([], new Date())).toBeNull();
  });
});
