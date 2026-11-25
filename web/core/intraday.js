// 분봉·무기한선물 받기·이어 받기 (SPEC §2.3~2.5, §2.9)
// 저장하는 봉 (나머지 봉은 화면에서 이것들로 만든다):
//   미국 주식·ETF (Alpaca): 1m(최근 12개월), 5m(2016년부터) → 15m·1h·4h는 5m에서
//   Yahoo 분봉 (국내·지수·환율·선물): 1m(30일), 5m(60일), 1h(2년)를 받을 수 있는 만큼, 켤 때마다 이어서 쌓는다
//   무기한선물: 거래소 봉 7가지를 그대로
import * as db from "./db.js";
import * as A from "../sources/alpaca.js";
import * as Y from "../sources/yahoo.js";
import * as HL from "../sources/hyperliquid.js";
import * as BN from "../sources/binance.js";
import * as OK from "../sources/okx.js";
import { TF_SEC, splitList, splitFactorAt } from "./bars.js";
import { DAY, parseYmd, localDay } from "./tz.js";
import { createLiveGate, fillHole } from "./holes.js";
import { logInfo } from "../platform.js";

/** 화면 봉 → 저장 봉 */
export const BASE_TF = {
  alpaca: { "1m": "1m", "3m": "1m", "5m": "5m", "15m": "5m", "30m": "5m", "1h": "5m", "4h": "5m" },
  yahoo: { "1m": "1m", "3m": "1m", "5m": "5m", "15m": "5m", "30m": "5m", "1h": "1h", "4h": "1h" }, // 30분봉 = 5분봉 6개, 3분봉 = 1분봉 3개 (따로 받지 않는다)
};

export function baseTf(info, tf) {
  if (info.kind === "perp") return tf;
  return BASE_TF[info.intraday]?.[tf] ?? null;
}

const now = () => Math.floor(Date.now() / 1000);
const alpacaSym = (id) => id.replace(/-/g, ".");

// ── Alpaca ──
const PARALLEL = 3; // 과거 채우기를 한 종목에 동시에 몇 덩어리씩 (알파카 한도는 Rust가 분당 150번으로 지킨다)

/** 한 종목 저장 봉을 최신으로 (처음이면 정해진 날부터). progress(0~1)로 진행 상황 */
export async function ensureAlpaca(info, tf, cfg, progress = () => {}) {
  if (!A.hasKey()) return 0;
  const sym = info.id;
  const sec = TF_SEC[tf];
  let rng = await db.range(sym, tf);
  // 무료 플랜은 최근 15분 SIP를 못 받는다 → 16분 전 봉 경계까지만 (끝이 잘린 봉을 저장하지 않게)
  const end = Math.floor((now() - 16 * 60) / sec) * sec - 1;
  const first = tf === "1m" ? now() - (cfg.data.intraday_1m_months ?? 12) * 30.5 * DAY : parseYmd(cfg.data.intraday_5m_from ?? "2016-01-01");
  let n = 0;
  const fetchRange = async (start, stop, onPage = (t) => progress((t - start) / (stop - start))) => {
    let token = null;
    do {
      const page = await A.barsPage({ symbols: [alpacaSym(sym)], tf, start, end: stop, pageToken: token });
      const rows = page.bars.get(alpacaSym(sym)) ?? [];
      await db.putBars(sym, tf, rows);
      n += rows.length;
      token = page.next;
      if (rows.length) onPage(rows[rows.length - 1].t);
    } while (token);
  };
  if (!rng) {
    // 처음: 최근 5일을 먼저 → 차트가 바로 지금까지 보인다. 그 앞(과거)은 이어서 뒤에서 채운다
    await fetchRange(Math.max(first, end - 5 * DAY), end);
    rng = await db.range(sym, tf);
    if (!rng) return 0;
  } else if (rng.last + sec < end) {
    await fetchRange(rng.last + sec, end);
  }
  // 과거 채우기: 정한 시작일(1분봉 12개월 전, 5분봉 2016년)까지.
  // 최근 쪽부터 거꾸로 덩어리(1분봉 2달, 5분봉 1년)로 나눠 3개씩 함께 받는다 (한 줄로 받을 때보다 약 3배 빠름).
  // 메타 `${sym}|${tf}|from` = "여기부터 지금까지는 빈틈없이 받았음" → 중간에 꺼도 다음에 거기서 이어서
  const doneKey = `${sym}|${tf}|from`;
  const from = (await db.metaGet(doneKey)) ?? rng.first;
  if (from > first + DAY) {
    const before = n;
    const t0 = Date.now();
    const span = (tf === "1m" ? 61 : 365) * DAY;
    const chunks = [];
    for (let e = from; e > first; e -= span) chunks.push({ s: Math.max(first, e - span), e: e - 1, at: Math.max(first, e - span), ok: false });
    const total = from - first;
    let next = 0;
    let saved = from;
    let failed = false; // 한 덩어리가 실패하면 나머지도 멈춘다 (다음에 saved부터 이어서)
    const pct = () => progress(chunks.reduce((s, c) => s + (c.ok ? c.e - c.s : c.at - c.s), 0) / total);
    const worker = async () => {
      while (!failed && next < chunks.length) {
        const c = chunks[next++];
        try {
          await fetchRange(c.s, c.e, (t) => ((c.at = t), pct()));
        } catch (e) {
          failed = true;
          throw e;
        }
        c.ok = true;
        pct();
        // 최근 쪽부터 끊김 없이 다 받은 곳까지 표시
        let b = saved;
        for (const k of chunks) {
          if (!k.ok) break;
          b = k.s;
        }
        if (b < saved) await db.metaSet(doneKey, (saved = b));
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker));
    await db.metaSet(doneKey, first);
    logInfo(`[alpaca] ${sym} ${tf} 과거 ${n - before}봉 채움 · ${Math.round((Date.now() - t0) / 1000)}초`);
    await fillHoles(sym, tf, fetchRange);
  } else if (!(await db.metaGet(`${sym}|${tf}|holes`))) await fillHoles(sym, tf, fetchRange);
  return n;
}

/** 예전에 받다가 끊겨 생긴 구멍(평일 장이 있었을 텐데 5일 넘게 비어 있는 곳) 한 번 메우기 */
async function fillHoles(sym, tf, fetchRange) {
  const gaps = await db.gaps(sym, tf, 5 * DAY).catch(() => []);
  let added = 0;
  for (const [a, b] of gaps) {
    const before = (await db.range(sym, tf))?.count ?? 0;
    await fetchRange(a + 1, b - 1, () => {});
    added += ((await db.range(sym, tf))?.count ?? 0) - before;
  }
  if (gaps.length) logInfo(`[alpaca] ${sym} ${tf} 빈 곳 ${gaps.length}군데 확인 · ${added}봉 메움`);
  await db.metaSet(`${sym}|${tf}|holes`, 1);
}

/** 이미 받아 둔 여러 종목을 한 번에 이어 받기 (요청 수 절약). 반환: 새로 받은 종목 id 목록 */
export async function catchUpAlpacaMany(infos, tf) {
  if (!A.hasKey() || !infos.length) return [];
  const sec = TF_SEC[tf];
  const end = Math.floor((now() - 16 * 60) / sec) * sec - 1;
  const lasts = new Map();
  for (const info of infos) {
    const r = await db.range(info.id, tf);
    if (r && r.last + sec < end && r.last > end - 5 * DAY) lasts.set(alpacaSym(info.id), { id: info.id, last: r.last });
  }
  if (!lasts.size) return [];
  const start = Math.min(...[...lasts.values()].map((x) => x.last)) + sec;
  const changed = new Set();
  let token = null;
  do {
    const page = await A.barsPage({ symbols: [...lasts.keys()], tf, start, end, pageToken: token });
    for (const [s, rows] of page.bars) {
      const it = lasts.get(s);
      if (!it) continue;
      const fresh = rows.filter((k) => k.t > it.last);
      if (fresh.length) {
        await db.putBars(it.id, tf, fresh);
        changed.add(it.id);
      }
    }
    token = page.next;
  } while (token);
  return [...changed];
}

/** 최근 20분 IEX 1분봉 (화면 표시용, 저장하지 않음) → Map(id → rows) */
export async function alpacaTail(ids) {
  if (!A.hasKey() || !ids.length) return new Map();
  const page = await A.barsPage({ symbols: ids.map(alpacaSym), tf: "1m", start: now() - 20 * 60, feed: "iex" });
  const out = new Map();
  for (const id of ids) out.set(id, page.bars.get(alpacaSym(id)) ?? []);
  return out;
}

// ── Yahoo 분봉 ──
// Yahoo가 주는 범위 (2026-10-23 확인): 1분 약 30일(한 번에 7일까지), 5분 60일, 1시간 730일.
// 요청 범위 밖의 "지금 봉" 하나를 덧붙여 주므로 범위 안만 쓴다.
const Y_TF = { "1m": ["1m", 7, 29], "5m": ["5m", 59, 59], "1h": ["60m", 729, 729] }; // [interval, 한 번에 받는 날, 거슬러 갈 수 있는 날]

/** Yahoo 분봉은 분할 반영 값 → 저장소에는 실제 거래가로 (일봉과 같은 규칙, SPEC §2.4) */
async function rawConverter(info) {
  if (!info.splits) return (rows) => rows;
  const splits = splitList(await db.getEvents(info.id));
  if (!splits.length) return (rows) => rows;
  return (rows) =>
    rows.map((k) => {
      const f = splitFactorAt(splits, localDay(info.dayTz, k.t));
      return f === 1 ? k : { t: k.t, o: k.o * f, h: k.h * f, l: k.l * f, c: k.c * f, v: k.v / f };
    });
}

export async function ensureYahooIntraday(info, tf) {
  const [interval, chunkDays, maxBack] = Y_TF[tf];
  const sym = info.id;
  const rng = await db.range(sym, tf);
  const t = now();
  // 처음이면 받을 수 있는 가장 앞부터, 아니면 마지막 저장 봉 조금 앞부터. 너무 오래 꺼 뒀으면 받을 수 있는 만큼만(빈 구간은 비워 둔다)
  const from = Math.max(rng ? rng.last - 2 * TF_SEC[tf] : 0, t - maxBack * DAY);
  const toRaw = await rawConverter(info);
  let total = 0;
  for (let s = from; s < t; s += chunkDays * DAY) {
    const e = Math.min(t + 60, s + chunkDays * DAY);
    let r;
    try {
      r = await Y.intraday(info.yahoo, interval, { from: s, to: e });
    } catch (err) {
      console.warn("[yahoo] 분봉", sym, tf, err.message);
      continue;
    }
    const rows = toRaw(Y.rows(r).filter((k) => k.t >= s && k.t < e));
    await db.putBars(sym, tf, rows);
    total += rows.length;
  }
  if (!rng && total) logInfo(`[yahoo] ${sym} ${tf} 처음 ${total}봉 저장`);
  return total;
}

// ── 무기한선물 ──
export async function ensurePerp(info, tf) {
  const sym = info.id;
  const rng = await db.range(sym, tf);
  let n = 0;
  if (info.daily === "hyperliquid") {
    const rows = await HL.candles(info.symbol, tf, rng ? rng.last : 0);
    await db.putBars(sym, tf, rows);
    n = rows.length;
  } else {
    // 바이낸스와 OKX는 같은 모양(klines)으로 받는다 (OKX는 sources/okx.js가 100개씩 나눠 받아 1500개로 묶는다)
    const X = info.daily === "okx" ? OK : BN;
    if (!rng) {
      // 처음: 최근 1500개 + 앞으로 두 번 더(일·주·4시간봉은 상장 이후 전부일 때가 많다).
      // OKX는 1500개가 요청 15번이라 처음에는 1500개만 (더 옛날은 차트를 뒤로 밀면 받는다)
      let rows = await X.klines(info.symbol, tf);
      await db.putBars(sym, tf, rows);
      n += rows.length;
      for (let i = 0; i < (X === OK ? 0 : 2) && rows.length === 1500; i++) {
        rows = await X.klines(info.symbol, tf, { endSec: rows[0].t - 1 });
        await db.putBars(sym, tf, rows);
        n += rows.length;
      }
    } else {
      let start = rng.last;
      for (let i = 0; i < 20; i++) {
        const rows = await X.klines(info.symbol, tf, { startSec: start });
        await db.putBars(sym, tf, rows);
        n += rows.length;
        if (rows.length < 1500) break;
        start = rows[rows.length - 1].t;
      }
    }
  }
  return n;
}

/**
 * 실시간 봉 구독 (무기한선물) → 해제 함수. 받은 봉은 저장소에도 쌓는다(5초에 한 번).
 * catchUp이 있으면 (0.31.0) 저장소를 실시간 봉까지 이어 받은 뒤에만 쓴다 (holes.js createLiveGate).
 * 전에는 알림이 켜 둔 실시간 구독이 지금 봉을 먼저 써서, 앱을 꺼 둔 동안이 빈 곳으로 남았다 (2026-11-25 SOXL 5분봉 21시간).
 */
export function subscribePerp(info, tf, cb, { catchUp = null } = {}) {
  let timer = 0;
  const g = createLiveGate({ sec: TF_SEC[tf] ?? 60, catchUp, write: (rows) => db.putBars(info.id, tf, rows).catch(() => {}) });
  const flush = () => {
    timer = 0;
    if (!g.flush()) timer = setTimeout(flush, 5000); // 아직 이어 받는 중 → 조금 뒤에
  };
  const onRow = (row) => {
    g.row(row);
    if (!timer) timer = setTimeout(flush, 5000);
    cb(row);
  };
  const off = info.daily === "hyperliquid" ? HL.subscribeCandles(info.symbol, tf, onRow) : info.daily === "okx" ? OK.subscribeCandles(info.symbol, tf, onRow) : BN.subscribeCandles(info.symbol, tf, onRow);
  return () => {
    off();
    clearTimeout(timer);
    g.flush(); // 이어 받기가 아직이면 쓰지 않는다 (다음에 이어 받기가 가져온다)
  };
}

/**
 * 무기한선물 빈 곳 메우기 (0.31.0): holes = [[앞 봉 t, 뒤 봉 t], ...]. 거래소에서 그 사이만 다시 받아 저장한다.
 * → {added, empty: 거래소에도 봉이 없는 곳 [[a, b], ...]}
 */
export async function fillPerpHoles(info, tf, holes) {
  const sec = TF_SEC[tf];
  const X = info.daily === "okx" ? OK : BN;
  const page =
    info.daily === "hyperliquid"
      ? (s, e) => HL.candles(info.symbol, tf, s, e + 1)
      : (s, e) => X.klines(info.symbol, tf, { startSec: s, endSec: e, limit: 1500 });
  // 가까운 빈 곳은 한 번에 (1,000봉 안이면 요청 한 번). 거래가 드문 종목은 빈 분이 수백 군데일 수 있다 → 최근 것부터 30묶음까지만, 나머지는 다음에
  const groups = [];
  for (const [a, b] of holes) {
    const g = groups[groups.length - 1];
    if (g && b - g[0] <= 1000 * sec) g[1] = b;
    else groups.push([a, b]);
  }
  const before = (await db.range(info.id, tf))?.count ?? 0;
  const empty = [];
  for (const g of groups.slice(-30)) empty.push(...(await fillHole(g, sec, page, (rows) => db.putBars(info.id, tf, rows))).empty);
  return { added: ((await db.range(info.id, tf))?.count ?? 0) - before, empty };
}
