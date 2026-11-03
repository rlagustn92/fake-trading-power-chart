// 알파카 (무료 Basic): 미국 주식·ETF 분봉. 키는 Rust 관문(alpaca_get) 안에만 있다(SPEC §2.5).
// - SIP(전체 거래소) 과거 봉: 최근 15분은 무료 플랜에서 막혀 있다 → 끝을 16분 전으로
// - IEX 봉: 실시간이지만 거래량이 일부뿐 → 최근 15분 화면 표시용으로만(저장하지 않음)
// - 가격은 adjustment=raw(실제 가격)로 받아 저장하고 분할은 화면에서 반영한다
import { invoke } from "../platform.js";
import { setSourceStatus } from "./status.js";

const TF = { "1m": "1Min", "5m": "5Min", "15m": "15Min", "1h": "1Hour", "1D": "1Day" };
let saved = null;

export async function keyStatus() {
  try {
    const s = await invoke("alpaca_key_status", {});
    saved = !!s?.saved;
    return s ?? { saved: false };
  } catch {
    saved = false;
    return { saved: false };
  }
}

export const hasKey = () => saved === true;

export async function saveKey(keyId, secret) {
  const s = await invoke("alpaca_save_key", { keyId, secret });
  saved = !!s?.saved;
  return s;
}

export async function deleteKey() {
  await invoke("alpaca_delete_key", {});
  saved = false;
}

async function get(path, query) {
  try {
    const body = await invoke("alpaca_get", { path, query: Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]) });
    setSourceStatus("Alpaca", true);
    return JSON.parse(body);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!msg.startsWith("no_key")) setSourceStatus("Alpaca", false);
    throw new Error(msg);
  }
}

const iso = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

function parseBars(list) {
  return (list ?? []).map((b) => ({ t: Date.parse(b.t) / 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}

/**
 * 봉 한 페이지. symbols 여러 개를 한 번에 물을 수 있다(limit은 전체 합계).
 * @returns {{bars: Map<string, row[]>, next: string|null}}
 */
export async function barsPage({ symbols, tf, start, end, feed = "sip", pageToken = null, limit = 10000 }) {
  const d = await get("/v2/stocks/bars", {
    symbols: symbols.join(","),
    timeframe: TF[tf],
    start: iso(start),
    end: end ? iso(end) : null,
    limit,
    adjustment: "raw",
    feed,
    sort: "asc",
    page_token: pageToken,
  });
  const bars = new Map();
  for (const [sym, list] of Object.entries(d.bars ?? {})) bars.set(sym, parseBars(list));
  return { bars, next: d.next_page_token ?? null };
}

/** 현재가 (IEX 실시간): Map(sym → {price, prevClose, ts, dayOpen}) */
export async function snapshots(symbols) {
  const d = await get("/v2/stocks/snapshots", { symbols: symbols.join(","), feed: "iex" });
  const out = new Map();
  for (const [sym, s] of Object.entries(d ?? {})) {
    if (!s) continue;
    const price = s.latestTrade?.p ?? s.minuteBar?.c ?? s.dailyBar?.c;
    if (price == null) continue;
    out.set(sym, {
      price,
      prevClose: s.prevDailyBar?.c ?? null,
      ts: Date.parse(s.latestTrade?.t ?? s.minuteBar?.t ?? 0) / 1000,
      live: true, // IEX 실시간 체결가
    });
  }
  return out;
}

/** 분할·배당 (corporate actions) — 일봉은 Yahoo가 주지만, 분봉만 있는 기간 확인용 */
export async function splits(symbols, start, end) {
  const d = await get("/v1/corporate-actions", {
    symbols: symbols.join(","),
    types: "forward_split,reverse_split",
    start: iso(start).slice(0, 10),
    end: iso(end).slice(0, 10),
    limit: 1000,
  });
  const out = [];
  for (const kind of ["forward_splits", "reverse_splits"]) {
    for (const s of d.corporate_actions?.[kind] ?? []) {
      out.push({ symbol: s.symbol, date: s.ex_date, a: s.new_rate, b: s.old_rate });
    }
  }
  return out;
}
