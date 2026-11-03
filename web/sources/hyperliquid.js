// Hyperliquid (공개 시세, 키 없음). 나스닥100 선물 = trade.xyz HIP-3 시장 `xyz:XYZ100` (SPEC §2.9).
// - 과거 봉: candleSnapshot (봉 종류마다 최근 약 5000개까지) → 받아서 저장소에 쌓는다
// - 실시간: WebSocket 1개에 candle·activeAssetCtx 여러 구독
// 주문·지갑 기능은 쓰지 않는다.
import { ReconnectingWS } from "./reconnect.js";
import { postJson } from "../platform.js";
import { createLimiter } from "../core/limit.js";
import { setSourceStatus } from "./status.js";

const INFO = "https://api.hyperliquid.xyz/info";
const WS = "wss://api.hyperliquid.xyz/ws";
export const TF = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1D": "1d", "1W": "1w" };
const queue = createLimiter(1, 300);

const toRow = (r) => ({ t: r.t / 1000, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v });

/** 봉 받기: startSec부터 지금까지 (최대 약 5000개, 거래소가 주는 만큼) */
export async function candles(coin, tf, startSec = 0, endSec = null) {
  try {
    const rows = await queue(() =>
      postJson(INFO, {
        type: "candleSnapshot",
        req: { coin, interval: TF[tf], startTime: Math.floor(startSec * 1000), endTime: Math.floor((endSec ?? Date.now() / 1000 + 60) * 1000) },
      })
    );
    setSourceStatus("Hyperliquid", true);
    return (rows ?? []).map(toRow);
  } catch (e) {
    setSourceStatus("Hyperliquid", false);
    throw e;
  }
}

/** dex 안의 전체 종목 (종목 검색용), 예: ["xyz:XYZ100", ...] */
export async function listAll(dex = "xyz") {
  try {
    return Object.keys(await postJson(INFO, { type: "allMids", dex }));
  } catch {
    return [];
  }
}

// ── 실시간 ──
let ws = null;
const candleSubs = new Map(); // "xyz:XYZ100|5m" → Set(cb)
const ctxSubs = new Map(); // coin → Set(cb)

function ensureWs() {
  if (ws) return;
  ws = new ReconnectingWS({
    name: "Hyperliquid",
    url: WS,
    onOpen: (w) => {
      for (const coin of ctxSubs.keys()) w.send({ method: "subscribe", subscription: { type: "activeAssetCtx", coin } });
      for (const key of candleSubs.keys()) {
        const [coin, interval] = key.split("|");
        w.send({ method: "subscribe", subscription: { type: "candle", coin, interval } });
      }
    },
    onMessage,
    idleMs: 60000,
    pingMs: 30000,
    ping: { method: "ping" },
  });
  ws.start();
}

function onMessage(msg) {
  const d = msg.data;
  if (msg.channel === "candle" && d) {
    const subs = candleSubs.get(`${d.s}|${d.i}`);
    if (subs) for (const cb of subs) cb(toRow(d));
  } else if (msg.channel === "activeAssetCtx" && d?.ctx) {
    const subs = ctxSubs.get(d.coin);
    const price = +(d.ctx.midPx ?? d.ctx.markPx);
    if (subs && price) for (const cb of subs) cb({ price, prevClose: +d.ctx.prevDayPx, ts: Date.now() / 1000 });
  }
}

/** 봉 실시간 구독 → 해제 함수 */
export function subscribeCandles(coin, tf, cb) {
  ensureWs();
  const interval = TF[tf];
  const key = `${coin}|${interval}`;
  if (!candleSubs.has(key)) {
    candleSubs.set(key, new Set());
    ws.send({ method: "subscribe", subscription: { type: "candle", coin, interval } });
  }
  candleSubs.get(key).add(cb);
  return () => {
    const set = candleSubs.get(key);
    if (!set) return;
    set.delete(cb);
    if (!set.size) {
      candleSubs.delete(key);
      ws?.send({ method: "unsubscribe", subscription: { type: "candle", coin, interval } });
    }
  };
}

/** 현재가 실시간 구독 (prevClose = 24시간 전 가격) */
export function subscribeQuote(coin, cb) {
  ensureWs();
  if (!ctxSubs.has(coin)) {
    ctxSubs.set(coin, new Set());
    ws.send({ method: "subscribe", subscription: { type: "activeAssetCtx", coin } });
  }
  ctxSubs.get(coin).add(cb);
  return () => {
    const set = ctxSubs.get(coin);
    if (!set) return;
    set.delete(cb);
    if (!set.size) {
      ctxSubs.delete(coin);
      ws?.send({ method: "unsubscribe", subscription: { type: "activeAssetCtx", coin } });
    }
  };
}
