/**
 * Market-clock helpers.
 *
 * The exchange session is what matters here, not the user's wall clock: the
 * app is used from any timezone but the options always trade on US markets.
 * All of this is anchored to America/New_York so DST is handled by the
 * runtime's tz database rather than a hardcoded UTC offset.
 */

export const EXCHANGE_TIME_ZONE = 'America/New_York';

/** Regular US equity/options session close, in exchange-local time. */
const CLOSE_HOUR = 16;
const CLOSE_MINUTE = 0;

interface ExchangeNow {
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday … 6 = Saturday
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

/** Current wall-clock time at the exchange, regardless of where the user is. */
export function exchangeNow(now: Date = new Date()): ExchangeNow {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: EXCHANGE_TIME_ZONE,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // hourCycle h23 can render midnight as "24"; normalise it to 0.
  const hour = Number(get('hour')) % 24;

  return {
    hour,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0
  };
}

/**
 * Milliseconds remaining until the exchange's regular close (16:00 ET) today.
 * Returns 0 outside a regular session — before it would be misleading to count
 * down to a close that has already happened, and weekends have no session.
 *
 * Note this tracks the regular session only; it does not know about exchange
 * holidays or half days (early 13:00 closes), so on those dates it will
 * over-report. Wiring in a holiday calendar would need a data source the app
 * does not currently have.
 */
export function msUntilExchangeClose(now: Date = new Date()): number {
  const { hour, minute, second, weekday } = exchangeNow(now);
  if (weekday === 0 || weekday === 6) return 0;

  const secondsNow = hour * 3600 + minute * 60 + second;
  const secondsClose = CLOSE_HOUR * 3600 + CLOSE_MINUTE * 60;
  return Math.max(0, (secondsClose - secondsNow) * 1000);
}

/** Formats a millisecond duration as HH:MM:SS. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
