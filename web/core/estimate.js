// 장이 닫힌 시간의 24시간 추정가 (SPEC §2.6)
// 무기한선물 가격을 그대로 쓰지 않고 "정규장 마감 뒤 몇 % 움직였는지"만 빌린다 (베이시스·펀딩 차이 때문)
//   미국:  추정가 = 마지막 종가 × (지금 무기한선물 ÷ 마감 시각 무기한선물)
//   한국:  … × (지금 원달러 ÷ 마감 시각 원달러)  — 국내 종목 무기한선물은 달러로 바꾼 가격이라
//   배수:  QLD = 종가 × (1 + 2 × QQQ 무기한선물 변화율)
// 저장하지 않는다(화면 표시만). 정규장이 열리면 숨긴다.
import { describe } from "./symbols.js";
import * as db from "./db.js";
import * as HL from "../sources/hyperliquid.js";
import * as BN from "../sources/binance.js";
import * as A from "../sources/alpaca.js";
import * as Y from "../sources/yahoo.js";
import { marketOpen } from "./session.js";
import { DAY, localDay, localSec, tzOffset } from "./tz.js";

const H = 3600;
// 원달러: 지금 값은 Yahoo KRW=X 현재가(없으면 Hyperliquid xyz:KRW), 마감 시각 값은 Yahoo KRW=X 1분봉
// (Hyperliquid xyz:KRW는 실시간 값만 있고 지난 봉이 없다 — 2026-10-23 확인)
const KRW = { source: "hyperliquid", symbol: "xyz:KRW" };
const KRW_REF = { source: "yahoo", symbol: "KRW=X" };
const CLOSE_SEC = { "America/New_York": 16 * H, "Asia/Seoul": 15.5 * H };

export function createEstimator({ cfg, data }) {
  const bus = new EventTarget();
  const perps = new Map(); // "binance|QQQUSDT" → {price, off, refs:Set(id)}
  const closeRef = new Map(); // "binance|QQQUSDT|마감시각" → 가격 (Promise)
  const est = new Map(); // id → {price, pct, base, closeT, via}
  let targets = new Set();
  let tradfi = null;
  BN.symbols().then((m) => {
    tradfi = m;
    setTargets([...targets]);
  });

  /** 이 종목은 어느 무기한선물로 추정하나 → {source, symbol, fx} | {estimate: 다른 종목, mult} | null */
  function mappingOf(id) {
    const m = cfg.perp?.map?.[id];
    if (m) return m;
    const info = describe(id);
    if (cfg.perp?.auto_us && info.kind === "us") {
      const sym = `${id.replace(/[-.]/g, "")}USDT`;
      if (tradfi?.get(sym)?.type === "TRADIFI_PERPETUAL") return { source: "binance", symbol: sym };
    }
    return null;
  }

  /** 끝까지 따라가서 실제 무기한선물 + 배수 */
  function resolve(id) {
    const m = mappingOf(id);
    if (!m) return null;
    if (m.estimate) {
      const base = mappingOf(m.estimate);
      return base && !base.estimate ? { ...base, mult: m.mult ?? 1, via: m.estimate } : null;
    }
    return { ...m, mult: 1 };
  }

  const key = (m) => `${m.source}|${m.symbol}`;

  function watchPerp(m, id) {
    const k = key(m);
    let p = perps.get(k);
    if (!p) {
      p = { price: null, refs: new Set() };
      const cb = (q) => {
        p.price = q.price;
        for (const t of p.refs) schedule(t);
      };
      p.off = m.source === "hyperliquid" ? HL.subscribeQuote(m.symbol, cb) : BN.subscribeQuote(m.symbol, cb);
      perps.set(k, p);
    }
    p.refs.add(id);
  }

  /** 관심종목 + 보이는 칸 중 무기한선물이 있는 것만 구독 */
  function setTargets(ids) {
    targets = new Set(ids);
    if (!(cfg.perp?.enabled ?? true)) targets = new Set();
    for (const p of perps.values()) p.refs.clear();
    for (const id of targets) {
      const m = resolve(id);
      if (!m) continue;
      watchPerp(m, id);
      if (m.fx === "KRW") watchPerp(KRW, id);
    }
    for (const [k, p] of perps) {
      if (p.refs.size) continue;
      p.off();
      perps.delete(k);
    }
    for (const id of [...est.keys()]) if (!targets.has(id)) set(id, null);
    for (const id of targets) schedule(id);
  }

  /** 마감 시각의 무기한선물 가격 (그 1분봉 종가) — 한 번 받으면 기억 */
  function priceAt(m, t) {
    const k = `${key(m)}|${t}`;
    if (!closeRef.has(k)) {
      const p = (async () => {
        // Hyperliquid 1분봉은 약 3.5일치만 있어서 긴 연휴 뒤에는 15분·1시간봉으로
        if (m.source === "yahoo") {
          const rows = Y.rows(await Y.intraday(m.symbol, "1m", { from: t - 900, to: t + 60 }));
          const before = rows.filter((r) => r.t + 60 <= t + 1);
          return before.length ? before[before.length - 1].c : null;
        }
        for (const [tf, sec] of [["1m", 60], ["15m", 900], ["1h", 3600]]) {
          const rows = m.source === "hyperliquid" ? await HL.candles(m.symbol, tf, t - 3 * sec, t + 60) : await BN.klines(m.symbol, tf, { startSec: t - 3 * sec, endSec: t, limit: 5 });
          const before = rows.filter((r) => r.t + sec <= t + 1);
          if (before.length) return before[before.length - 1].c;
          if (m.source !== "hyperliquid") break;
        }
        return null;
      })().catch(() => null);
      closeRef.set(k, p);
    }
    return closeRef.get(k);
  }

  /** 마지막 정규장 종가와 그 마감 시각 */
  async function lastClose(info) {
    const rows = await db.getBars(info.id, "1D", { limit: 3 });
    let day = rows.length ? rows[rows.length - 1].t : null;
    let price = rows.length ? rows[rows.length - 1].c : null;
    const q = data.quote(info.id);
    if (q?.ts && q.price) {
      const qd = localDay(info.dayTz, q.ts);
      // 현재가가 마지막 일봉보다 뒤 날짜이고, 그날 장이 끝났으면 그게 마지막 종가
      if ((day == null || qd > day) && localSec(info.tz, q.ts) >= (CLOSE_SEC[info.tz] ?? 16 * H) - 600) {
        day = qd;
        price = q.price;
      }
    }
    if (day == null) return null;
    const local = day + (CLOSE_SEC[info.tz] ?? 16 * H);
    return { price, closeT: local - tzOffset(info.tz, local) };
  }

  /** 지금 추정가를 보여줄 때인가 */
  function closedNow(info) {
    const now = Date.now() / 1000;
    if (marketOpen(info, now)) {
      // 장 시간인데 현재가가 3시간 넘게 그대로면(휴장일) 닫힌 것으로
      const q = data.quote(info.id);
      if (!(q?.ts && now - q.ts > 3 * H)) return false;
    }
    // 미국 프리·애프터(04:00~20:00 ET)는 알파카 체결가가 있으면 그것을 쓴다
    if (info.tz === "America/New_York" && A.hasKey()) {
      const s = localSec(info.tz, now);
      const wd = (Math.floor((now + tzOffset(info.tz, now)) / DAY) + 4) % 7;
      if (wd >= 1 && wd <= 5 && s >= 4 * H && s < 20 * H) return false;
    }
    return true;
  }

  const timers = new Map();
  function schedule(id) {
    if (timers.has(id)) return;
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        compute(id);
      }, 1000)
    );
  }

  async function compute(id) {
    const m = resolve(id);
    const info = describe(id);
    if (!m || !targets.has(id) || !closedNow(info)) return set(id, null);
    const now = perps.get(key(m))?.price;
    const c = await lastClose(info);
    if (!now || !c?.price) return set(id, null);
    const ref = await priceAt(m, c.closeT);
    if (!ref) return set(id, null);
    let ratio = now / ref;
    if (m.fx === "KRW") {
      const kNow = data.quote("KRW=X")?.price ?? perps.get(key(KRW))?.price;
      const kRef = await priceAt(KRW_REF, c.closeT);
      if (!kNow || !kRef) return set(id, null);
      ratio *= kNow / kRef;
    }
    const chg = m.mult === 1 ? ratio - 1 : m.mult * (ratio - 1);
    set(id, { price: c.price * (1 + chg), pct: chg * 100, base: c.price, closeT: c.closeT, via: m.via ? `${m.via} × ${m.mult}` : m.symbol });
  }

  function set(id, v) {
    const old = est.get(id);
    if (!v && !old) return;
    if (v && old && Math.abs(v.price - old.price) < 1e-9) return;
    if (v) est.set(id, v);
    else est.delete(id);
    bus.dispatchEvent(new CustomEvent("estimate", { detail: { id, est: v } }));
  }

  // 장이 열리고 닫히는 것을 따라가게 1분마다 다시
  setInterval(() => targets.forEach(schedule), 60e3);

  return {
    setTargets,
    get: (id) => est.get(id) ?? null,
    on: (fn) => {
      const h = (e) => fn(e.detail);
      bus.addEventListener("estimate", h);
      return () => bus.removeEventListener("estimate", h);
    },
    mappingOf: resolve,
  };
}
