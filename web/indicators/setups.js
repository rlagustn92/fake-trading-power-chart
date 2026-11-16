// 매매 방식 지표의 계산 (순수 함수, 0.21.0). 그리기는 guides.js.
// 여러 공개 강의에서 배운 매매 규칙을 숫자로 옮긴 것. 말로만 된 규칙("강한 봉", "옆으로 긴다")은 여기서 숫자로 정했고
// 그런 값은 모두 지표 설정에서 바꿀 수 있다. 맞는다는 보장이 아니라 "규칙대로 그리면 여기"라는 표시다.
//
// 약속:
// - i번째 봉의 판정은 i번째까지의 봉만 쓴다 (미래 봉을 안 본다 → 리플레이·과거 차트에서 그때 보였을 그대로).
//   꼭짓점(스윙)만 예외로 양옆 n봉이 생겨야 확정되므로, 확정된 봉 번호(at)를 같이 돌려주고 쓰는 쪽이 at ≤ i인 것만 쓴다.
// - 숏 쪽은 봉을 뒤집어(가격에 −1) 롱 쪽 함수를 그대로 쓴다 (flipBars → 결과 가격도 −1).
// - 폭은 ATR(그 종목이 보통 한 봉에 움직이는 폭)의 몇 배로 잰다 → 종목·봉이 달라도 같은 설정이 통한다.

/** 봉 뒤집기: 숏을 롱처럼 계산하려고. 가격 ×(−1), 고가↔저가 */
export const flipBars = (bars) => bars.map((b) => ({ t: b.t, o: -b.o, h: -b.l, l: -b.h, c: -b.c, v: b.v }));
export const neg = (a) => a.map((x) => (x == null ? null : -x));

/** 꼭짓점(스윙 고점·저점): 왼쪽 n봉보다 확실히 높고(낮고) 오른쪽 n봉 이상(이하). at = 확정되는 봉 번호 (i + n) */
export function swingPoints(bars, n = 3) {
  const out = [];
  for (let i = n; i < bars.length - n; i++) {
    let H = true;
    let L = true;
    for (let k = 1; k <= n && (H || L); k++) {
      if (!(bars[i].h > bars[i - k].h) || !(bars[i].h >= bars[i + k].h)) H = false;
      if (!(bars[i].l < bars[i - k].l) || !(bars[i].l <= bars[i + k].l)) L = false;
    }
    if (H) out.push({ i, p: bars[i].h, kind: "H", at: i + n });
    if (L) out.push({ i, p: bars[i].l, kind: "L", at: i + n });
  }
  return out;
}

/**
 * 매매 계획: 진입가·손절가 → 손절 거리, R배 익절가, 수량.
 * 수량 = 잃어도 되는 돈 ÷ 손절 거리 (손절에 닿으면 딱 그 돈만 잃는다. 수수료·미끄러짐은 넣지 않은 값)
 */
export function tradePlan(side, entry, stop, riskAmt = 0, mults = [1, 2, 3]) {
  const long = side !== "short";
  const d = long ? entry - stop : stop - entry;
  if (!(entry > 0) || !(stop > 0) || !(d > 0)) return null;
  const qty = riskAmt > 0 ? riskAmt / d : null;
  return {
    side: long ? "long" : "short",
    entry,
    stop,
    dist: d,
    distPct: (d / entry) * 100,
    targets: mults.map((k) => ({ k, price: long ? entry + k * d : entry - k * d })),
    qty,
    notional: qty == null ? null : qty * entry,
  };
}

/** 손익비: (목표 − 진입) ÷ (진입 − 손절). 롱·숏 모두 양수가 "유리한 쪽" */
export function rrOf(entry, stop, target) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return ((target - entry) * Math.sign(entry - stop)) / risk;
}

// ── 국면 판정 (한 봉) ──

/** 6선 방식: 7·21·60선 배열. 세 선이 ATR boxK배 안에 뭉쳐 있으면 박스, 7>21>60 정배열, 7<21<60 역배열, 그 밖은 전환 */
export function sixState(m7, m21, m60, atr, boxK = 1) {
  if (m7 == null || m21 == null || m60 == null || !(atr > 0)) return null;
  if (Math.max(m7, m21, m60) - Math.min(m7, m21, m60) < boxK * atr) return "box";
  if (m7 > m21 && m21 > m60) return "up";
  if (m7 < m21 && m21 < m60) return "down";
  return "turn";
}

/** 20선 방식: 선이 가격 아래 + 위로 기움 = 상승, 가격 위 + 아래로 기움 = 하락, 기울기가 거의 없으면 평평(매매 금지). slope = k봉 동안 선이 움직인 폭 ÷ ATR */
export function e20State(close, ma, maPrev, atr, flatK = 0.25) {
  if (close == null || ma == null || maPrev == null || !(atr > 0)) return null;
  const slope = (ma - maPrev) / atr;
  if (Math.abs(slope) < flatK) return "flat";
  if (slope > 0 && close > ma) return "up";
  if (slope < 0 && close < ma) return "down";
  return "mixed";
}

/** 50·200 방식: 50>200 정배열이고 가격이 50선 위 = 롱 적극, 50<200 역배열이고 가격이 50선 아래 = 숏 쪽·소극, 그 밖은 기다림(눌림·반등 중) */
export function s50State(close, m50, m200) {
  if (close == null || m50 == null || m200 == null) return null;
  if (m50 > m200 && close >= m50) return "up";
  if (m50 < m200 && close <= m50) return "down";
  return "wait";
}
/** 50·200 배열만: "up" 정배열 · "down" 역배열 */
export const s50Order = (m50, m200) => (m50 == null || m200 == null ? null : m50 > m200 ? "up" : "down");

/**
 * 4단계 (와인스타인): 2 상승 = 가격>50>200 이고 50선이 오름 · 4 하락 = 가격<50<200 이고 50선이 내림 ·
 * 1 매집 = 50<200 인데 4가 아님(바닥에서 옆으로) · 3 분배 = 50>200 인데 2가 아님(위에서 흔들림)
 */
export function stageOf(close, m50, m50Prev, m200) {
  if (close == null || m50 == null || m50Prev == null || m200 == null) return null;
  if (close > m50 && m50 > m200 && m50 > m50Prev) return 2;
  if (close < m50 && m50 < m200 && m50 < m50Prev) return 4;
  return m50 > m200 ? 3 : 1;
}

/**
 * 올웨이즈 인 (봉 읽기 방식): 종가가 20 EMA 한쪽에 minBars(10)봉 이상 이어지면 그쪽 추세(1·−1), 아니면 레인지(0).
 * 추세가 된 뒤에는 반대쪽 종가가 flip(3)봉 이어져야 레인지로 돌아간다 (봉 하나로는 안 뒤집힌다).
 */
export function alwaysIn(bars, ema, minBars = 10, flip = 3) {
  const st = new Array(bars.length).fill(0);
  let run = 0; // 같은 쪽으로 이어진 봉 수 (+위 −아래)
  let cur = 0;
  for (let i = 0; i < bars.length; i++) {
    const e = ema[i];
    if (e == null) continue;
    const side = bars[i].c > e ? 1 : bars[i].c < e ? -1 : 0;
    run = side === 0 ? 0 : Math.sign(run) === side ? run + side : side;
    if (Math.abs(run) >= minBars) cur = Math.sign(run);
    else if (cur && Math.sign(run) === -cur && Math.abs(run) >= flip) cur = 0;
    st[i] = cur;
  }
  return st;
}

// ── 옆으로 긴 구간(베이스) ──

/** 길이별 "좁다"의 기준 (ATR 배수): 8봉 2.3 · 12봉 2.7 · 20봉 3.5 · 30봉 4.5. tight로 한꺼번에 늘리고 줄인다 */
const tightK = (len, tight) => (1.5 + len / 10) * tight;

/**
 * i번째 봉 바로 앞의 좁은 횡보 구간: 길이 후보(lens, 긴 것부터) 중 높이가 기준보다 좁은 가장 긴 것.
 * → {s, e, hi, lo} (s~e = i−len ~ i−1) 또는 null
 */
export function tightBase(bars, atr, i, lens = [30, 20, 12, 8], tight = 1) {
  const a = atr[i - 1];
  if (!(a > 0)) return null;
  for (const len of lens) {
    const s = i - len;
    if (s < 0) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = s; k < i; k++) {
      if (bars[k].h > hi) hi = bars[k].h;
      if (bars[k].l < lo) lo = bars[k].l;
    }
    if (hi - lo <= tightK(len, tight) * a) return { s, e: i - 1, hi, lo };
  }
  return null;
}

/**
 * 베이스가 권총인지 ㄴ자인지:
 * - 권총: 강하게 오른 뒤(베이스 바닥이 직전 저점보다 impK×ATR 이상 위) 꼭대기에서 쉬고, 느린 이평이 아래에서 따라 올라와 붙음
 * - ㄴ자: 강하게 내린 뒤(직전 고점이 베이스 천장보다 impK×ATR 이상 위) 바닥에서 기고, 느린 이평이 위에서 내려와 붙음
 * → {kind, from(움직임이 시작된 가격), move(움직인 폭)} 또는 null
 */
export function classifyBase(bars, b, slow, a, o = {}) {
  const { impLen = 40, impK = 5, maK = 1 } = o;
  if (slow == null || !(a > 0)) return null;
  let pLo = Infinity;
  let pHi = -Infinity;
  for (let k = Math.max(0, b.s - impLen); k < b.s; k++) {
    if (bars[k].l < pLo) pLo = bars[k].l;
    if (bars[k].h > pHi) pHi = bars[k].h;
  }
  if (pLo === Infinity) return null;
  const rise = b.lo - pLo;
  const drop = pHi - b.hi;
  if (rise >= impK * a && pHi <= b.hi + a && slow >= b.lo - maK * a && slow <= b.hi) return { kind: "pistol", from: pLo, move: b.hi - pLo };
  if (drop >= impK * a && pLo >= b.lo - a && slow <= b.hi + maK * a && slow >= b.lo - maK * a) return { kind: "lshape", from: pHi, move: pHi - b.lo };
  return null;
}

/**
 * 권총·ㄴ자 찾기. 베이스를 종가로 벗어나는 봉에서 신호:
 * dir "go" = 위로 벗어남(롱 자리) · "fail" = 아래로 벗어남(권총이면 추세 변곡 → 롱 정리, ㄴ자면 하락 지속)
 * → [{i, kind, dir, s, e, hi, lo, from, move, entry, stop, half}] (half = ㄴ자의 "하락분 절반" 익절가)
 */
export function findSetups(bars, slow, atr, o = {}) {
  const { lens, tight = 1, gap = 8 } = o;
  const out = [];
  const last = {};
  for (let i = 20; i < bars.length; i++) {
    const b = tightBase(bars, atr, i, lens, tight);
    if (!b) continue;
    const c = bars[i].c;
    const up = c > b.hi;
    const dn = c < b.lo;
    if (!up && !dn) continue;
    const k = classifyBase(bars, b, slow[i], atr[i - 1], o);
    if (!k) continue;
    if (up && k.kind === "lshape" && !(c > slow[i])) continue; // ㄴ자는 느린 이평을 올라타야
    const dir = up ? "go" : "fail";
    const key = k.kind + dir;
    if (last[key] != null && i - last[key] < gap) continue;
    last[key] = i;
    out.push({ i, kind: k.kind, dir, s: b.s, e: b.e, hi: b.hi, lo: b.lo, from: k.from, move: k.move, entry: c, stop: up ? b.lo : b.hi, half: k.kind === "lshape" ? b.lo + (k.from - b.lo) / 2 : null });
  }
  return out;
}

/** 아직 안 벗어난(만들어지는 중인) 권총·ㄴ자: 맨 끝 봉까지 넣어서 본 베이스 → {kind, s, e, hi, lo, from, move, half} 또는 null */
export function pendingSetup(bars, slow, atr, o = {}) {
  const n = bars.length;
  if (n < 21) return null;
  const b = tightBase(bars, atr, n, o.lens, o.tight ?? 1);
  if (!b) return null;
  const k = classifyBase(bars, b, slow[n - 1], atr[n - 1], o);
  if (!k) return null;
  return { ...b, ...k, half: k.kind === "lshape" ? b.lo + (k.from - b.lo) / 2 : null };
}

/** 거래량 배수: i번째 봉 거래량 ÷ 바로 앞 n봉 평균 ("닿는 순간 거래량이 터졌나"). 거래량이 없으면 null */
export function volRatio(bars, i, n = 20) {
  if (i < n) return null;
  let sum = 0;
  for (let k = i - n; k < i; k++) sum += bars[k].v ?? 0;
  const v = bars[i].v;
  return sum > 0 && v != null ? v / (sum / n) : null;
}

/**
 * 매물대 (손바뀜 자리) 자동 찾기 — 참고용 근사치: 여러 봉이 같은 값에서 막히던 좁은 구간을 몸통 큰 봉(bigK×ATR 이상)이 종가로 뚫은 자리.
 * 위로 뚫으면 막던 값(구간 몸통의 맨 위)이 지지 "sup", 아래로 뚫으면 받치던 값(몸통의 맨 아래)이 저항 "res". 꼬리는 무시하고 몸통으로 잡는다.
 * test = 그 뒤 처음 다시 닿은 봉 번호(리테스트. 아직이면 −1) — 아직 안 닿은 매물대의 첫 리테스트가 가장 세다.
 * → [{i, s, kind, level, test}]
 */
export function findZones(bars, atr, o = {}) {
  const { lens, tight = 1, bigK = 1.5, gap = 5 } = o;
  const out = [];
  const last = {};
  for (let i = 20; i < bars.length; i++) {
    const b = tightBase(bars, atr, i, lens, tight);
    const a = atr[i - 1];
    if (!b) continue;
    const x = bars[i];
    if (Math.abs(x.c - x.o) < bigK * a) continue;
    let top = -Infinity;
    let bot = Infinity;
    for (let k = b.s; k <= b.e; k++) {
      top = Math.max(top, bars[k].o, bars[k].c);
      bot = Math.min(bot, bars[k].o, bars[k].c);
    }
    const kind = x.c > top && x.c > x.o ? "sup" : x.c < bot && x.c < x.o ? "res" : null;
    if (!kind) continue;
    const level = kind === "sup" ? top : bot;
    const p = last[kind];
    if (p && i - p.i < gap && Math.abs(level - p.level) < a) continue;
    let test = -1;
    for (let k = i + 1; k < bars.length; k++) {
      if (kind === "sup" ? bars[k].l <= level : bars[k].h >= level) {
        test = k;
        break;
      }
    }
    const z = { i, s: b.s, kind, level, test };
    last[kind] = z;
    out.push(z);
  }
  return out;
}

// ── 20선 눌림 ──

/**
 * 오르는 20선까지 눌린 자리 (롱 쪽. 숏은 flipBars).
 * 꼭 있어야 하는 것: ① 20선이 오르는 중 ② 직전 상승폭의 lo~hi(40~60%)만 되돌림 ③ 눌림에 음봉 reds(3)개 연속
 * ④ 눌림 저점이 20선 근처 ⑤ 신호 봉이 몸통 작은 봉(좁은 봉·도지) ⑥ 손익비 minRR(2) 이상
 * 진입 = 신호 봉 고가 위, 손절 = 눌림 저점 아래, 목표 = 직전 고점.
 * → [{i, h, l, entry, stop, target, rr, ok, ret}] (ok = 손익비까지 통과. 고점 하나에 한 번만)
 */
export function findPullbacks(bars, ma, atr, o = {}) {
  const { look = 30, k = 5, flatK = 0.25, lo = 0.4, hi = 0.6, reds = 3, touchK = 0.5, nrK = 0.8, minRR = 2, tick = 0 } = o;
  const out = [];
  let doneH = -1;
  let badH = -1;
  for (let i = look; i < bars.length; i++) {
    const a = atr[i];
    const m = ma[i];
    const mp = ma[i - k];
    if (!(a > 0) || m == null || mp == null) continue;
    if ((m - mp) / a < flatK) continue;
    let h = -1;
    for (let j = i - 1; j >= i - look; j--) if (h < 0 || bars[j].h > bars[h].h) h = j;
    if (i - h < 2 || h === doneH) continue;
    let l = -1;
    for (let j = h - 1; j >= Math.max(0, h - look); j--) if (l < 0 || bars[j].l < bars[l].l) l = j;
    if (l < 0) continue;
    const H = bars[h].h;
    const L = bars[l].l;
    if (!(H - L >= 2 * a)) continue;
    let pl = Infinity;
    let run = 0;
    let maxRun = 0;
    // 고점을 찍은 봉이 음봉이면 그 봉부터 눌림으로 센다 (고점 봉이 곧 첫 음봉인 일이 흔하다)
    for (let j = h; j <= i; j++) {
      if (j > h && bars[j].l < pl) pl = bars[j].l;
      if (bars[j].c < bars[j].o) maxRun = Math.max(maxRun, ++run);
      else run = 0;
    }
    const ret = (H - pl) / (H - L);
    const b = bars[i];
    const rng = b.h - b.l;
    const narrow = rng <= nrK * a || Math.abs(b.c - b.o) <= 0.3 * rng;
    if (!(ret >= lo && ret <= hi) || maxRun < reds || !(pl <= m + touchK * a && b.c >= m - touchK * a) || !narrow || !(b.l <= pl + 0.3 * a)) continue;
    const entry = b.h + tick;
    const stop = pl - tick;
    const rr = rrOf(entry, stop, H);
    const ok = rr >= minRR;
    if (!ok && h === badH) continue;
    if (ok) doneH = h;
    else badH = h;
    out.push({ i, h, l, entry, stop, target: H, rr, ok, ret });
  }
  return out;
}

// ── 6선 방식 ──

/**
 * 이평선 첫 닿음: 앞 gapBars봉 동안 안 닿았던 선에 처음 닿은 봉. side "sup"(위에서 내려와 닿음) · "res"(아래에서 올라가 닿음).
 * strong = 캔들이 다가가서 닿음(세다) · 아니면 이평선이 다가와서 닿음(약하다): k봉 동안 가격이 움직인 폭이 선이 움직인 폭의 2배 이상
 */
export function firstTouches(bars, ma, gapBars = 20, k = 5) {
  const out = [];
  let lastSup = -Infinity;
  let lastRes = -Infinity;
  for (let i = 1; i < bars.length; i++) {
    const m = ma[i];
    if (m == null) continue;
    const b = bars[i];
    const touch = b.l <= m && b.h >= m;
    if (!touch) continue;
    const pm = ma[i - 1];
    const fromAbove = pm != null && bars[i - 1].l > pm;
    const fromBelow = pm != null && bars[i - 1].h < pm;
    const strong = i >= k && ma[i - k] != null ? Math.abs((fromAbove ? b.l : b.h) - bars[i - k].c) >= 2 * Math.abs(m - ma[i - k]) : true;
    if (fromAbove) {
      if (i - lastSup > gapBars) out.push({ i, side: "sup", strong });
      lastSup = i;
    } else if (fromBelow) {
      if (i - lastRes > gapBars) out.push({ i, side: "res", strong });
      lastRes = i;
    } else {
      lastSup = lastRes = i; // 선을 끼고 비비는 중 → 첫 닿음이 아니다
    }
  }
  return out;
}

/**
 * 작은 봉(5분봉) 진입 신호 (롱 쪽. 숏은 flipBars + 자리 값도 neg).
 * levels = [{name, vals}] 큰 봉에서 정한 자리(이평선)의 봉별 값. 자리 nearPct% 안에서만 본다.
 * A 예측형: 7선에서 gapPct% 넘게 벌어지며 자리에 꽂힌 뒤, 양봉이 앞 봉 몸통을 넘겨 마감(장악). 목표 = 21선
 * B 확인형: 자리에서 쌍바닥(두 저점이 dbTol×ATR 안) 뒤 종가가 21선 위로 올라섬. 목표 = 두 바닥 사이 고점
 * → [{i, type, lv, entry, stop, target}]
 */
export function findSixTriggers(bars, m7, m21, atr, levels, o = {}) {
  const { gapPct = 0.6, nearPct = 0.3, tick = 0, swing = 3, dbTol = 0.5, wait = 12, gap = 5 } = o;
  const nearLv = (p, i) => {
    for (const L of levels) {
      const v = L.vals[i];
      if (v != null && Math.abs(p / v - 1) * 100 <= nearPct) return L;
    }
    return null;
  };
  const out = [];
  let lastA = -Infinity;
  for (let i = 2; i < bars.length; i++) {
    const b = bars[i];
    const p = bars[i - 1];
    if (!(b.c > b.o) || !(b.c > Math.max(p.o, p.c)) || i - lastA < gap || m21[i] == null) continue;
    for (const k of [i, i - 1, i - 2]) {
      if (m7[k] == null) continue;
      const lv = nearLv(bars[k].l, k);
      // 뒤집은 봉(숏)에서는 가격이 음수라 비율의 부호가 바뀐다 → 거리로 잰다
      const away = ((m7[k] - bars[k].l) / Math.abs(m7[k])) * 100;
      if (!lv || away < gapPct) continue;
      const stop = Math.min(b.l, p.l, bars[i - 2].l) - tick;
      if (!(m21[i] > b.c)) break; // 이미 21선 위 → 목표가 없다
      out.push({ i, type: "A", lv: lv.name, entry: b.c, stop, target: m21[i] });
      lastA = i;
      break;
    }
  }
  const lows = swingPoints(bars, swing).filter((x) => x.kind === "L");
  for (let q = 1; q < lows.length; q++) {
    const p1 = lows[q - 1];
    const p2 = lows[q];
    const a = atr[p2.i];
    if (!(a > 0) || p2.i - p1.i < 5 || p2.i - p1.i > 60 || Math.abs(p1.p - p2.p) > dbTol * a) continue;
    const base = Math.min(p1.p, p2.p);
    const lv = nearLv(base, p2.i);
    if (!lv) continue;
    for (let i = p2.at; i < Math.min(bars.length, p2.at + wait); i++) {
      if (bars[i].l < base - dbTol * a) break; // 쌍바닥이 깨졌다
      if (m21[i] == null || !(bars[i].c > m21[i])) continue;
      if (i > p2.at && m21[i - 1] != null && bars[i - 1].c > m21[i - 1]) break; // 이미 올라선 뒤
      let top = -Infinity;
      for (let k = p1.i; k <= p2.i; k++) if (bars[k].h > top) top = bars[k].h;
      out.push({ i, type: "B", lv: lv.name, entry: bars[i].c, stop: base - tick, target: top });
      break;
    }
  }
  return out.sort((x, y) => x.i - y.i);
}

// ── VWAP 스윙: 첫 더 높은 고점 ──

/**
 * 눌린 뒤 옆으로 긴 구간의 고점을 처음 넘는 봉 ("눌림을 사지 말고 눌림 뒤의 힘을 사라").
 * 조건: 5일선이 내려가는 중이 아니고 종가가 그 위 · 구간에 들어오기 전 dipK×ATR 이상 눌림이 있었음.
 * 진입 = 구간 고점 위, 손절 = 구간 저점(가장 최근 더 높은 저점) 아래 → [{i, s, e, hi, lo, entry, stop}]
 */
export function findFirstHH(bars, ma, atr, o = {}) {
  const { lens = [12, 8, 5], tight = 1, dipK = 2, look = 40, tick = 0, k = 5, gap = 5 } = o;
  const out = [];
  let last = -Infinity;
  for (let i = Math.max(k, 6); i < bars.length; i++) {
    if (i - last < gap) continue;
    const b = tightBase(bars, atr, i, lens, tight);
    const a = atr[i - 1];
    if (!b || !(bars[i].h > b.hi) || ma[i] == null || ma[i - k] == null) continue;
    if (!(bars[i].c > ma[i]) || ma[i] < ma[i - k] - 0.1 * a) continue;
    let pHi = -Infinity;
    for (let j = Math.max(0, b.s - look); j < b.s; j++) if (bars[j].h > pHi) pHi = bars[j].h;
    if (!(pHi - b.lo >= dipK * a)) continue;
    out.push({ i, s: b.s, e: b.e, hi: b.hi, lo: b.lo, entry: b.hi + tick, stop: b.lo - tick });
    last = i;
  }
  return out;
}

/** 분봉에서 하루에 봉이 몇 개인지 (최근 날들의 가운데 값) → "5일선" 기간 = 5 × 이 값 */
export function barsPerDay(bars, dayKey, days = 10) {
  const counts = [];
  let key = null;
  let n = 0;
  for (let i = bars.length - 1; i >= 0 && counts.length <= days; i--) {
    const k = dayKey(bars[i].t);
    if (k !== key) {
      if (key !== null) counts.push(n);
      key = k;
      n = 0;
    }
    n++;
  }
  counts.shift(); // 맨 끝 날은 아직 진행 중이라 뺀다
  if (!counts.length) return n || 1;
  counts.sort((x, y) => x - y);
  return counts[Math.floor(counts.length / 2)];
}

// ── 봉 읽기 ──

/** 좋은 매수 신호 봉: 양봉 + 고가 근처(위 30%) 마감 + 크기가 ATR 절반 이상 + (몸통이 봉의 40% 이상이거나 아래꼬리가 1/3 이상인 반전 봉) */
export function isSignalBar(b, a) {
  const rng = b.h - b.l;
  if (!(rng > 0) || !(a > 0) || !(b.c > b.o) || rng < 0.5 * a) return false;
  if ((b.c - b.l) / rng < 0.7) return false;
  return (b.c - b.o) / rng >= 0.4 || (Math.min(b.o, b.c) - b.l) / rng >= 1 / 3;
}

/** 레인지 구간(i 바로 앞 len봉)의 고·저와 3등분 선 */
/**
 * 자동 피보 (0.22.0): 최근 look봉에서 가장 높은 고가와 가장 낮은 저가를 잇는다. 뒤에 나온 쪽이 움직임의 '끝'.
 * 되돌림은 끝(0)에서 시작(1) 쪽으로 잰다: 오른 움직임이면 고점에서 아래로, 내린 움직임이면 저점에서 위로.
 * end번 봉까지만 본다. 돌려주는 것: {up, hi, lo, H, L, from, price(lv)} 또는 null
 */
export function autoFib(bars, look = 120, end = bars.length - 1) {
  const s = Math.max(0, end - look + 1);
  let hi = -1;
  let lo = -1;
  for (let i = s; i <= end; i++) {
    if (!bars[i]) continue;
    if (hi < 0 || bars[i].h > bars[hi].h) hi = i;
    if (lo < 0 || bars[i].l < bars[lo].l) lo = i;
  }
  if (hi < 0 || hi === lo || !(bars[hi].h > bars[lo].l)) return null;
  const up = lo < hi;
  const H = bars[hi].h;
  const L = bars[lo].l;
  return { up, hi, lo, H, L, from: Math.min(hi, lo), price: (lv) => (up ? H - (H - L) * lv : L + (H - L) * lv) };
}

export function rangeZone(bars, i, len = 40) {
  const s = Math.max(0, i - len);
  if (i - s < 5) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = s; k < i; k++) {
    if (bars[k].h > hi) hi = bars[k].h;
    if (bars[k].l < lo) lo = bars[k].l;
  }
  const third = (hi - lo) / 3;
  return { s, hi, lo, t1: lo + third, t2: hi - third };
}

/**
 * 봉 읽기 신호 (롱 쪽. 숏은 flipBars + st에 −1).
 * 추세(st = 1)일 때: 눌림(고가가 낮아지는 봉) 중에 20 EMA 근처에서 나온 좋은 신호 봉. n = 이 눌림에서 몇 번째 신호(H1·H2),
 *   leg = 지금 몇 번째 다리(3번째부터는 warn: 새로 들어가지 않는다).
 * 레인지(st = 0)일 때: 아래 1/3에서 나온 좋은 신호 봉 (range: true). 목표 = 위 1/3 시작.
 * 진입 = 신호 봉 고가 위 역지정, 손절 = 신호 봉 저가 아래, 목표 = 위험의 rr배.
 * hit = 다음 봉이 진입가를 넘었는지 (true 체결 · false 취소 · null 아직 모름)
 * skip(i) → true면 그 봉은 신호를 안 낸다 (장 시작 직후)
 */
export function findBarSignals(bars, ema, atr, st, o = {}) {
  const { tick = 0, rr = 2, pullK = 1, rangeLen = 40, skip } = o;
  const out = [];
  let trendHi = -Infinity;
  let inPull = false;
  let attempts = 0;
  let legs = 1;
  let lastRange = -Infinity;
  const push = (i, extra) => {
    const b = bars[i];
    const entry = b.h + tick;
    const stop = b.l - tick;
    const nx = bars[i + 1];
    out.push({ i, entry, stop, target: entry + rr * (entry - stop), hit: nx ? nx.h >= entry : null, ...extra });
  };
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const a = atr[i];
    if (st[i] === 1) {
      if (st[i - 1] !== 1) {
        trendHi = b.h;
        legs = 1;
        inPull = false;
        attempts = 0;
      } else if (b.h > trendHi) {
        if (inPull) legs++;
        trendHi = b.h;
        inPull = false;
        attempts = 0;
      } else if (b.h < bars[i - 1].h) inPull = true;
      if (inPull && !skip?.(i) && ema[i] != null && b.l <= ema[i] + pullK * a && isSignalBar(b, a)) {
        attempts++;
        push(i, { n: attempts, leg: legs + 1, warn: legs + 1 >= 3 });
      }
    } else if (st[i] === 0 && i - lastRange >= 5 && !skip?.(i) && isSignalBar(b, a)) {
      const z = rangeZone(bars, i, rangeLen);
      if (z && b.l <= z.t1 && z.t2 > b.h) {
        const entry = b.h + tick;
        const stop = b.l - tick;
        const nx = bars[i + 1];
        out.push({ i, entry, stop, target: z.t2, hit: nx ? nx.h >= entry : null, range: true });
        lastRange = i; // 같은 자리에서 신호가 줄줄이 나오지 않게 5봉 띄운다
      }
    }
  }
  return out;
}

/** 지금 추세에서 몇 번째 다리인지 (맨 끝 봉 기준). 추세가 아니면 0 */
export function legCount(bars, st) {
  const n = bars.length;
  if (!n || !st[n - 1]) return 0;
  const dir = st[n - 1];
  let s = n - 1;
  while (s > 0 && st[s - 1] === dir) s--;
  let ext = dir > 0 ? bars[s].h : bars[s].l;
  let legs = 1;
  let inPull = false;
  for (let i = s + 1; i < n; i++) {
    const b = bars[i];
    const p = bars[i - 1];
    if (dir > 0 ? b.h > ext : b.l < ext) {
      if (inPull) legs++;
      ext = dir > 0 ? b.h : b.l;
      inPull = false;
    } else if (dir > 0 ? b.h < p.h : b.l > p.l) inPull = true;
  }
  return legs;
}
