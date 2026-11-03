// 봉 계산 (순수 함수): 분할·배당 반영, 분봉 묶기, 주봉, 하이킨아시, 비율 차트.
// 저장소에는 실제 가격이 있고(SPEC §2.4), 화면에 그리기 직전에 여기서 고친다.
import { DAY, tzOffset } from "./tz.js";

// 30m: 사용자 요청 2026-11-01 (FAKE TRADING 0.12.0). 순서 = 툴바 버튼·Alt+숫자 순서
export const TF_SEC = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1D": DAY, "1W": 7 * DAY };
export const TIMEFRAMES = Object.keys(TF_SEC);
export const isDailyTf = (tf) => tf === "1D" || tf === "1W";

/** 분할 목록 [{t: 분할일(날짜 값), r: 새 주식 수 / 옛 주식 수}] — 2:1이면 r=2, 1:4 병합이면 r=0.25 */
export function splitList(events) {
  const byDay = new Map(); // 같은 날짜가 두 번 오면(저장된 것 + 새로 받은 것) 하나만
  for (const e of events ?? []) {
    if (e.kind === "split" && e.a > 0 && e.b > 0 && e.a !== e.b) byDay.set(e.t, { t: e.t, r: e.a / e.b });
  }
  return [...byDay.values()].sort((x, y) => x.t - y.t);
}

/** 그 날짜 이후에 일어난 분할을 모두 곱한 값 (그날 실제 가격 ÷ 이 값 = 지금 기준 가격) */
export function splitFactorAt(splits, day) {
  let f = 1;
  for (const s of splits) if (s.t > day) f *= s.r;
  return f;
}

/**
 * 배당 포함(총수익) 기준 곱셈값 [{t: 배당락일, m}]: 배당락 전 가격에 m(<1)을 곱한다.
 * m = 1 − 배당금 / 배당락 전날 종가 (둘 다 실제 가격) — Yahoo adjclose와 같은 방식
 */
export function dividendMultipliers(dailyRaw, events) {
  const divs = (events ?? []).filter((e) => e.kind === "div" && e.a > 0).sort((x, y) => x.t - y.t);
  const out = [];
  let i = 0;
  for (const d of divs) {
    while (i < dailyRaw.length && dailyRaw[i].t < d.t) i++;
    const prev = dailyRaw[i - 1];
    if (!prev || prev.c <= d.a) continue;
    out.push({ t: d.t, m: 1 - d.a / prev.c });
  }
  return out;
}

/**
 * 실제 가격 → 화면 가격. dayOf(t) = 그 봉의 현지 날짜 값.
 * basis: "split"(수정주가) | "total"(배당 포함) | "raw"(실제 거래가)
 */
export function adjust(rows, { splits = [], divMult = null, basis = "split", dayOf = (t) => t }) {
  if (basis === "raw" || (!splits.length && !(basis === "total" && divMult?.length))) return rows;
  const useDiv = basis === "total" && divMult?.length;
  const out = new Array(rows.length);
  let j = splits.length - 1;
  let F = 1;
  let k = useDiv ? divMult.length - 1 : -1;
  let M = 1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const d = dayOf(r.t);
    while (j >= 0 && d < splits[j].t) F *= splits[j--].r;
    while (k >= 0 && d < divMult[k].t) M *= divMult[k--].m;
    const p = M / F;
    // k: 맞춘 가격 = 실제 거래가 × k → 범례에 "실제 $50.04"를 보여 줄 때 c / k
    out[i] = p === 1 ? r : { t: r.t, o: r.o * p, h: r.h * p, l: r.l * p, c: r.c * p, v: r.v * F, k: p };
  }
  return out;
}

/** 정규장만 남기기 (from ≤ 현지 시각 < to, 하루 중 초) */
export function filterSession(rows, tz, [from, to]) {
  return rows.filter((k) => {
    const l = k.t + tzOffset(tz, k.t);
    const s = l - Math.floor(l / DAY) * DAY;
    return s >= from && s < to;
  });
}

/** 봉 시작 시각: 현지 기준 시각(anchor)에 맞춰 outSec 단위로 */
export function bucketOf(t, outSec, tz, anchor) {
  const off = tzOffset(tz, t);
  const local = t + off;
  const day = Math.floor(local / DAY) * DAY;
  const s = local - day;
  return day + anchor + Math.floor((s - anchor) / outSec) * outSec - off;
}

/** 작은 봉 → 큰 봉 (예: 5분 → 1시간, 정규장 09:30 기준) */
export function aggregate(rows, outSec, tz, anchor) {
  const out = [];
  let cur = null;
  for (const k of rows) {
    const b = bucketOf(k.t, outSec, tz, anchor);
    if (!cur || cur.t !== b) {
      cur = { t: b, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v };
      if (k.k) cur.k = k.k;
      out.push(cur);
    } else {
      if (k.h > cur.h) cur.h = k.h;
      if (k.l < cur.l) cur.l = k.l;
      cur.c = k.c;
      cur.v += k.v;
      if (k.k) cur.k = k.k; // 종가와 같은 봉의 값
      else delete cur.k;
    }
  }
  return out;
}

/** 월요일 날짜 값 (1970-01-01은 목요일) */
export const mondayOf = (day) => day - ((Math.floor(day / DAY) + 3) % 7) * DAY;

/** 일봉 → 주봉 (주의 첫 거래일이 아니라 그 주 월요일 날짜로 표기) */
export function weekly(daily) {
  const out = [];
  let cur = null;
  for (const k of daily) {
    const b = mondayOf(k.t);
    if (!cur || cur.t !== b) {
      cur = { t: b, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v };
      if (k.k) cur.k = k.k;
      out.push(cur);
    } else {
      if (k.h > cur.h) cur.h = k.h;
      if (k.l < cur.l) cur.l = k.l;
      cur.c = k.c;
      cur.v += k.v;
      if (k.k) cur.k = k.k; // 종가와 같은 날의 값
      else delete cur.k;
    }
  }
  return out;
}

/** 하이킨아시 (보기만 바뀐다. 지표·측정·백테스트는 원래 봉으로 계산, SPEC §3.9) */
export function heikinAshi(rows) {
  const out = new Array(rows.length);
  let po = 0;
  let pc = 0;
  for (let i = 0; i < rows.length; i++) {
    const k = rows[i];
    const c = (k.o + k.h + k.l + k.c) / 4;
    const o = i === 0 ? (k.o + k.c) / 2 : (po + pc) / 2;
    out[i] = { t: k.t, o, h: Math.max(k.h, o, c), l: Math.min(k.l, o, c), c, v: k.v };
    po = o;
    pc = c;
  }
  return out;
}

/** 비율 차트: 같은 시각 봉끼리 나누기 (한쪽에만 있는 시각은 버림, SPEC §3.7) */
export function ratioBars(a, b) {
  const mb = new Map(b.map((k) => [k.t, k]));
  const out = [];
  for (const x of a) {
    const y = mb.get(x.t);
    if (!y || !y.o || !y.h || !y.l || !y.c) continue;
    const o = x.o / y.o;
    const c = x.c / y.c;
    const h1 = x.h / y.h;
    const l1 = x.l / y.l;
    out.push({ t: x.t, o, h: Math.max(o, c, h1, l1), l: Math.min(o, c, h1, l1), c, v: 0 });
  }
  return out;
}

/** 시간이 겹치거나 거꾸로 된 봉 정리 (차트 라이브러리는 엄격한 오름차순만 받는다) */
export function clean(rows) {
  const out = [];
  for (const k of rows) {
    if (!(k.c > -Infinity)) continue;
    if (!out.length || k.t > out[out.length - 1].t) out.push(k);
    else if (k.t === out[out.length - 1].t) out[out.length - 1] = k;
  }
  return out;
}

/**
 * 실시간 현재가 q {price, ts, hi?, lo?}로 분봉 목록의 끝을 고친다 (sec = 봉 길이):
 * - 현재가 시각이 마지막 봉 안이면 그 봉의 종가·고가·저가를 고치고
 * - 다음 칸이면 그 칸에 새 봉을 연다 (시가 = 현재가, 거래량은 나중에 꼬리 봉이 오면 채워진다)
 *   알파카 IEX 1분봉은 1분이 끝나야 와서, 이게 없으면 1분봉 차트가 늘 한 칸 늦고 오른쪽 가격도 멈춰 보였다
 * - 30분(또는 6봉) 넘게 떨어져 있으면 데이터가 끊긴 것 → 그대로 두고 꼬리 봉을 기다린다
 */
export function applyLiveQuote(list, q, sec, tz, anchor) {
  if (!list.length || !(q?.price > 0) || !q.ts) return list;
  const last = list[list.length - 1];
  if (q.ts < last.t) return list;
  const p = q.price;
  const hi = Math.max(p, q.hi ?? p);
  const lo = Math.min(p, q.lo ?? p);
  if (q.ts < last.t + sec) {
    if (last.c === p && last.h >= hi && last.l <= lo) return list;
    return [...list.slice(0, -1), { ...last, c: p, h: Math.max(last.h, hi), l: Math.min(last.l, lo) }];
  }
  const t = bucketOf(q.ts, sec, tz, anchor);
  if (t <= last.t || t - last.t > Math.max(6 * sec, 1800)) return list;
  return [...list, { t, o: p, h: hi, l: lo, c: p, v: 0 }];
}

/** 두 목록 합치기: 같은 시각이면 뒤의 것(newer)이 이긴다 */
export function mergeRows(older, newer) {
  if (!older.length) return clean(newer);
  if (!newer.length) return older;
  const m = new Map(older.map((c) => [c.t, c]));
  for (const c of newer) m.set(c.t, c);
  return clean([...m.values()].sort((x, y) => x.t - y.t));
}
