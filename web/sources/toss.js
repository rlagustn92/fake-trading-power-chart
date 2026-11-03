// 토스증권 (국내·미국 주식, 코스피·코스닥 현재가 1순위). 모든 호출은 Rust 관문 `toss_get`(조회 전용, 시세 3개 경로)으로만.
// 키·토큰은 같은 PC의 Market Board와 같이 쓴다 (src-tauri/src/toss.rs) → 서로 끊지 않는다.
// 다른 PC가 토큰을 가져가면 '대기' → Yahoo로 대신 보여준다.
import { invoke, inTauri } from "../platform.js";
import { setSourceStatus } from "./status.js";

let key = { saved: false, hint: null, standby: false };

export async function keyStatus() {
  if (!inTauri) return key;
  try {
    key = (await invoke("toss_key_status", {})) ?? key;
  } catch {}
  return key;
}

export async function saveKey(clientId, clientSecret) {
  key = await invoke("toss_save_key", { clientId, clientSecret });
  return key;
}

export const hasKey = () => !!key.saved;
export const isStandby = () => !!key.standby;
export const keyInfo = () => key;

async function call(path, query) {
  try {
    const text = await invoke("toss_get", { path, query: Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]) });
    key.standby = false;
    setSourceStatus("Toss", true);
    return JSON.parse(text).result;
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (msg.startsWith("standby")) key.standby = true;
    setSourceStatus("Toss", false);
    throw new Error(msg);
  }
}

const INDEX = { "^KS11": "KOSPI", "^KQ11": "KOSDAQ" };
const code = (id) => id.replace(/\.(KS|KQ)$/, "").replace(/-/g, "."); // 005930.KS → 005930, BRK-B → BRK.B

/** 토스로 받을 수 있는 종목인지 (국내 주식·ETF, 코스피·코스닥 지수) */
export const tossable = (id) => /\.(KS|KQ)$/.test(id) || id in INDEX;

/** 현재가 → Map(id → {price, ts}) */
export async function prices(ids) {
  const out = new Map();
  const now = Date.now() / 1000;
  const stocks = ids.filter((id) => !(id in INDEX));
  const idx = ids.filter((id) => id in INDEX);
  if (stocks.length) {
    const byCode = new Map(stocks.map((id) => [code(id), id]));
    for (const r of (await call("/api/v1/prices", { symbols: [...byCode.keys()].join(",") })) ?? []) {
      const id = byCode.get(r.symbol);
      if (id && +r.lastPrice > 0) out.set(id, { price: +r.lastPrice, ts: now });
    }
  }
  if (idx.length) {
    const byName = new Map(idx.map((id) => [INDEX[id], id]));
    for (const r of (await call("/api/v1/market-indicators/prices", { symbols: [...byName.keys()].join(",") })) ?? []) {
      const id = byName.get(r.symbol);
      if (id && +r.lastPrice > 0) out.set(id, { price: +r.lastPrice, ts: now });
    }
  }
  return out;
}

const toRows = (page) =>
  (page?.candles ?? [])
    .map((c) => ({ t: Date.parse(c.timestamp) / 1000, o: +c.openPrice, h: +c.highPrice, l: +c.lowPrice, c: +c.closePrice, v: +c.volume || 0 }))
    .filter((k) => k.t > 0 && k.c > 0)
    .sort((a, b) => a.t - b.t);

/** 최근 1분봉 (국내 주식·ETF) → 시간순 [{t,o,h,l,c,v}] */
export async function candles1m(id, count = 60) {
  return toRows(await call("/api/v1/candles", { symbol: code(id), interval: "1m", count }));
}

/**
 * 캔들 한 쪽: before(유닉스 초) 이전·같은 봉 count개 → {rows(시간순), next(다음 쪽 before 글자)}
 * 모의매매: 토스가 국내 1분봉을 얼마나 옛날까지 주는지 확인 (trade/history.js probeToss)
 */
export async function candlesPage(id, { interval = "1m", count = 200, before = null } = {}) {
  // 문서 예: before=2026-03-25T09:00:00+09:00 (한국 시각)
  const kst = before == null ? null : `${new Date((before + 9 * 3600) * 1000).toISOString().slice(0, 19)}+09:00`;
  // 수정주가가 아닌 실제 거래가로 (저장소는 실제 거래가, 분할은 화면에서 반영 — 야후 분봉과 같은 규칙)
  const page = await call("/api/v1/candles", { symbol: code(id), interval, count, before: kst, adjusted: "false" });
  return { rows: toRows(page), next: page?.nextBefore ?? null };
}
