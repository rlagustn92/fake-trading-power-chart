// 지표 계산 (순수 함수). 입력: 봉 배열 [{t,o,h,l,c,v}], 출력: 같은 길이 배열(앞부분은 null).
// TradingView Pine 내장 함수와 같은 정의로 계산한다 (SPEC §3.2 검증 기준):
//   ta.sma, ta.ema(첫 값 = SMA), ta.rma(Wilder, 첫 값 = SMA), ta.vwma, ta.stdev(모표준편차), ta.rsi, ta.macd, ta.stoch, ta.atr

/** 이동평균의 "소스" (TradingView source와 같은 이름·계산, FAKE TRADING 0.14.0): 종가(기본)·시가·고가·저가·hl2·hlc3·ohlc4 */
export const SOURCES = [
  ["c", "종가"],
  ["o", "시가"],
  ["h", "고가"],
  ["l", "저가"],
  ["hl2", "(고+저)/2"],
  ["hlc3", "(고+저+종)/3"],
  ["ohlc4", "(시+고+저+종)/4"],
];
export function source(bars, key = "c") {
  if (key === "o" || key === "h" || key === "l") return bars.map((b) => b[key]);
  if (key === "hl2") return bars.map((b) => (b.h + b.l) / 2);
  if (key === "hlc3") return bars.map((b) => (b.h + b.l + b.c) / 3);
  if (key === "ohlc4") return bars.map((b) => (b.o + b.h + b.l + b.c) / 4);
  return bars.map((b) => b.c);
}

export function sma(src, n) {
  const out = new Array(src.length).fill(null);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    if (x == null) {
      sum = 0;
      cnt = 0;
      continue;
    }
    sum += x;
    cnt++;
    if (cnt > n) sum -= src[i - n];
    if (cnt >= n) out[i] = sum / n;
  }
  return out;
}

/** 지수 이동평균: alpha = 2/(n+1), 첫 값은 앞 n개의 SMA */
export function ema(src, n, alpha = 2 / (n + 1)) {
  const out = new Array(src.length).fill(null);
  let prev = null;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    if (x == null) continue;
    if (prev == null) {
      sum += x;
      cnt++;
      if (cnt === n) {
        prev = sum / n;
        out[i] = prev;
      }
      continue;
    }
    prev = alpha * x + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Wilder 평활 (RSI·ATR): alpha = 1/n */
export const rma = (src, n) => ema(src, n, 1 / n);

export function vwma(bars, n) {
  const pv = bars.map((b) => b.c * b.v);
  const v = bars.map((b) => b.v);
  const a = sma(pv, n);
  const b = sma(v, n);
  return a.map((x, i) => (x == null || !b[i] ? null : x / b[i]));
}

/** 모표준편차 (ta.stdev 기본 biased=true) */
export function stdev(src, n) {
  const out = new Array(src.length).fill(null);
  const m = sma(src, n);
  for (let i = n - 1; i < src.length; i++) {
    if (m[i] == null) continue;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += (src[k] - m[i]) ** 2;
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

export function bollinger(bars, n, mult) {
  const c = bars.map((b) => b.c);
  const basis = sma(c, n);
  const dev = stdev(c, n);
  return {
    basis,
    upper: basis.map((x, i) => (x == null ? null : x + mult * dev[i])),
    lower: basis.map((x, i) => (x == null ? null : x - mult * dev[i])),
  };
}

/** 아래 밴드: 보통은 가운데 − k·σ, TradingView vwBB(xinolia) 기본 "deviation band Mode"는 가운데² ÷ (가운데 + k·σ) (비율로 대칭) */
export const bandLower = (basis, dev, k, tv) => (tv ? (basis * basis) / (basis + k * dev) : basis - k * dev);

/**
 * 거래량 가중 볼린저 밴드 (VWBB): 가운데 = VWMA(n), 폭 = 거래량 가중 표준편차 × 배수
 * σ = √( Σ v·(종가 − VWMA)² ÷ Σ v )  — 최근 n봉, 거래가 많았던 봉의 가격이 더 크게 반영된다 (TradingView vwBB와 같은 식)
 * tv = 아래 밴드를 TradingView vwBB 기본 방식으로 · dev = σ (±1σ·±3σ 선 그릴 때)
 */
export function vwbb(bars, n, mult, tv = false) {
  const basis = vwma(bars, n);
  const upper = new Array(bars.length).fill(null);
  const lower = new Array(bars.length).fill(null);
  const dev = new Array(bars.length).fill(null);
  for (let i = n - 1; i < bars.length; i++) {
    const m = basis[i];
    if (m == null) continue;
    let sv = 0;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) {
      sv += bars[k].v;
      s += bars[k].v * (bars[k].c - m) ** 2;
    }
    if (!sv) continue;
    dev[i] = Math.sqrt(s / sv);
    upper[i] = m + mult * dev[i];
    lower[i] = bandLower(m, dev[i], mult, tv);
  }
  return { basis, upper, lower, dev };
}

export function rsi(bars, n) {
  const up = [null];
  const dn = [null];
  for (let i = 1; i < bars.length; i++) {
    const ch = bars[i].c - bars[i - 1].c;
    up.push(Math.max(ch, 0));
    dn.push(Math.max(-ch, 0));
  }
  const ru = rma(up, n);
  const rd = rma(dn, n);
  return ru.map((u, i) => (u == null || rd[i] == null ? null : rd[i] === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / rd[i])));
}

export function macd(bars, fast, slow, signal) {
  const c = bars.map((b) => b.c);
  const f = ema(c, fast);
  const s = ema(c, slow);
  const line = f.map((x, i) => (x == null || s[i] == null ? null : x - s[i]));
  const sig = ema(line, signal);
  return { macd: line, signal: sig, hist: line.map((x, i) => (x == null || sig[i] == null ? null : x - sig[i])) };
}

function highest(src, n, i) {
  let m = -Infinity;
  for (let k = i - n + 1; k <= i; k++) if (src[k] > m) m = src[k];
  return m;
}
function lowest(src, n, i) {
  let m = Infinity;
  for (let k = i - n + 1; k <= i; k++) if (src[k] < m) m = src[k];
  return m;
}

export function stoch(bars, n, smoothK, smoothD) {
  const h = bars.map((b) => b.h);
  const l = bars.map((b) => b.l);
  const raw = bars.map((b, i) => {
    if (i < n - 1) return null;
    const hh = highest(h, n, i);
    const ll = lowest(l, n, i);
    return hh === ll ? null : (100 * (b.c - ll)) / (hh - ll);
  });
  const k = smoothK > 1 ? sma(raw, smoothK) : raw;
  return { k, d: sma(k, smoothD) };
}

/**
 * 오프닝 레인지 (장 시작 N분의 고가·저가): 그 N분이 끝난 뒤 봉부터 그날 내내 같은 값, 그 전에는 빈 값(아직 모름)
 * dayKey(t) = 거래소 날짜, tod(t) = 거래소 현지 하루 중 초, start = 정규장 시작(하루 중 초)
 */
export function openingRange(bars, minutes, dayKey, tod, start) {
  const hi = new Array(bars.length).fill(null);
  const lo = new Array(bars.length).fill(null);
  const end = start + minutes * 60;
  let day = null;
  let h = -Infinity;
  let l = Infinity;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = dayKey(b.t);
    if (d !== day) {
      day = d;
      h = -Infinity;
      l = Infinity;
    }
    const s = tod(b.t);
    if (s >= start && s < end) {
      if (b.h > h) h = b.h;
      if (b.l < l) l = b.l;
    } else if (s >= end && h > -Infinity) {
      hi[i] = h;
      lo[i] = l;
    }
  }
  return { hi, lo };
}

export function trueRange(bars) {
  return bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
}

export const atr = (bars, n) => rma(trueRange(bars), n);

/** 상대 거래량 (RVOL): 이 봉 거래량 ÷ 바로 앞 n봉 평균 거래량 (이 봉은 평균에 넣지 않는다) */
export function rvol(bars, n) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i >= n) {
      const avg = sum / n;
      out[i] = avg > 0 ? bars[i].v / avg : null;
      sum -= bars[i - n].v;
    }
    sum += bars[i].v;
  }
  return out;
}

/**
 * 시간대별 상대 거래량 (Relative Volume at Time, 분봉):
 * 오늘 이 시각까지 누적 거래량 ÷ 지난 n일의 "같은 시각까지" 누적 거래량 평균
 * dayKey(t) = 날 번호, tod(t) = 하루 중 몇 초째 (거래소 현지 시각)
 */
export function rvolAtTime(bars, n, dayKey, tod) {
  const out = new Array(bars.length).fill(null);
  const days = []; // 지난 날들 {tods, cums}
  let cur = null;
  for (let i = 0; i < bars.length; i++) {
    const k = dayKey(bars[i].t);
    if (!cur || cur.key !== k) {
      if (cur) days.push(cur);
      cur = { key: k, tods: [], cums: [] };
    }
    const s = tod(bars[i].t);
    const cum = (cur.cums.length ? cur.cums[cur.cums.length - 1] : 0) + bars[i].v;
    cur.tods.push(s);
    cur.cums.push(cum);
    if (days.length < n) continue;
    let total = 0;
    let cnt = 0;
    for (let d = days.length - n; d < days.length; d++) {
      const D = days[d];
      // 그날 s 이하 시각의 마지막 봉까지 누적
      let lo = 0;
      let hi = D.tods.length - 1;
      let j = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (D.tods[mid] <= s) {
          j = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (j >= 0) {
        total += D.cums[j];
        cnt++;
      }
    }
    out[i] = cnt && total > 0 ? cum / (total / cnt) : null;
  }
  return out;
}

/** 고점대비 하락률(%): 그때까지 가장 높은 종가 대비 */
export function drawdown(bars) {
  let max = -Infinity;
  return bars.map((b) => {
    if (b.c > max) max = b.c;
    return (b.c / max - 1) * 100;
  });
}

/** 이격도(%): 종가 / 이동평균 − 1 */
export function disparity(bars, n) {
  const m = sma(bars.map((b) => b.c), n);
  return m.map((x, i) => (x == null ? null : (bars[i].c / x - 1) * 100));
}

/**
 * Williams Fractals: 가운데 봉 고가가 양옆 n봉보다 높으면 고점(▼), 저가가 낮으면 저점(▲).
 * 오른쪽 n봉이 생겨야 확정 → 마지막 n봉에는 없다.
 */
export function fractals(bars, n = 2) {
  const up = [];
  const down = [];
  for (let i = n; i < bars.length - n; i++) {
    let hi = true;
    let lo = true;
    for (let k = 1; k <= n && (hi || lo); k++) {
      if (!(bars[i].h > bars[i - k].h && bars[i].h > bars[i + k].h)) hi = false;
      if (!(bars[i].l < bars[i - k].l && bars[i].l < bars[i + k].l)) lo = false;
    }
    if (hi) up.push(i);
    if (lo) down.push(i);
  }
  return { up, down };
}

/**
 * 꼭짓점(피벗) — TradingView ta.pivothigh·ta.pivotlow와 같게: 왼쪽 L개보다 확실히 높고(낮고), 오른쪽 R개보다 높거나 같다(낮거나 같다).
 * 같은 값이 이어지면 왼쪽 것이 꼭짓점. 오른쪽 R개가 생겨야 확정 → 마지막 R개에는 없다. 빈 값(null)이 끼면 꼭짓점 아님.
 */
export function pivots(src, L, R) {
  const hi = [];
  const lo = [];
  for (let i = L; i < src.length - R; i++) {
    const v = src[i];
    if (v == null) continue;
    let isHi = true;
    let isLo = true;
    for (let k = -L; k <= R && (isHi || isLo); k++) {
      if (!k) continue;
      const x = src[i + k];
      if (x == null) isHi = isLo = false;
      else if (k < 0) {
        if (x >= v) isHi = false;
        if (x <= v) isLo = false;
      } else {
        if (x > v) isHi = false;
        if (x < v) isLo = false;
      }
    }
    if (isHi) hi.push(i);
    if (isLo) lo.push(i);
  }
  return { hi, lo };
}

/**
 * 다이버전스 (TradingView "RSI Divergence Indicator"와 같은 규칙): 오실레이터(RSI) 꼭짓점을 바로 앞 같은 쪽 꼭짓점과 비교.
 * 두 꼭짓점 사이 봉 수가 minGap~maxGap일 때만 (TradingView _inRange: 기본 5~60).
 * - bull  상승: 가격 저가는 더 낮은데 RSI 바닥은 더 높다      - hbull 히든 상승: 가격 저가는 더 높은데 RSI 바닥은 더 낮다
 * - bear  하락: 가격 고가는 더 높은데 RSI 꼭대기는 더 낮다    - hbear 히든 하락: 가격 고가는 더 낮은데 RSI 꼭대기는 더 높다
 * 돌려주는 것: [{kind, a, b}] (a·b = 두 꼭짓점 봉 번호, a < b). b 오른쪽에 right개가 생겨야 확정이라 그만큼 늦게 나온다.
 */
export function divergences(bars, osc, { left = 5, right = 5, minGap = 5, maxGap = 60 } = {}) {
  const pv = pivots(osc, left, right);
  const out = [];
  const scan = (idx, key, up) => {
    for (let k = 1; k < idx.length; k++) {
      const a = idx[k - 1];
      const b = idx[k];
      const gap = b - a - 1;
      if (gap < minGap || gap > maxGap) continue;
      const dp = bars[b][key] - bars[a][key];
      const dr = osc[b] - osc[a];
      // 바닥(lo): 가격↓ RSI↑ = 상승, 가격↑ RSI↓ = 히든 상승 / 꼭대기(hi): 가격↑ RSI↓ = 하락, 가격↓ RSI↑ = 히든 하락
      if (up ? dp < 0 && dr > 0 : dp > 0 && dr < 0) out.push({ kind: up ? "bull" : "bear", a, b });
      else if (up ? dp > 0 && dr < 0 : dp < 0 && dr > 0) out.push({ kind: up ? "hbull" : "hbear", a, b });
    }
  };
  scan(pv.lo, "l", true);
  scan(pv.hi, "h", false);
  return out.sort((x, y) => x.b - y.b);
}

/** 52주 고점·저점 (일봉 252개, 주봉 52개) */
export function rollingHighLow(bars, n) {
  const hi = new Array(bars.length).fill(null);
  const lo = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    const from = Math.max(0, i - n + 1);
    let h = -Infinity;
    let l = Infinity;
    for (let k = from; k <= i; k++) {
      if (bars[k].h > h) h = bars[k].h;
      if (bars[k].l < l) l = bars[k].l;
    }
    hi[i] = h;
    lo[i] = l;
  }
  return { hi, lo };
}

/**
 * VWAP: 세션(dayKey가 바뀌는 곳)마다 새로 시작. 가격 = (고+저+종)/3.
 * bands: 거래량 가중 표준편차 × 배수
 */
export function vwap(bars, dayKey, mults = []) {
  const v = new Array(bars.length).fill(null);
  const bands = mults.map(() => ({ up: new Array(bars.length).fill(null), dn: new Array(bars.length).fill(null) }));
  let key = null;
  let pv = 0;
  let vol = 0;
  let pv2 = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const k = dayKey(b.t);
    if (k !== key) {
      key = k;
      pv = vol = pv2 = 0;
    }
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v;
    pv2 += tp * tp * b.v;
    vol += b.v;
    if (!vol) continue;
    const m = pv / vol;
    v[i] = m;
    const sd = Math.sqrt(Math.max(0, pv2 / vol - m * m));
    mults.forEach((x, j) => {
      bands[j].up[i] = m + x * sd;
      bands[j].dn[i] = m - x * sd;
    });
  }
  return { vwap: v, bands };
}

/** 앵커드 VWAP: from 번째 봉부터 */
export function anchoredVwap(bars, from) {
  const out = new Array(bars.length).fill(null);
  let pv = 0;
  let vol = 0;
  for (let i = Math.max(0, from); i < bars.length; i++) {
    const b = bars[i];
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v;
    vol += b.v;
    out[i] = vol ? pv / vol : tp;
  }
  return out;
}

/** 클래식 피벗: 전날 고·저·종 → P, R1, R2, S1, S2 */
export function pivotLevels(h, l, c) {
  const p = (h + l + c) / 3;
  return { P: p, R1: 2 * p - l, S1: 2 * p - h, R2: p + (h - l), S2: p - (h - l) };
}

/**
 * 거래량 프로파일: 봉 하나의 거래량을 저가~고가에 고르게 나눠 rows칸에 쌓는다.
 * @returns {{lo, hi, step, vol:number[], poc:number, vaLo:number, vaHi:number}} 가치 영역 = 거래량 70%
 */
export function volumeProfile(bars, rows = 24, valueArea = 0.7) {
  if (!bars.length) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars) {
    if (b.l < lo) lo = b.l;
    if (b.h > hi) hi = b.h;
  }
  if (!(hi > lo)) return null;
  const step = (hi - lo) / rows;
  const vol = new Array(rows).fill(0);
  for (const b of bars) {
    if (!b.v) continue;
    const a = Math.min(rows - 1, Math.floor((b.l - lo) / step));
    const z = Math.min(rows - 1, Math.floor((b.h - lo) / step));
    const share = b.v / (z - a + 1);
    for (let k = a; k <= z; k++) vol[k] += share;
  }
  let poc = 0;
  for (let k = 1; k < rows; k++) if (vol[k] > vol[poc]) poc = k;
  const total = vol.reduce((s, x) => s + x, 0);
  let a = poc;
  let z = poc;
  let acc = vol[poc];
  while (acc < total * valueArea && (a > 0 || z < rows - 1)) {
    const below = a > 0 ? vol[a - 1] : -1;
    const above = z < rows - 1 ? vol[z + 1] : -1;
    if (above >= below) acc += vol[++z];
    else acc += vol[--a];
  }
  return { lo, hi, step, vol, poc, vaLo: a, vaHi: z };
}
