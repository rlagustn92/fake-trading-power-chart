// OKX 무기한선물 (공개 시세, 키 없음, 읽기 전용). 0.25.0 사용자 요청 2026-11-23: "OKX도 추가해서 코인하고 주식선물".
// - 코인(약 300개) · 주식 선물(약 230개: 애플·엔비디아·QQQ, 삼성전자·SK하이닉스·EWY …, 2026-02~ 상장) · 원자재(금·은·원유 …)
// - 과거 봉: /api/v5/market/history-candles (요청당 100개, 상장일부터 다 준다). 바이낸스 klines와 같은 모양(klines)으로 감싸서
//   리플레이용 과거 1분봉 받기(trade/history.js)를 그대로 쓴다
// - 한도: IP 하나에 2초 동안 20번 → 절반(1초 5번)만 쓴다 (바이낸스와 같은 "한도의 50%", 0.12.1 사용자 결정)
// - 일·주봉은 홍콩 시각(UTC+8) 기준이 기본이라 UTC 기준(1Dutc·1Wutc)으로 받는다 → 바이낸스·하이퍼리퀴드 일봉과 같은 날짜
// - 실시간: 봉 = business 웹소켓(candle…), 현재가 = public 웹소켓(tickers). 주문·계정 기능은 쓰지 않는다
import { ReconnectingWS } from "./reconnect.js";
import { getJson, loadFile, saveFile } from "../platform.js";
import { createLimiter } from "../core/limit.js";
import { setSourceStatus } from "./status.js";

const REST = "https://www.okx.com";
const WS_BIZ = "wss://ws.okx.com:8443/ws/v5/business";
const WS_PUB = "wss://ws.okx.com:8443/ws/v5/public";
export const TF = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "4h": "4H", "1D": "1Dutc", "1W": "1Wutc" };
const SEC = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1D": 86400, "1W": 7 * 86400 };
const PAGE = 100; // history-candles 한 번에 최대
const DAY_MS = 86400e3;
const queue = createLimiter(1, 200); // 1초 5번 = 한도의 절반
let coolUntil = 0; // 429를 받으면 잠깐 전부 쉰다
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** OKX 봉 한 줄 [ts, o, h, l, c, vol(계약 수), volCcy(코인·주식 수), volCcyQuote(USDT), confirm] → {t,o,h,l,c,v} (거래량 = 코인·주식 수, 바이낸스와 같게) */
export const toRow = (r) => ({ t: +r[0] / 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6] });

/** 한 쪽 받기: after(이 시각 ms보다 앞) · before(이 시각 ms보다 뒤) → 시간순 [{t…}] */
async function realPage(instId, tf, { after = null, before = null, limit = PAGE } = {}) {
  let url = `${REST}/api/v5/market/history-candles?instId=${instId}&bar=${TF[tf]}&limit=${limit}`;
  if (after != null) url += `&after=${Math.floor(after)}`;
  if (before != null) url += `&before=${Math.floor(before)}`;
  for (let tries = 0; ; tries++) {
    if (Date.now() < coolUntil) await sleep(coolUntil - Date.now());
    try {
      const d = await queue(() => getJson(url));
      if (d?.code !== "0") throw new Error(`OKX ${d?.code} ${d?.msg ?? ""}`.trim());
      setSourceStatus("OKX", true);
      return (d.data ?? []).map(toRow).reverse();
    } catch (e) {
      const busy = /HTTP 429|OKX 50011/.test(String(e?.message ?? e));
      if (busy) coolUntil = Date.now() + 2000; // 너무 많이 보냈다 → 2초 쉬고 한 번 더
      if (!busy || tries >= 1) {
        setSourceStatus("OKX", false);
        throw e;
      }
    }
  }
}

/** 상장 시각(초)을 알려 주는 함수: instId → 초 | null (목록에서) */
async function listSecOf(instId) {
  const m = (await symbols().catch(() => new Map())).get(instId);
  return m?.listTime ? Math.floor(m.listTime / 1000) : null;
}

/**
 * 바이낸스 klines와 같은 약속으로 봉 받기 (trade/history.js·core/intraday.js가 거래소를 가리지 않고 쓴다):
 * - startSec 있음: 그 시각부터 앞으로 (endSec까지 또는 지금까지) 최대 limit개, 시간순
 * - startSec 없음: endSec(없으면 지금)까지의 마지막 limit개, 시간순
 * getPage·listSec은 시험에서 가짜로 바꿔 끼운다
 */
export function makeKlines(getPage, listSec, now = () => Date.now() / 1000) {
  return async function klines(instId, tf, { startSec = null, endSec = null, limit = 1500 } = {}) {
    const sec = SEC[tf];
    if (!sec) return [];
    const out = [];
    if (startSec != null) {
      // 상장 전부터 물으면(예: 0 = "첫 봉") 빈 쪽을 하나씩 넘기지 않게 상장 시각으로 당긴다
      let s = Math.floor(startSec / sec) * sec;
      const listed = await listSec(instId);
      if (listed != null && s < listed) s = Math.floor(listed / sec) * sec;
      const end = endSec ?? now();
      let empty = 0;
      while (out.length < limit && s <= end && empty < 60) {
        const e = s + PAGE * sec; // [s, e) 안의 봉 (꽉 차면 100개). limit이 작아도(첫 봉 1개) 한 쪽씩 봐야 빈 분을 하나씩 묻지 않는다
        const rows = (await getPage(instId, tf, { after: e * 1000, before: s * 1000 - 1, limit: PAGE })).filter((k) => k.t >= s && k.t < e && k.t <= end);
        if (rows.length) {
          out.push(...rows);
          s = rows[rows.length - 1].t + sec;
          empty = 0;
        } else {
          s = e; // 그 사이에 봉이 없다 (거래가 멈췄던 때) → 다음 쪽
          empty++;
        }
      }
      return out.slice(0, limit);
    }
    // 끝에서 뒤로
    let after = endSec != null ? endSec * 1000 + 1 : null;
    while (out.length < limit) {
      const n = Math.min(PAGE, limit - out.length);
      const rows = await getPage(instId, tf, { after, limit: n });
      if (!rows.length) break;
      out.unshift(...rows);
      after = rows[0].t * 1000;
      if (rows.length < n) break; // 상장일까지 왔다
    }
    return out;
  };
}

export const klines = makeKlines(realPage, listSecOf);

/** 무기한선물 목록 (USDT 정산, 거래 중. 하루 한 번만 다시 받고 캐시) → Map(instId → {base, cat, listTime}) */
let symMemo = null;
export async function symbols() {
  if (symMemo && Date.now() - symMemo.ts < DAY_MS) return symMemo.map;
  const cache = await loadFile("okx_symbols.json");
  if (cache && Date.now() - cache.ts < DAY_MS) {
    symMemo = { ts: cache.ts, map: new Map(cache.symbols) };
    return symMemo.map;
  }
  try {
    const d = await getJson(`${REST}/api/v5/public/instruments?instType=SWAP`);
    const list = (d.data ?? [])
      .filter((x) => x.state === "live" && x.settleCcy === "USDT" && x.instId.endsWith("-USDT-SWAP"))
      .map((x) => [x.instId, { base: x.instId.replace(/-USDT-SWAP$/, ""), cat: String(x.instCategory ?? ""), listTime: +x.listTime || null }]);
    saveFile("okx_symbols.json", { ts: Date.now(), symbols: list });
    symMemo = { ts: Date.now(), map: new Map(list) };
    return symMemo.map;
  } catch (e) {
    console.warn("[okx] instruments 실패", e);
    return cache ? new Map(cache.symbols) : new Map();
  }
}

// ── 실시간 ──
// 같은 모양의 연결 두 개: business(봉) · public(현재가). 끊기면 reconnect.js가 다시 맺고 onOpen에서 다시 구독한다
function channelSet(url) {
  const subs = new Map(); // "채널|instId" → Set(cb)
  let ws = null;
  const arg = (key) => {
    const [channel, instId] = key.split("|");
    return { channel, instId };
  };
  const ensure = () => {
    if (ws) return;
    ws = new ReconnectingWS({
      name: "OKX",
      url,
      onOpen: (w) => subs.size && w.send({ op: "subscribe", args: [...subs.keys()].map(arg) }),
      onMessage: (msg) => {
        const a = msg?.arg;
        if (!a || !Array.isArray(msg.data)) return; // 구독 확인·오류 알림
        const set = subs.get(`${a.channel}|${a.instId}`);
        if (set) for (const d of msg.data) for (const cb of set) cb(d);
      },
      idleMs: 60000,
      pingMs: 25000,
      ping: "ping", // OKX는 JSON이 아니라 글자 "ping" → "pong"
    });
    ws.start();
  };
  return function subscribe(channel, instId, cb) {
    const key = `${channel}|${instId}`;
    const fresh = !subs.has(key);
    if (fresh) subs.set(key, new Set());
    subs.get(key).add(cb);
    if (!ws) ensure();
    else if (fresh) ws.send({ op: "subscribe", args: [arg(key)] });
    return () => {
      const set = subs.get(key);
      if (!set) return;
      set.delete(cb);
      if (!set.size) {
        subs.delete(key);
        ws?.send({ op: "unsubscribe", args: [arg(key)] });
      }
    };
  };
}
const biz = channelSet(WS_BIZ);
const pub = channelSet(WS_PUB);

/** 봉 실시간 → 해제 함수 */
export const subscribeCandles = (instId, tf, cb) => biz(`candle${TF[tf]}`, instId, (r) => cb(toRow(r)));
/** 현재가 (prevClose = 24시간 전 가격, 바이낸스 miniTicker와 같게) */
export const subscribeQuote = (instId, cb) => pub("tickers", instId, (d) => +d.last > 0 && cb({ price: +d.last, prevClose: +d.open24h || null, ts: (+d.ts || Date.now()) / 1000 }));
