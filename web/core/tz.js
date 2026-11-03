// 시간대 도우미: 봉 시각(UTC 초) → 거래소 현지 날짜·시각.
// Intl은 느려서 "UTC 하루"마다 한 번만 계산해 기억한다. 서머타임은 일요일 새벽(UTC 01~07시)에
// 바뀌는데, 그 시간에 열린 장은 무기한선물(UTC 기준)뿐이라 하루 단위 기억으로 충분하다.

export const DAY = 86400;

/** 이 PC의 시간대(차트 시간축을 PC 현지 시각으로 보여주려고 더한다) */
export const PC_TZ = -new Date().getTimezoneOffset() * 60;

const fmts = new Map();
function dtf(tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmts.set(tz, f);
  }
  return f;
}

function computeOffset(tz, t) {
  const p = {};
  for (const x of dtf(tz).formatToParts(new Date(t * 1000))) p[x.type] = x.value;
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000;
  return Math.round((local - t) / 60) * 60;
}

const FIXED = { UTC: 0, "Asia/Seoul": 9 * 3600 };
const cache = new Map();

/** UTC에 더하면 현지 시각이 되는 초 */
export function tzOffset(tz, t) {
  const fixed = FIXED[tz];
  if (fixed !== undefined) return fixed;
  const day = Math.floor(t / DAY);
  let m = cache.get(tz);
  if (!m) cache.set(tz, (m = new Map()));
  let off = m.get(day);
  if (off === undefined) {
    off = computeOffset(tz, day * DAY + DAY / 2);
    m.set(day, off);
  }
  return off;
}

/** 현지 날짜를 "그 날짜의 UTC 0시"로 (일봉 시각 표기: 2026-10-23 → 1792713600) */
export function localDay(tz, t) {
  return Math.floor((t + tzOffset(tz, t)) / DAY) * DAY;
}

/** 현지 하루 중 몇 초째인지 */
export function localSec(tz, t) {
  const l = t + tzOffset(tz, t);
  return l - Math.floor(l / DAY) * DAY;
}

const pad = (n) => String(n).padStart(2, "0");

/** 날짜 문자열 (UTC 0시 표기의 날짜 값 → 2026-10-23) */
export function ymd(dayT) {
  const d = new Date(dayT * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
}

/** 오늘(그 시간대 기준) 날짜 값 */
export function today(tz) {
  return localDay(tz, Math.floor(Date.now() / 1000));
}

/** 요일 (0=일 … 6=토) — 날짜 값 기준 */
export function weekday(dayT) {
  return (Math.floor(dayT / DAY) + 4) % 7;
}
