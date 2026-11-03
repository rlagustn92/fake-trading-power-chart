// Binance USDⓈ-M 선물 (공개 시세, 키 없음). 미국 ETF·국내 대형주 TradFi 무기한선물 → 24시간 추정(SPEC §2.6).
// 과거 봉: klines (요청당 1500개), 실시간: combined stream 하나에 kline·miniTicker 구독
import { ReconnectingWS } from "./reconnect.js";
import { getJson, loadFile, saveFile } from "../platform.js";
import { createLimiter } from "../core/limit.js";
import { setSourceStatus } from "./status.js";

const REST = "https://fapi.binance.com";
const WS = "wss://fstream.binance.com/market/stream";
export const TF = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1D": "1d", "1W": "1w" };
const DAY_MS = 86400e3;
const queue = createLimiter(2, 200);

const toRow = (r) => ({ t: r[0] / 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });

// ── 바이낸스 한도 (0.12.1, 사용자와 정함 2026-11-01: "한도의 50%로") ──
// IP 하나에 1분 동안 무게 2,400까지. 넘기면 429(경고), 계속 넘기면 418(IP를 몇 분~며칠 막음).
// 봉 요청 무게: 1~99개 1 · 100~499개 2 · 500~1,000개 5 · 1,001~1,500개 10 → 과거 봉 받기는 1,000개씩(같은 무게로 1.5배)
// 과거 봉 받기(bulk)는 1분에 1,200(절반)까지, 보고 있는 차트까지 합쳐도 1,600까지만 쓴다 (원본 앱 등 같은 IP 몫을 남긴다)
const BUDGET_BULK = 1200;
const BUDGET_ALL = 1600;
export const weightOf = (limit) => (limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10);
const spent = []; // [보낸 시각 ms, 무게, bulk]
let coolUntil = 0; // 429·418을 받으면 잠깐 전부 쉰다
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function takeBudget(w, bulk) {
  for (;;) {
    const now = Date.now();
    while (spent.length && spent[0][0] < now - 60e3) spent.shift();
    let all = 0;
    let mine = 0;
    for (const [, x, b] of spent) {
      all += x;
      if (b) mine += x;
    }
    const ok = now >= coolUntil && all + w <= BUDGET_ALL && (!bulk || mine + w <= BUDGET_BULK);
    if (ok) {
      spent.push([now, w, bulk]);
      return;
    }
    await sleep(Math.min(Math.max(coolUntil - now, spent.length ? spent[0][0] + 60e3 - now : 0, 0) + 50, 5000));
  }
}

/** 봉 받기: startSec부터 최대 1500개. bulk = 과거 봉 받기 (한도의 절반 안에서) */
export async function klines(symbol, tf, { startSec = null, endSec = null, limit = 1500, bulk = false } = {}) {
  let url = `${REST}/fapi/v1/klines?symbol=${symbol}&interval=${TF[tf]}&limit=${limit}`;
  if (startSec != null) url += `&startTime=${Math.floor(startSec * 1000)}`;
  if (endSec != null) url += `&endTime=${Math.floor(endSec * 1000)}`;
  await takeBudget(weightOf(limit), bulk);
  try {
    const rows = await queue(() => getJson(url));
    setSourceStatus("Binance", true);
    return rows.map(toRow);
  } catch (e) {
    const m = /HTTP (418|429)/.exec(String(e?.message ?? e));
    if (m) coolUntil = Date.now() + (m[1] === "418" ? 5 * 60e3 : 60e3); // 너무 많이 보냈다 → 잠깐 전부 멈춤
    setSourceStatus("Binance", false);
    throw e;
  }
}

/** TradFi 무기한선물 목록 (하루 한 번만 다시 받고 캐시) → Map(symbol → {type, underlying}) */
export async function symbols() {
  const cache = await loadFile("binance_symbols.json");
  if (cache && Date.now() - cache.ts < DAY_MS) return new Map(cache.symbols);
  try {
    const d = await getJson(`${REST}/fapi/v1/exchangeInfo`);
    const list = d.symbols
      .filter((s) => s.status === "TRADING" && (s.contractType === "TRADIFI_PERPETUAL" || s.contractType === "PERPETUAL"))
      .map((s) => [s.symbol, { type: s.contractType, underlying: s.underlyingType, base: s.baseAsset }]);
    saveFile("binance_symbols.json", { ts: Date.now(), symbols: list });
    return new Map(list);
  } catch (e) {
    console.warn("[binance] exchangeInfo 실패", e);
    return cache ? new Map(cache.symbols) : new Map();
  }
}

// ── 실시간 ──
let ws = null;
let reqId = 1;
const subs = new Map(); // stream → Set(cb)

function ensureWs() {
  if (ws) return;
  ws = new ReconnectingWS({
    name: "Binance",
    url: () => `${WS}?streams=${[...subs.keys()].join("/") || "btcusdt@miniTicker"}`,
    // 연결되는 사이에 추가된 구독도 빠지지 않게 다시 한 번 구독 (이미 있는 것은 무시된다)
    onOpen: (w) => subs.size && w.send({ method: "SUBSCRIBE", params: [...subs.keys()], id: reqId++ }),
    onMessage: (msg) => {
      const set = subs.get(msg.stream);
      const d = msg.data;
      if (!set || !d) return;
      if (d.e === "kline") {
        const k = d.k;
        const row = { t: k.t / 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v };
        for (const cb of set) cb(row);
      } else if (d.e === "24hrMiniTicker") {
        for (const cb of set) cb({ price: +d.c, prevClose: +d.o, ts: d.E / 1000 });
      }
    },
    idleMs: 30000,
  });
  ws.start();
}

function subscribe(stream, cb) {
  const fresh = !subs.has(stream);
  if (fresh) subs.set(stream, new Set());
  subs.get(stream).add(cb);
  if (!ws) ensureWs();
  else if (fresh) ws.send({ method: "SUBSCRIBE", params: [stream], id: reqId++ });
  return () => {
    const set = subs.get(stream);
    if (!set) return;
    set.delete(cb);
    if (!set.size) {
      subs.delete(stream);
      ws?.send({ method: "UNSUBSCRIBE", params: [stream], id: reqId++ });
    }
  };
}

export const subscribeCandles = (symbol, tf, cb) => subscribe(`${symbol.toLowerCase()}@kline_${TF[tf]}`, cb);
/** 현재가 (prevClose = 24시간 전 가격) */
export const subscribeQuote = (symbol, cb) => subscribe(`${symbol.toLowerCase()}@miniTicker`, cb);
