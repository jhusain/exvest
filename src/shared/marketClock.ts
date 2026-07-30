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

/** A single continuous trading session, as absolute instants. */
export interface TradingSession {
  start: number; // epoch ms
  end: number; // epoch ms
}

/**
 * Offset of `timeZone` from UTC at the given instant, in ms.
 * Derived by formatting the instant in that zone and diffing against UTC,
 * so it follows the runtime tz database (including DST) with no hardcoding.
 */
function timeZoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - at.getTime();
}

/**
 * Converts a wall-clock time in `timeZone` to an absolute instant.
 * Resolved iteratively: the offset depends on the instant we are still
 * solving for, so we apply a first guess and then correct once, which
 * settles the DST-transition cases.
 */
function zonedWallClockToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute);
  let epoch = naiveUtc - timeZoneOffsetMs(new Date(naiveUtc), timeZone);
  epoch = naiveUtc - timeZoneOffsetMs(new Date(epoch), timeZone);
  return epoch;
}

/**
 * Parses IB's `liquidHours` / `tradingHours` string from ContractDetails into
 * absolute sessions. This is the authoritative schedule — it already accounts
 * for exchange holidays (emitted as `CLOSED`) and half days, which a
 * hardcoded 16:00 cannot.
 *
 * Handles the two formats IB emits:
 *   "20260730:0930-20260730:1600;20260731:CLOSED"   (full schedule)
 *   "20260730:0930-1600;20260731:CLOSED"            (legacy, same-day implied)
 *
 * Returns [] for anything unparseable, which callers treat as "no schedule
 * available" and fall back to the regular-session assumption.
 */
export function parseIbTradingHours(hours: string | undefined, timeZone: string): TradingSession[] {
  if (!hours) return [];
  const zone = timeZone || EXCHANGE_TIME_ZONE;
  const sessions: TradingSession[] = [];

  for (const segment of hours.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed || trimmed.toUpperCase().endsWith('CLOSED')) continue;

    // Either "YYYYMMDD:HHMM-YYYYMMDD:HHMM" or "YYYYMMDD:HHMM-HHMM".
    const match =
      /^(\d{8}):(\d{4})-(\d{8}):(\d{4})$/.exec(trimmed) ?? /^(\d{8}):(\d{4})-(\d{4})$/.exec(trimmed);
    if (!match) continue;

    const startDate = match[1];
    const startTime = match[2];
    const endDate = match.length === 5 ? match[3] : match[1];
    const endTime = match.length === 5 ? match[4] : match[3];

    const toEpoch = (date: string, time: string) =>
      zonedWallClockToEpoch(
        Number(date.slice(0, 4)),
        Number(date.slice(4, 6)),
        Number(date.slice(6, 8)),
        Number(time.slice(0, 2)),
        Number(time.slice(2, 4)),
        zone
      );

    const start = toEpoch(startDate, startTime);
    let end = toEpoch(endDate, endTime);
    // Legacy same-day form can wrap past midnight (e.g. 1700-0300).
    if (end <= start) end += 24 * 3600 * 1000;

    sessions.push({ start, end });
  }

  return sessions.sort((a, b) => a.start - b.start);
}

/**
 * Milliseconds until the end of the session currently in progress, using the
 * broker-supplied schedule. Returns null when no session covers `now` — the
 * market is shut, and the caller should show no countdown rather than guess.
 */
export function msUntilSessionClose(sessions: TradingSession[], now: Date = new Date()): number | null {
  const t = now.getTime();
  const current = sessions.find((s) => t >= s.start && t < s.end);
  return current ? current.end - t : null;
}

/** Formats a millisecond duration as HH:MM:SS. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
