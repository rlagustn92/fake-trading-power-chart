// Yahoo 차트 JSON (비공식, 지연 시세). 일봉 전 기간·국내 종목·지수·환율·금리.
// 비공식이라 많이 부르면 막힐 수 있다(429). 그래서:
// - 동시에 2개까지, 요청 사이 0.25초 (줄 세우기)
// - 현재가는 spark로 여러 종목을 한 번에
// - 429·오류가 나면 다른 호스트로 바꾸고 2초·4초 쉬었다가 다시
// - User-Agent가 없으면 429를 돌려주므로 브라우저 UA를 붙인다
import { getJson, logInfo } from "../platform.js";
import { createLimiter, sleep } from "../core/limit.js";
import { setSourceStatus } from "./status.js";

const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" };
const FIRST = -2208994789; // "처음부터" (1900년)
const SPARK_MAX = 20;

const queue = createLimiter(2, 250);
let hostIdx = 0;
let calls = 0;
setInterval(() => {
  if (calls) logInfo(`yahoo calls last 10min: ${calls}`);
  calls = 0;
}, 10 * 60e3);

async function get(path, { front = false } = {}) {
  let err;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const d = await queue(() => {
        calls++;
        return getJson(HOSTS[hostIdx] + path, { headers: HEADERS });
      }, { front });
      setSourceStatus("Yahoo", true);
      return d;
    } catch (e) {
      err = e;
      hostIdx = (hostIdx + 1) % HOSTS.length; // 다음엔 다른 호스트로
      if (/HTTP 404/.test(e.message)) break; // 없는 종목은 다시 해도 같다
      await sleep(2000 * 2 ** attempt);
    }
  }
  setSourceStatus("Yahoo", false);
  throw err;
}

/** 차트 원본 결과 (meta, timestamp, indicators, events) */
export async function chart(symbol, q, opts) {
  const qs = Object.entries(q)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  const d = await get(`/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`, opts);
  const r = d?.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo: ${symbol} 데이터 없음 (${d?.chart?.error?.description ?? "?"})`);
  return r;
}

/** 일봉: from(UTC 초)부터 지금까지. from이 없으면 상장 첫날부터. */
export function daily(symbol, from = null, opts) {
  const now = Math.floor(Date.now() / 1000) + 86400;
  return chart(symbol, { period1: from ?? FIRST, period2: now, interval: "1d", events: "div,splits" }, opts);
}

/** 분봉: interval "1m"(30일, 한 번에 7일) "5m"(60일) "60m"(730일). from~to(없으면 지금)까지 */
export function intraday(symbol, interval, { from = null, to = null, days = null, prepost = false } = {}, opts) {
  const now = Math.floor(Date.now() / 1000) + 60;
  const q = { interval, includePrePost: prepost ? "true" : "false" };
  if (from != null) Object.assign(q, { period1: Math.floor(from), period2: Math.floor(to ?? now) });
  else q.range = `${days}d`;
  return chart(symbol, q, opts);
}

/** 결과 → 봉 목록 (빈 값이 있는 봉은 버린다) */
export function rows(r) {
  const ts = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0] ?? {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ t: ts[i], o, h, l, c, v: q.volume?.[i] ?? 0 });
  }
  return out;
}

/** 결과 → 분할·배당 (Yahoo 시각 그대로, 배당 금액은 분할 반영된 값) */
export function events(r) {
  const ev = r.events ?? {};
  const splits = Object.values(ev.splits ?? {}).map((s) => ({ t: s.date, a: +s.numerator, b: +s.denominator }));
  const divs = Object.values(ev.dividends ?? {}).map((d) => ({ t: d.date, amount: +d.amount }));
  return { splits, divs };
}

const lastOf = (a) => {
  for (let i = (a?.length ?? 0) - 1; i >= 0; i--) if (a[i] != null) return a[i];
  return null;
};

/**
 * 여러 종목 현재가를 spark로 한 번에 (20개씩).
 * @returns {Promise<Map<string, {price, prevClose, ts}>>}
 */
export async function spark(symbols) {
  const out = new Map();
  const list = [...new Set(symbols)];
  for (let k = 0; k < list.length; k += SPARK_MAX) {
    const chunk = list.slice(k, k + SPARK_MAX);
    let res;
    try {
      res = await get(`/v8/finance/spark?symbols=${chunk.map(encodeURIComponent).join(",")}&range=1d&interval=1m`);
    } catch {
      continue;
    }
    for (const sym of chunk) {
      const d = res?.[sym];
      const price = lastOf(d?.close);
      if (price == null) continue;
      out.set(sym, { price, prevClose: d.chartPreviousClose ?? d.previousClose, ts: lastOf(d.timestamp) });
    }
  }
  return out;
}

/** 영어 이름·티커 검색 (한글은 앱 안의 종목 목록에서 찾는다) */
export async function search(q) {
  const d = await get(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0`, { front: true });
  return (d.quotes ?? [])
    .filter((x) => x.symbol && ["EQUITY", "ETF", "INDEX", "FUTURE", "CURRENCY", "MUTUALFUND", "CRYPTOCURRENCY"].includes(x.quoteType))
    .map((x) => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol, type: x.quoteType, exchange: x.exchDisp || x.exchange }));
}
