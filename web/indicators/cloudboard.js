// 구름 상황판 = "나뇨띠 지표" (0.28.0). 순수 계산 (tests.js에서 시험), 그리기는 guides.js의 nanyotti.
// 일목 구름을 기준으로 방향·위치·힘을 9줄 표로 보여 주는 우리 추정판.
//   구름 = 트레이딩뷰 기본 일목(9·26·52, 26칸 앞으로), 계산은 마지막으로 끝난 봉 기준("마감 기준"),
//   구름 이격 = (종가 − 가까운 구름 끝) ÷ ATR(14), 큰 시간봉 = 1시간·4시간 구름 위·안·아래,
//   시장 활동 = 거래량 ÷ 앞 20봉 평균, ATR(14) ÷ ATR 50봉 평균
//   내가 정한 값(추정) — 이격 큼 기준 2, 2·4·6·8의 반응 나누기, 프랙탈의 쉼 찾기 (줄마다 확인된 것과 추정을 함수 설명에 적었다)

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
 * 5번 줄 2·4·6·8 (비트코인 3분봉 전용, 0.30.2).
 * 켜짐: 지금 봉을 포함한 최근 LADDER_LIFE(10)봉 안에, 봉의 범위가 천 단위를 지나간 봉(저가 < 천 단위 ≤ 고가)이 있을 때.
 *   없으면 "1K 조건 대기". 그런 봉이 여럿이면 가장 최근 봉의 천 단위(T)를 쓴다.
 * 칸: 종가가 T 이상이면 위쪽 둘째 칸 2-4 (T+200 ~ T+400), 아래면 아래쪽 둘째 칸 6-8 (T−400 ~ T−200).
 *   천 단위에 바로 붙은 칸(0-2 · 8-1K)은 안 본다.
 * 닿음: 위쪽은 고가 ≥ T+200, 아래쪽은 저가 ≤ T−200.
 *   이 봉이 닿고 앞 봉(같은 T)은 안 닿았으면 "반응 발생", 앞 봉도 닿았으면 "구간 관찰", 안 닿으면 "구간 반응 대기".
 * 켜짐·꺼짐·칸 이름은 확인된 규칙, 반응 발생·구간 관찰·반응 대기를 나누는 법은 추정이에요.
 * → {text, T(지금 보는 천 단위 또는 null), band(칸 아래 끝 숫자 2·6 또는 null)}
 */
export const LADDER_LIFE = 10;
export function ladderAt(bars, k, life = LADDER_LIFE) {
  const crossT = (i) => {
    const b = bars[i];
    const t = Math.ceil(b.l / 1000) * 1000;
    return b.l < t && t <= b.h ? t : null;
  };
  const levelAt = (j) => {
    for (let i = j; i > j - life && i >= 0; i--) {
      const t = crossT(i);
      if (t != null) return t;
    }
    return null;
  };
  const touch = (i, t) => (bars[i].c >= t ? bars[i].h >= t + 200 : bars[i].l <= t - 200);
  const T = levelAt(k);
  if (T == null) return { text: "1K 조건 대기", T: null, band: null };
  if (!touch(k, T)) return { text: "구간 반응 대기", T, band: null };
  const band = bars[k].c >= T ? 2 : 6;
  const before = k > 0 && levelAt(k - 1) === T && touch(k - 1, T);
  return { text: `${band}-${band + 2} ${before ? "구간 관찰" : "반응 발생"}`, T, band };
}

/**
 * 3번 줄 프랙탈 흐름 (0.30.2): 끝난 봉 k까지 차례로 상태를 따라간다.
 *   "조건 대기" → 뚜렷한 움직임 뒤 쉼이면 "상승 후 횡보"·"하락 후 횡보"
 *     쉼 = 최근 rest(6)봉 종가의 폭 ≤ restAtr(0.6) × ATR, 움직임 = 그 6봉 바로 앞 move(10)봉 동안 종가가 moveAtr(2) × ATR 넘게 움직임
 *   쉬는 동안 종가가 쉼 6봉의 고가~저가를 움직임 반대쪽으로 넘으면 "반대 이탈 · 재검토"를 hold(6)봉,
 *   같은 쪽으로 넘으면 "상승 재개 후보"·"하락 재개 후보"를 6봉, 그 뒤 "조건 대기".
 * 반대 이탈이 6봉 이어지는 것은 확인된 규칙, 쉼을 찾는 숫자와 재개 글자는 추정이에요.
 * atr = C.atr(bars, 14) 배열
 */
export const FRACTAL = { move: 10, moveAtr: 2, rest: 6, restAtr: 0.6, hold: 6 };
export function fractalAt(bars, atr, k, look = 300, o = FRACTAL) {
  let st = "wait"; // wait · rest · opp · resume
  let dir = 0;
  let n = 0;
  let rh = 0;
  let rl = 0;
  for (let i = Math.max(o.move + o.rest, k - look); i <= k; i++) {
    const c = bars[i].c;
    if (st === "opp" || st === "resume") {
      n++;
      if (n >= o.hold) st = "wait";
    } else if (st === "rest") {
      if (dir < 0 ? c > rh : c < rl) {
        st = "opp";
        n = 0;
      } else if (dir < 0 ? c < rl : c > rh) {
        st = "resume";
        n = 0;
      }
    }
    if (st !== "wait" || !(atr[i] > 0)) continue;
    let hc = -Infinity;
    let lc = Infinity;
    for (let j = i - o.rest + 1; j <= i; j++) {
      hc = Math.max(hc, bars[j].c);
      lc = Math.min(lc, bars[j].c);
    }
    if (hc - lc > o.restAtr * atr[i]) continue;
    const mv = bars[i - o.rest].c - bars[i - o.rest - o.move].c;
    if (Math.abs(mv) < o.moveAtr * atr[i]) continue;
    st = "rest";
    dir = Math.sign(mv);
    rh = -Infinity;
    rl = Infinity;
    for (let j = i - o.rest + 1; j <= i; j++) {
      rh = Math.max(rh, bars[j].h);
      rl = Math.min(rl, bars[j].l);
    }
  }
  const word = dir > 0 ? "상승" : "하락";
  if (st === "rest") return { text: `${word} 후 횡보`, state: st };
  if (st === "opp") return { text: "반대 이탈 · 재검토", state: st };
  if (st === "resume") return { text: `${word} 재개 후보`, state: st };
  return { text: "조건 대기", state: st };
}

/**
 * 7번 줄 관찰 기준: 1시간봉·4시간봉 구름 위치가 같은 방향(둘 다 위 또는 둘 다 아래)이면 "큰 방향 숏 일치"처럼.
 * 지금 차트 봉의 방향은 보지 않는다 (0.30.2: 지금 봉이 롱 우세여도 1H·4H가 숏이면 "큰 방향 숏 일치").
 * 둘 중 하나라도 구름 안이거나 서로 다르면 미일치, 큰 시간봉을 못 보면 데이터 대기
 */
export function alignText(h1, h4) {
  if (h1 == null || h4 == null) return "큰 방향 데이터 대기";
  if (h1 !== "inside" && h1 === h4) return `큰 방향 ${POS_KO[h1]} 일치`;
  return "큰 방향 미일치";
}

/**
 * 8·9번 줄 매물영역 (0.30.2) — 가격이 모여 움직인 구간을 매물영역 봉(3분 차트는 15분봉)으로 잇달아 나눈다:
 *   앞 seed(5)봉의 고가~저가로 상자를 잡고, 다음 봉의 고가·저가가 둘 다 그 안이면 상자를 늘린다.
 *   한 봉이라도 밖으로 나가면 그 상자는 끝, 나간 봉 다음 봉부터 새 상자 (나간 봉은 어느 상자에도 안 들어감).
 *   나간 봉이 끝난 상자만 낸다 (상자는 나중에야 알 수 있다). 앞 봉부터 차례로 세므로 n봉까지 자른 결과와 앞부분이 같다.
 * → [{s, e, lo, hi}] (s~e = 상자 봉 번호)
 */
export const ZONE = { seed: 5, min: 6, look: 200, exit: 11, cap: 4 };
export function zoneBoxes(bars, o = ZONE) {
  const out = [];
  let s = 0;
  while (s + o.seed < bars.length) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = s; j < s + o.seed; j++) {
      lo = Math.min(lo, bars[j].l);
      hi = Math.max(hi, bars[j].h);
    }
    let e = s + o.seed - 1;
    while (e + 1 < bars.length && bars[e + 1].l >= lo && bars[e + 1].h <= hi) e++;
    if (e + 1 >= bars.length) break; // 아직 안 끝난 상자
    out.push({ s, e, lo, hi });
    s = e + 2;
  }
  return out;
}
/**
 * 끝난 매물영역 봉이 n개일 때 쓰는 상자 (boxes = zoneBoxes(bars), 0.31.0):
 *   살아 있는 상자 = 상자 봉이 min(6)개 이상 (앞 5봉 뒤로 한 봉 이상 안에 머묾) · 상자 첫 봉이 최근 look(200)봉 안 ·
 *     상자가 끝난 뒤 종가가 위로도 아래로도 상자 밖에서 마감한 적이 없음.
 *   count = 살아 있는 상자 수, 많아야 cap(4)개 (8번 줄).
 *   list = 보이는 상자 (9번 줄·차트 상자), 최근 것부터 cap(4)개까지:
 *     상자가 끝난 뒤 봉 전체가 상자 밖에 있는 봉(고가 < 아래 끝 또는 저가 > 위 끝)이 처음 나오고, 그 뒤로 exit(11)봉이 더 끝난 상자.
 *     다른 살아 있는 상자 안에 통째로 들어가는 상자는 뺀다.
 * → {count, list: [{s, e, lo, hi}]}
 */
export function liveZones(boxes, bars, n, o = ZONE) {
  const live = [];
  for (const z of boxes) {
    if (z.e + 1 >= n) break;
    if (z.e - z.s + 1 < o.min || n - z.s > o.look) continue;
    let up = false;
    let dn = false;
    let out = -1; // 봉 전체가 상자 밖에 있는 첫 봉
    for (let j = z.e + 1; j < n && !(up && dn); j++) {
      const b = bars[j];
      if (b.c > z.hi) up = true;
      if (b.c < z.lo) dn = true;
      if (out < 0 && (b.h < z.lo || b.l > z.hi)) out = j;
    }
    if (up && dn) continue;
    live.push({ z, shown: out >= 0 && n - 1 - out >= o.exit });
  }
  const inside = (z) => live.some((w) => w.z !== z && w.z.lo <= z.lo && w.z.hi >= z.hi);
  const list = live
    .filter((w) => w.shown && !inside(w.z))
    .map((w) => w.z)
    .slice(-o.cap);
  return { count: Math.min(live.length, o.cap), list };
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
