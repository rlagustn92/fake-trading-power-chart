// 그린 것의 점(시각·가격) ↔ 지금 화면의 봉 위치 (SPEC §3.4)
// 점은 {t, p}(분봉에서 찍음, UTC 초) 또는 {d, p}(일·주봉에서 찍음, 날짜 값)로 저장한다
// → 어느 봉으로 보든 같은 시각·가격에 보인다 (TradingView와 같음)
// 선은 화면에서 곧게 보이는 대로 계산한다: 가로 = 봉 위치, 세로 = 가격(로그 눈금이면 log 가격)
import { DAY, tzOffset, localDay } from "../core/tz.js";
import { TF_SEC, isDailyTf } from "../core/bars.js";

const H = 3600;

/** 봉 목록 + 종목 정보 → 변환기 */
export function createMapper({ bars, tf, info, ext = false, log = false }) {
  const daily = isDailyTf(tf);
  const n = bars.length;
  const K = (i) => bars[i].t;
  const night = (info.anchor ?? 0) >= 12 * H; // CME 선물: 전날 저녁에 하루가 시작
  const sessionDay = (t) => localDay(info.dayTz, t + (night ? DAY - info.anchor : 0));
  const dayStart = (d) => {
    const start = info.rth ? (ext ? info.extAnchor : info.rth[0]) : info.anchor ?? 0;
    return d - tzOffset(info.tz, d) + start - (night ? DAY : 0);
  };
  // 봉이 없는 곳(왼쪽 밖·오른쪽 미래)은 가까운 봉들의 평균 간격으로 늘린다
  const a = Math.min(n - 1, 200);
  const densL = n > 1 && K(a) > K(0) ? a / (K(a) - K(0)) : 1 / TF_SEC[tf];
  const b = Math.min(n - 1, 60);
  const densR = daily && n > 1 && K(n - 1) > K(n - 1 - b) ? b / (K(n - 1) - K(n - 1 - b)) : 1 / TF_SEC[tf];

  const keyOf = (pt) => (daily ? pt.d ?? sessionDay(pt.t) : pt.t ?? dayStart(pt.d));
  const f = log ? (p) => Math.log(Math.max(p, 1e-12)) : (p) => p;
  const finv = log ? Math.exp : (v) => v;

  /** 점 → 봉 위치 (소수, 밖이어도 됨) */
  function logical(pt) {
    if (!n) return null;
    return base(pt) + (pt.o ?? 0); // o: 봉 사이 위치 (Brush처럼 매끄럽게 그린 점)
  }
  function base(pt) {
    const k = keyOf(pt);
    if (k <= K(0)) return (k - K(0)) * densL;
    if (k >= K(n - 1)) return n - 1 + (k - K(n - 1)) * densR;
    let lo = 0;
    let hi = n - 1; // K(lo) <= k < K(hi)
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (K(m) <= k) lo = m;
      else hi = m;
    }
    return K(lo) === k ? lo : lo + (k - K(lo)) / (K(hi) - K(lo));
  }

  /** 봉 위치 → 저장할 점 */
  function point(L, p) {
    let k;
    if (L >= 0 && L <= n - 1) k = K(Math.round(L));
    else if (L > n - 1) k = K(n - 1) + (L - (n - 1)) / densR;
    else k = K(0) + L / densL;
    return daily ? { d: Math.round(k / DAY) * DAY, p } : { t: Math.round(k / 60) * 60, p };
  }

  /** 봉 위치 → 시각 (UTC 초, 일봉은 날짜 값) — 꼭짓점·기간 표시용 */
  function timeAt(L) {
    const pt = point(L, 0);
    return pt.d ?? pt.t;
  }

  return { n, daily, f, finv, logical, point, timeAt, keyOf };
}

/** 두 점을 지나는 선의 L 위치 값 (F 공간) */
export function lineAt(A, B, L) {
  if (B.L === A.L) return A.F;
  return A.F + ((B.F - A.F) * (L - A.L)) / (B.L - A.L);
}

/** 두 선의 만나는 점 (없거나 평행이면 null) */
export function intersect(A1, B1, A2, B2) {
  const s1 = (B1.F - A1.F) / (B1.L - A1.L || 1e-9);
  const s2 = (B2.F - A2.F) / (B2.L - A2.L || 1e-9);
  if (Math.abs(s1 - s2) < 1e-12) return null;
  const L = (A2.F - A1.F + s1 * A1.L - s2 * A2.L) / (s1 - s2);
  return { L, F: A1.F + s1 * (L - A1.L) };
}

/** 점과 선분 사이 거리 (화면 픽셀) */
export function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - x1) * dx + (py - y1) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 선분을 화면 끝까지 늘리기 (left/right) */
export function extend(x1, y1, x2, y2, W, left, right) {
  if (x1 === x2) return [x1, y1, x2, y2];
  const s = (y2 - y1) / (x2 - x1);
  const [ax, ay, bx, by] = x1 <= x2 ? [x1, y1, x2, y2] : [x2, y2, x1, y1];
  const lx = left ? Math.min(ax, -10) : ax;
  const rx = right ? Math.max(bx, W + 10) : bx;
  return [lx, ay + s * (lx - ax), rx, by + s * (rx - bx)];
}
