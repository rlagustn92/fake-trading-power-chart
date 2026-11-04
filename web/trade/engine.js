// 가상 체결 엔진 (기획서 §6·§12): 화면과 무관한 순수 함수. 진짜 주문은 없다 — 모든 체결은 이 계산뿐.
// 시험: tests/tests.js "모의매매 체결 규칙"
// - 한 봉 안에서 익절·손절이 둘 다 닿으면 순서를 모르므로 손절 먼저 (보수적)
// - 지정가 익절은 닿기만 해서는 안 되고 한 틱 넘게 지나가야 체결
// - 시가가 선을 건너뛰면(갭): 손절·청산·돌파(시장가)는 시가로 (불리하게).
//   익절·지정가 대기선(미리 걸어 둔 지정가)은 장중이면 선 가격 그대로 — 거래가 이어지는 동안엔 가격이 선을 지나는 순간
//   걸어 둔 주문이 먼저 체결되니 선보다 좋은 값은 없다. 거래가 끊겼다 다시 시작된 첫 봉(b.brk: 미국 주식 9:30 장 시작·주말 뒤)만 시가로
//   (0.16.0 사용자 결정 "고쳐줘". 전에는 장중에도 늘 시가라 조금 유리하게 계산됐다)
// - 시장가(진입·손절·청산·직접 종료)는 슬리피지 + 시장가 수수료, 익절(지정가)은 지정가 수수료
// - 레버리지·청산 (DATA_RESEARCH §2-6, Hyperliquid 격리 마진): 증거금 × 배율 = 포지션 크기,
//   유지증거금 = 최대 레버리지 초기증거금의 절반 (최대 20배 → 2.5%). 증거금이 유지증거금까지 줄면 강제 청산
// - 분할 매수(같은 방향으로 더 들어가기) → 평단은 수량 가중 평균. 일부 정리 → 그 몫만큼 손익 확정

/** 기본값 (trade.xyz 수수료를 가정, 확정 아님 — 설정 cfg.trade에서 바꾼다) */
export const DEFAULTS = {
  start_cash: 10000,
  amount: 5000, // 증거금 (내 돈). 포지션 크기 = 증거금 × 레버리지
  size_mode: "amount", // "amount" = 증거금을 직접 / "risk" = 손절 기준 (손절에 닿으면 계좌의 risk_pct%만 잃게)
  risk_pct: 1,
  pend_pct: 0.3, // 대기선을 처음 놓는 곳: 현재가에서 이만큼(%) 떨어진 곳 (롱은 아래, 숏은 위)
  lev: 1,
  max_lev: 20, // 종목 최대 레버리지 (trade.xyz 주식 토큰: 대형주 20배, 대부분 10배) → 유지증거금을 정한다
  tpsl_on: false, // 진입할 때 익절·손절선을 켜 둘지 (사용자 요청: 처음엔 꺼 두고 보다가 오른쪽 클릭으로 켠다)
  tp_pct: 0.5, // 진입하면 처음 놓는 익절 +0.5%, 손절 −0.25% (손익비 2, 1분봉 단타 기준)
  sl_pct: 0.25,
  fee_taker: 0.09, // %
  fee_maker: 0.03, // %
  slip: 0.01, // % 시장가 체결이 불리하게 밀리는 정도
};

/** 설정(%) → 계산용 비율 */
export function rules(t = {}) {
  const v = { ...DEFAULTS, ...t };
  return { taker: v.fee_taker / 100, maker: v.fee_maker / 100, slip: v.slip / 100, tp: v.tp_pct / 100, sl: v.sl_pct / 100, mmr: 1 / (2 * v.max_lev) };
}

export const roundTick = (p, tick) => {
  const d = Math.max(0, Math.round(-Math.log10(tick)));
  return +(Math.round(p / tick) * tick).toFixed(d);
};
const q3 = (x) => Math.round(x * 1000) / 1000; // 수량은 소수 셋째 자리까지

/**
 * 들어가기 → 포지션. price = 지금 가격(마지막 1분봉 종가), margin = 증거금, lev = 레버리지.
 * 시장가는 미끄러짐 + 시장가 수수료. 대기 주문이 체결될 때는 exact(그 가격 그대로) + maker(지정가 수수료)
 * tp·sl을 주면 그 선으로 (대기 주문에서 미리 그어 둔 것), 아니면 처음 선 위치(%)로
 */
export function open({ side, price, margin, lev = 1, t, tick, r, exact = false, maker = false, tp = null, sl = null }) {
  const entry = roundTick(exact ? price : price * (1 + side * r.slip), tick);
  const qty = Math.floor(((margin * lev) / entry) * 1000) / 1000;
  if (!(qty > 0)) return null;
  const p = {
    side,
    qty,
    entry,
    t,
    lev,
    margin: (entry * qty) / lev, // 격리 증거금
    marginIn: (entry * qty) / lev, // 넣은 증거금 합계 (수익률 계산)
    fee: entry * qty * (maker ? r.maker : r.taker), // 아직 손익에 안 넣은 진입 수수료
    adds: 0,
    tp: tp ?? roundTick(entry * (1 + side * r.tp), tick),
    sl: sl ?? roundTick(entry * (1 - side * r.sl), tick),
    hi: entry, // 들고 있는 동안 가장 높이·낮게 간 가격 (거래 뒤 분석 MFE·MAE)
    lo: entry,
  };
  p.liq = liqPrice(p, r);
  return p;
}

/** 분할 매수: 같은 방향으로 더 들어가기 (평단 = 수량 가중 평균, 익절·손절선은 그대로) → 더한 수량 (못 하면 0) */
export function add(p, { price, margin, lev = p.lev, tick, r, exact = false, maker = false }) {
  const fill = roundTick(exact ? price : price * (1 + p.side * r.slip), tick);
  const q = Math.floor(((margin * lev) / fill) * 1000) / 1000;
  if (!(q > 0)) return 0;
  const qty = q3(p.qty + q);
  p.entry = (p.entry * p.qty + fill * q) / qty;
  p.qty = qty;
  p.margin += (fill * q) / lev;
  p.marginIn += (fill * q) / lev;
  p.lev = (p.entry * p.qty) / p.margin; // 실제 배율 (같은 배율로 더하면 그대로)
  p.fee += fill * q * (maker ? r.maker : r.taker);
  p.adds = (p.adds ?? 0) + 1;
  p.liq = liqPrice(p, r);
  return q;
}

/**
 * 청산가 (격리): 포지션 증거금 + 평가 손익 = 유지증거금(가격 × 수량 × mmr)이 되는 가격
 *   P = (평단 − 방향 × 증거금 / 수량) / (1 − 방향 × mmr)   — DATA_RESEARCH §2-6 공식과 같다
 * 롱 1배처럼 0 아래면 청산 없음(null)
 */
export function liqPrice(p, r) {
  if (!p.margin || !p.qty) return null;
  const v = (p.entry - (p.side * p.margin) / p.qty) / (1 - p.side * r.mmr);
  return v > 0 ? v : null;
}

/**
 * 미리 깔아 둔 진입선(대기 주문)의 종류 — 기획서 §4-2 "선 위치로 자동 판별":
 * 롱은 현재가 아래 = 지정가(내려오면 사기), 위 = 돌파(올라가면 사기). 숏은 반대
 */
export const pendingType = (side, price, cur) => ((side > 0) === (price < cur) ? "limit" : "stop");

/**
 * 대기 주문이 이 봉에서 체결되나 → {price, maker} | null.  b.brk = 거래가 끊겼다 다시 시작된 첫 봉
 * - 지정가: 한 틱 넘게 지나가야 (익절과 같은 규칙). 시가가 건너뛰면 장중엔 그 지정가, 장 시작 첫 봉(b.brk)만 시가 (더 좋은 값). 지정가 수수료
 * - 돌파(스톱): 닿으면 시장가 → 미끄러짐 + 시장가 수수료, 시가가 건너뛰면 시가로
 */
export function fillPending(o, b, r) {
  const long = o.side > 0;
  if (o.type === "limit") {
    if (long ? b.o < o.price : b.o > o.price) return { price: b.brk ? b.o : o.price, maker: true };
    if (long ? b.l < o.price : b.h > o.price) return { price: o.price, maker: true };
    return null;
  }
  const slip = (p) => p * (1 + o.side * r.slip);
  if (long ? b.o >= o.price : b.o <= o.price) return { price: slip(b.o), maker: false };
  if (long ? b.h >= o.price : b.l <= o.price) return { price: slip(o.price), maker: false };
  return null;
}

/**
 * 손절 기준 수량 (기획서 §12 학습 기능 1): 손절에 닿으면 잃는 돈이 risk가 되는 포지션 크기($).
 * dist = 진입가에서 손절까지 거리(비율). 미끄러짐과 들어갈 때·나갈 때 시장가 수수료까지 넣는다
 */
export const sizeForRisk = (risk, dist, r) => (dist > 0 ? risk / (dist + r.slip + 2 * r.taker) : 0);

/**
 * 거래가 끊겼다 다시 시작된 첫 봉인가 (0.16.0 갭 체결) → b.brk로 넘긴다.
 * 바로 앞 봉(sec초짜리)이 끝난 뒤 30분 넘게 비었거나(미국 주식 9:30 장 시작·주말·데이터 빈 곳),
 * 장이 쉬는 종목(perp=false: 주식 등)의 일·주봉(밤사이 쉼). 앞 봉을 모르면 끊긴 것으로 (예전처럼 시가)
 */
export const BREAK_SEC = 30 * 60;
export const isBreak = (prev, b, sec, perp) => !prev || b.t - (prev.t + sec) > BREAK_SEC || (sec >= 86400 && !perp);

/** 이 봉에서 익절·손절·청산이 걸리는지 → {price, why} | null. bar = {o,h,l,c, brk(거래가 끊겼다 다시 시작된 첫 봉)} */
export function exitOnBar(p, b, r) {
  const long = p.side > 0;
  const stop = (price) => price * (1 - p.side * r.slip); // 손절·청산은 시장가 → 불리하게 밀린다
  // 불리한 쪽 선: 손절과 청산가 중 먼저 닿는 것 (롱은 높은 쪽, 숏은 낮은 쪽)
  let bad = p.sl;
  let badWhy = "sl";
  if (p.liq != null && (bad == null || (long ? p.liq > bad : p.liq < bad))) {
    bad = p.liq;
    badWhy = "liq";
  }
  if (bad != null && (long ? b.o <= bad : b.o >= bad)) return { price: stop(b.o), why: badWhy };
  if (p.tp != null && (long ? b.o > p.tp : b.o < p.tp)) return { price: b.brk ? b.o : p.tp, why: "tp" }; // 장중 갭은 익절가 그대로, 장 시작 첫 봉만 시가
  if (bad != null && (long ? b.l <= bad : b.h >= bad)) return { price: stop(bad), why: badWhy };
  if (p.tp != null && (long ? b.h > p.tp : b.l < p.tp)) return { price: p.tp, why: "tp" };
  return null;
}

/** 들고 있는 동안 최고·최저 기록 */
export function track(p, b) {
  if (b.h > p.hi) p.hi = b.h;
  if (b.l < p.lo) p.lo = b.l;
}

const exitFee = (price, qty, why, r) => price * qty * (why === "tp" ? r.maker : r.taker);

/** 이 가격에 다 나가면 손에 쥐는 돈 (들어올 때·나갈 때 수수료 뺀 값, 앞서 일부 정리한 것은 빼고) */
export function netAt(p, price, why, r) {
  return p.side * (price - p.entry) * p.qty - p.fee - exitFee(price, p.qty, why, r);
}

/** 지금 가격으로 직접 종료할 때의 체결 가격 (시장가 → 슬리피지) */
export const marketExit = (p, price, r) => price * (1 - p.side * r.slip);

/**
 * 일부(또는 전부) 정리: 수량 q를 price에 → 그 몫의 손익(수수료 뺀 돈)을 돌려주고 포지션을 줄인다.
 * 진입 수수료·증거금도 그 몫만큼 같이 줄어든다. 다 정리하면 p.qty = 0
 */
export function reduce(p, q, price, why, r) {
  q = Math.min(q3(q), p.qty);
  if (!(q > 0)) return 0;
  const f = q / p.qty;
  const entryFee = p.fee * f;
  const fee = exitFee(price, q, why, r);
  const net = p.side * (price - p.entry) * q - entryFee - fee;
  p.fee -= entryFee;
  p.margin -= p.margin * f;
  p.qty = q3(p.qty - q);
  p.realized = (p.realized ?? 0) + net;
  p.fees = (p.fees ?? 0) + entryFee + fee;
  p.closedQty = (p.closedQty ?? 0) + q;
  p.exitValue = (p.exitValue ?? 0) + price * q;
  p.parts = (p.parts ?? 0) + 1;
  if (price > p.hi) p.hi = price;
  if (price < p.lo) p.lo = price;
  return net;
}

/** 다 정리한 포지션 → 거래 기록 한 줄 (일부 정리·분할 매수를 모두 합친 한 번의 매매) */
export function record(p, { why, t, sym }) {
  const pct = (x) => ((p.side * (x - p.entry)) / p.entry) * 100;
  const qty = p.closedQty ?? 0;
  const net = p.realized ?? 0;
  return {
    sym,
    side: p.side,
    qty: q3(qty), // 일부 정리 수량을 더하면 0.10200000000000001처럼 찌꺼기가 남는다 (0.16.0) → 수량 단위(0.001)로
    entry: p.entry,
    exit: qty ? p.exitValue / qty : p.entry, // 나간 가격 평균
    t0: p.t,
    t1: t,
    why,
    fees: p.fees ?? 0,
    net,
    pct: (net / (p.entry * qty)) * 100, // 포지션 크기 대비 % (수수료 뺀 것)
    roe: p.marginIn ? (net / p.marginIn) * 100 : null, // 넣은 증거금 대비 % (레버리지 수익률)
    lev: p.lev,
    adds: p.adds ?? 0,
    parts: p.parts ?? 1,
    mfe: pct(p.side > 0 ? p.hi : p.lo), // 가장 유리했을 때 %
    mae: pct(p.side > 0 ? p.lo : p.hi), // 가장 불리했을 때 %
    rr: rrOf(p),
  };
}

/** 남은 것 전부 나가기 → 거래 기록 (마지막 몫의 손익은 rec.last) */
export function close(p, { price, why, t, sym, r }) {
  const last = reduce(p, p.qty, price, why, r);
  return { ...record(p, { why, t, sym }), last };
}

/** 손익비 = 익절까지 거리 ÷ 손절까지 거리 */
export function rrOf(p) {
  if (p.tp == null || p.sl == null) return null;
  const risk = Math.abs(p.entry - p.sl);
  return risk ? Math.abs(p.tp - p.entry) / risk : null;
}

/**
 * 익절·손절 가격 바꾸기 (끌기·숫자 입력). 현재가를 넘어가면 바로 체결되므로 현재가 한 틱 앞에서 멈춘다.
 * 롱 익절·숏 손절은 현재가 위, 롱 손절·숏 익절은 현재가 아래.
 */
export function clampLevel(key, raw, p, cur, tick) {
  if (!Number.isFinite(raw)) return p[key];
  const above = (key === "tp") === p.side > 0;
  const v = roundTick(raw, tick);
  return above ? Math.max(v, roundTick(cur + tick, tick)) : Math.min(v, roundTick(cur - tick, tick));
}

/** 통계: 거래 수, 승률, 합계, 평균 이익·손실, 손익비(평균), 최대 낙폭(누적 손익 기준) */
export function stats(trades) {
  const n = trades.length;
  const wins = trades.filter((x) => x.net > 0);
  const losses = trades.filter((x) => x.net <= 0);
  const sum = (a) => a.reduce((s, x) => s + x.net, 0);
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const x of [...trades].sort((a, b) => a.t1 - b.t1)) {
    eq += x.net;
    peak = Math.max(peak, eq);
    dd = Math.min(dd, eq - peak);
  }
  const avgWin = wins.length ? sum(wins) / wins.length : 0;
  const avgLoss = losses.length ? sum(losses) / losses.length : 0;
  return { n, wins: wins.length, winRate: n ? wins.length / n : 0, net: sum(trades), avgWin, avgLoss, payoff: avgLoss ? avgWin / -avgLoss : null, maxDD: dd };
}
