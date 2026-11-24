// 구름 상황판 = "나뇨띠 지표" (0.28.0). 순수 계산 (tests.js에서 시험), 그리기는 guides.js의 nanyotti.
// 방송인 나뇨띠의 TradingView 지표 "NANYOTTI v6.3" 표를, 방송 화면 캡처와 바이낸스 실제 봉을 맞춰 거꾸로 알아낸 우리 버전이다
// (지표 자체는 그 사람 레퍼럴로 큰 거래를 해야 받을 수 있다). 2026-11-24 캡처 17장으로 확인한 것:
//   똑같이 맞은 것 — 구름 = 트레이딩뷰 기본 일목(9·26·52, 26칸 앞으로), 계산은 마지막으로 끝난 봉 기준("마감 기준"),
//     구름 이격 = (종가 − 가까운 구름 끝) ÷ ATR(14) 7장 모두 0.1까지, 큰 시간봉(1시간·4시간 구름 위·안·아래) 14칸,
//     시장 활동 = 거래량 ÷ 앞 20봉 평균, ATR(14) ÷ ATR 50봉 평균 7장씩
//   추정 — 이격 큼 기준(1.4엔 없고 2.2엔 있음 → 2), 2·4·6·8(비트코인 백 단위 칸, 10장과 맞음), 프랙탈, 관찰 기준, 매물영역
import * as C from "./calc.js";
import { findZones } from "./setups.js";

export const ICHI = { conv: 9, base: 26, spanB: 52, disp: 26 };
export const GAP_BIG = 2; // 이격 큼: 구름에서 ATR 이만큼 이상 (추정)

/** n봉 고가·저가의 가운데 (일목의 전환선·기준선·선행스팬B 재료) */
function mids(bars, n) {
  const out = new Array(bars.length).fill(null);
  for (let i = n - 1; i < bars.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - n + 1; k <= i; k++) {
      if (bars[k].h > hi) hi = bars[k].h;
      if (bars[k].l < lo) lo = bars[k].l;
    }
    out[i] = (hi + lo) / 2;
  }
  return out;
}

/**
 * 일목 구름: i번 봉 자리에 보이는 선행스팬 A·B. 트레이딩뷰 기본과 같이 26칸 앞으로 민다 = (disp − 1)봉 전에 계산한 값.
 * → {a, b} (봉 수와 같은 길이, 앞부분 null). 미래 봉은 안 본다 (앞으로 민 값이라 늘 지난 봉으로 계산됨)
 */
export function ichimokuCloud(bars, o = ICHI) {
  const conv = mids(bars, o.conv);
  const base = mids(bars, o.base);
  const sb = mids(bars, o.spanB);
  const sh = o.disp - 1;
  const a = new Array(bars.length).fill(null);
  const b = new Array(bars.length).fill(null);
  for (let i = sh; i < bars.length; i++) {
    const j = i - sh;
    if (conv[j] != null && base[j] != null) a[i] = (conv[j] + base[j]) / 2;
    b[i] = sb[j];
  }
  return { a, b };
}

/** 가격이 구름의 어디에: "above" · "below" · "inside" (구름이 아직 없으면 null) */
export function cloudPos(c, a, b) {
  if (c == null || a == null || b == null) return null;
  return c > Math.max(a, b) ? "above" : c < Math.min(a, b) ? "below" : "inside";
}
/** 구름 이격: (종가 − 가까운 구름 끝) ÷ ATR. 위면 +, 아래면 −, 안이면 0 */
export function cloudGap(c, a, b, atr) {
  const p = cloudPos(c, a, b);
  if (!p || !(atr > 0)) return null;
  if (p === "above") return (c - Math.max(a, b)) / atr;
  if (p === "below") return -(Math.min(a, b) - c) / atr;
  return 0;
}
export const POS_KO = { above: "롱", below: "숏", inside: "중립" };
/** 1번 줄: 현재 추세 */
export const trendText = (p) => (p === "above" ? "롱 우세" : p === "below" ? "숏 우세" : p === "inside" ? "중립" : "—");
/** 4번 줄: 구름 이격 ("위 0.8 ATR" · "아래 7.3 ATR · 이격 큼" · "구름 안") */
export function gapText(g) {
  if (g == null) return "—";
  if (g === 0) return "구름 안";
  const t = `${g > 0 ? "위" : "아래"} ${Math.abs(g).toFixed(1)} ATR`;
  return Math.abs(g) >= GAP_BIG ? `${t} · 이격 큼` : t;
}

/**
 * 6번 줄: 시장 활동 → {vol, atr}. 거래량 = k번 봉 거래량 ÷ 바로 앞 20봉 평균, ATR = ATR(14) ÷ 최근 50봉 ATR 평균 (k번 봉 포함)
 * atr = C.atr(bars, 14) 배열, rv = C.rvol(bars, 20) 배열
 */
export function activityAt(atr, rv, k) {
  let sum = 0;
  let n = 0;
  for (let j = k - 49; j <= k; j++) {
    if (j < 0 || atr[j] == null) continue;
    sum += atr[j];
    n++;
  }
  return { vol: rv?.[k] ?? null, atr: n === 50 && atr[k] != null ? atr[k] / (sum / 50) : null };
}
export const xText = (v) => (v == null ? "—" : `${v.toFixed(1)}x`);

/** 비트코인 달러 가격인가 (2·4·6·8은 비트코인 백 단위 숫자라서 비트코인에서만) */
export const isBtcUsd = (id) => /BTC/i.test(id ?? "") && !/KRW|EUR|JPY|GBP/i.test(id ?? "");

/**
 * 5번 줄 2·4·6·8 (추정, 비트코인 3분봉 전용): 종가가 천 단위(60,000 등)를 뚫으면 그 천 단위 옆 200달러 칸을 본다 (백 단위 숫자 그대로)
 *   아래로 뚫으면 59,800~60,000(8-1K, 바로 붙은 칸) · 59,600~59,800(6-8) · …, 위로 뚫으면 60,000~60,200(0-2, 붙은 칸) · 60,200~60,400(2-4) · …
 * 종가가 뚫은 천 단위 반대편으로 돌아오거나, 뚫은 지 LADDER_LIFE봉이 지나면 다시 "1K 조건 대기". 봉의 저가가 있는 칸으로 말한다.
 * 2026-11-24 방송 13장(12:13 · 18:54 · 22:06~22:19 · 23:06 · 23:21 등)과 모두 맞춘 규칙. 뚫은 뒤 보는 시간(20봉 = 1시간)과
 * 관찰 봉 수(3)는 화면으로 범위만 좁혀서 정한 값 (오전 11시에 61,000을 뚫은 뒤 15:23 화면은 "1K 조건 대기"였다).
 * → {text, T(지금 보는 천 단위 또는 null), band(칸 아래 끝 숫자 0·2·4·6·8)}
 */
export const LADDER_LIFE = 20;
export const LADDER_OBS = 3; // 반응 뒤 이만큼의 봉까지 "구간 관찰", 그 뒤는 "구간 반응 대기" (23:03 반응 → 23:18 봉 "구간 반응 대기"에 맞춤)
/*
 * 0.29.0: 위로 뚫을 때도 (23:00 봉이 60,000을 위로 뚫음 → 23:03 봉 저가 60,232.7이 60,200~60,400 칸에 닿고 칸 위에서 마감 = "2-4 반응 발생",
 * 23:18 봉 = "구간 반응 대기"). 아래로 뚫으면 천 단위 아래 칸(8-1K가 바로 붙은 칸), 위로 뚫으면 위 칸(0-2가 붙은 칸), 둘 다 봉의 저가로 칸을 잰다.
 * 반응 = 뚫은 뒤 바로 붙은 칸이 아닌 칸에 처음 닿고 종가가 그 칸 아래 끝 위. 반응 뒤 LADDER_OBS봉은 "구간 관찰", 그 밖에는 "구간 반응 대기".
 */
export function ladderAt(bars, k, look = 400, life = LADDER_LIFE, obs = LADDER_OBS) {
  let T = null;
  let dir = 0; // −1 아래로 뚫음 · 1 위로 뚫음
  let since = -1;
  let reacted = new Set();
  let lastR = -1;
  let rBand = null;
  let cur = null; // k번 봉 저가가 있는 칸 (붙은 칸이면 null) — "구간 관찰"은 지금 칸 이름으로 (12:09 봉: 4-6에서 반응 뒤 6-8 칸 → "6-8 구간 관찰")
  for (let i = Math.max(1, k - look); i <= k; i++) {
    cur = null;
    const c = bars[i].c;
    const t0 = Math.floor(bars[i - 1].c / 1000) * 1000; // 앞 봉 종가가 있던 천 단위
    const fresh = () => {
      since = i;
      reacted = new Set();
      lastR = -1;
    };
    if (c < t0) {
      T = Math.floor(c / 1000) * 1000 + 1000; // 천 단위를 아래로 뚫은 봉 → 그 천 단위부터 다시
      dir = -1;
      fresh();
    } else if (c >= t0 + 1000) {
      T = Math.floor(c / 1000) * 1000; // 천 단위를 위로 뚫은 봉
      dir = 1;
      fresh();
    } else if (T != null && ((dir < 0 ? c >= T : c < T) || i - since > life)) {
      T = null; // 뚫은 천 단위 반대편으로 돌아왔거나 오래됨 → 처음부터
      dir = 0;
    }
    if (T == null) continue;
    const low = bars[i].l;
    const base = dir < 0 ? T - 1000 : T; // 칸을 세는 천 단위 바닥
    if (low < base || low >= base + 1000) continue; // 천 단위 밖으로 꼬리만 나감
    const band = Math.max(0, Math.min(8, Math.floor((low - base) / 200) * 2));
    const adj = dir < 0 ? band === 8 : band === 0; // 뚫은 천 단위에 바로 붙은 칸
    if (!adj) cur = band;
    if (!adj && !reacted.has(band) && c >= base + band * 100) {
      reacted.add(band);
      lastR = i;
      rBand = band;
    }
  }
  if (T == null) return { text: "1K 조건 대기", T: null, band: null };
  if (lastR === k) return { text: `${rBand}-${rBand + 2} 반응 발생`, T, band: rBand };
  if (lastR >= 0 && k - lastR <= obs) {
    const b = cur ?? rBand;
    return { text: `${b}-${b + 2} 구간 관찰`, T, band: b };
  }
  return { text: "구간 반응 대기", T, band: null };
}

/**
 * 3번 줄 프랙탈 (추정): k번 봉까지 확정된 마지막 프랙탈 고점·저점(양옆 n봉, 윌리엄스).
 * dir = 큰 방향(1 롱 · −1 숏 · 0 모름 — 1시간봉 구름 위치). 종가가 큰 방향과 반대쪽 프랙탈을 넘어서 있으면 "반대 이탈 · 재검토",
 * 같은 쪽을 넘어서 있으면 "같은 방향 돌파", 그 밖에는 "조건 대기". 방송 화면 한 장(1시간봉 롱일 때 저점 이탈 → 재검토)에 맞췄다
 */
export function fractalState(bars, k, dir, n = 2) {
  let hi = null;
  let lo = null;
  for (let i = k - n; i >= n && (hi == null || lo == null); i--) {
    let isH = hi == null;
    let isL = lo == null;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isH = false;
      if (bars[j].l <= bars[i].l) isL = false;
    }
    if (isH) hi = bars[i].h;
    if (isL) lo = bars[i].l;
  }
  const c = bars[k]?.c;
  if (!dir || c == null) return { text: "조건 대기", hi, lo };
  const up = hi != null && c > hi;
  const dn = lo != null && c < lo;
  if ((dir > 0 && dn) || (dir < 0 && up)) return { text: "반대 이탈 · 재검토", hi, lo };
  if ((dir > 0 && up) || (dir < 0 && dn)) return { text: "같은 방향 돌파", hi, lo };
  return { text: "조건 대기", hi, lo };
}

/** 7번 줄 관찰 기준 (추정): 지금·1시간·4시간 방향이 다 같으면 일치. 큰 시간봉을 못 보면 데이터 대기 */
export function alignText(now, h1, h4) {
  if (h1 == null || h4 == null) return "큰 방향 데이터 대기";
  if (now && now !== "inside" && now === h1 && now === h4) return `큰 방향 일치 · ${POS_KO[now]}`;
  return "큰 방향 미일치";
}

/**
 * 8·9번 줄 매물영역 (우리 방식 — 그 사람 규칙은 못 찾음): 여러 봉이 좁게 옆으로 기다가 몸통 큰 봉이 뚫고 나간 구간(손바뀜 자리, findZones)의
 * 고가~저가 상자. 아래로 뚫고 나간 상자 = 위에서 막을 자리, 위로 뚫고 나간 상자 = 아래에서 받칠 자리.
 * 종가가 상자 반대편 끝을 넘으면 지운다. 끝난 봉(upto까지)만, 최근 look봉 안에서 뚫고 나간 것 중 살아 있는 것 (보여 줄 4개는 nearZones).
 * → [{s, e, i, lo, hi, kind:"res"|"sup"}]
 */
export function boxZones(bars, upto = bars.length - 1, look = 300) {
  const part = bars.slice(Math.max(0, upto + 1 - look - 60), upto + 1);
  const off = Math.max(0, upto + 1 - look - 60);
  if (part.length < 40) return [];
  const atr = C.atr(part, 14);
  const out = [];
  for (const z of findZones(part, atr)) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = z.s; k < z.i; k++) {
      lo = Math.min(lo, part[k].l);
      hi = Math.max(hi, part[k].h);
    }
    if (!(hi > lo)) continue;
    let dead = false;
    for (let k = z.i + 1; k < part.length; k++) {
      if (z.kind === "res" ? part[k].c > hi : part[k].c < lo) {
        dead = true;
        break;
      }
    }
    if (!dead) out.push({ s: z.s + off, e: z.i - 1 + off, i: z.i + off, lo, hi, kind: z.kind });
  }
  return out;
}
/** 지금 가격에서 가까운 상자 n개 (가까운 순) */
export function nearZones(zones, c, n = 4) {
  const d = (z) => (c >= z.lo && c <= z.hi ? 0 : Math.min(Math.abs(c - z.lo), Math.abs(c - z.hi)));
  return [...zones].sort((x, y) => d(x) - d(y)).slice(0, n);
}
/** 가장 가까운 상자와 가격의 위치 → {z, where: "안"·"아래"·"위"} 또는 null */
export function nearestZone(zones, c) {
  let best = null;
  for (const z of zones) {
    const d = c >= z.lo && c <= z.hi ? 0 : Math.min(Math.abs(c - z.lo), Math.abs(c - z.hi));
    if (!best || d < best.d) best = { z, d };
  }
  if (!best) return null;
  return { z: best.z, where: best.d === 0 ? "안" : c < best.z.lo ? "아래" : "위" };
}

/**
 * 한 줄 요약 (가이드, 사용자: "1~9번을 어떻게 해석할지 몰라"): 방향 · 위치 · 주의를 쉬운 말로. 사라·팔아라가 아니라 상황 요약.
 * s = {now, h1, h4, gap, ladder, near, fr, act}
 */
export function summaryOf(s) {
  const big = s.h4 ?? s.h1;
  const dirTxt = big === "above" ? "큰 흐름 오름" : big === "below" ? "큰 흐름 내림" : big === "inside" ? "큰 흐름 옆으로" : "큰 흐름 모름";
  const parts = [dirTxt];
  if (s.now === "inside") parts.push("지금은 구름 안(방향 없음)");
  else if (s.now && big && s.now !== big && big !== "inside") parts.push(s.now === "above" ? "지금은 반등 중" : "지금은 눌림 중");
  if (s.gap != null && Math.abs(s.gap) >= GAP_BIG) parts.push(s.gap > 0 ? "너무 올라옴 · 따라 사지 말기" : "너무 내려옴 · 따라 팔지 말기");
  if (s.ladder && /반응 발생/.test(s.ladder)) parts.push("둥근 숫자 칸에서 튕김");
  if (s.near) parts.push(s.near.where === "안" ? "걸린 가격대 안" : s.near.where === "아래" ? `위에 막힐 자리 ${s.near.price}` : `아래 받칠 자리 ${s.near.price}`);
  if (s.fr && /반대/.test(s.fr)) parts.push("예상과 반대로 깨짐 · 다시 보기");
  if (s.align === false) parts.push("방향 엇갈림 · 크게 걸지 말기");
  return parts.join(" · ");
}
