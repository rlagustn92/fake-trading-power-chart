// 적립식 백테스트 계산 (SPEC §4) — 화면과 분리된 순수 함수
// - 매수가 = 매수일 종가(수정주가). 수수료·세금·환전 수수료 없음
// - 수정주가로 계산 → 분할·병합을 따로 처리할 필요 없음 (화면에는 그 당시 실제 가격·수량도 같이)
// - 배당: 배당락일에 받은 것으로 본다. 배당금 = 전날까지 가진 수량 × 1주당 배당(분할 반영)
//   같은 날 배당락과 매수가 겹치면 배당 먼저, 매수 나중
// - 원화: 그날 원달러 종가, 없으면 그 전 가장 가까운 날 (미래 값을 쓰지 않는다)
import { DAY, ymd } from "../core/tz.js";
import { splitFactorAt } from "../core/bars.js";

/** "2010-03" → {y, m} */
export const parseYm = (s) => {
  const [y, m] = String(s).split("-").map(Number);
  return { y, m };
};
export const ymOf = (t) => ymd(t).slice(0, 7);
const monthStart = (y, m) => Date.UTC(y, m - 1, 1) / 1000;
const nextYm = ({ y, m }) => (m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 });
const ymKey = ({ y, m }) => y * 12 + m;

/** 상장 후 첫 온전한 달 (상장한 달의 다음 달) */
export function firstFullMonth(bars) {
  if (!bars.length) return null;
  const d = new Date(bars[0].t * 1000);
  return nextYm({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 });
}

/** 환율 찾기: 그날 종가, 없으면 그 전 가장 가까운 날 → {rate, gap(일)} */
export function fxLookup(fxBars) {
  const T = fxBars.map((b) => b.t);
  return (day) => {
    let lo = 0;
    let hi = T.length - 1;
    if (!T.length || day < T[0]) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (T[mid] <= day) lo = mid;
      else hi = mid - 1;
    }
    return { rate: fxBars[lo].c, gap: Math.round((day - T[lo]) / DAY) };
  };
}

/** 매수일 고르기: 그 달 거래일 중 첫날 / N일 이후 첫 거래일(없으면 마지막 거래일) / 마지막 날 */
function pickDay(days, rule, n) {
  if (!days.length) return null;
  if (rule === "last") return days[days.length - 1];
  if (rule === "n") {
    const want = Math.max(1, Math.min(31, n | 0));
    return days.find((t) => new Date(t * 1000).getUTCDate() >= want) ?? days[days.length - 1];
  }
  return days[0];
}

/**
 * @param s  {bars:[{t,c}] 수정주가 일봉, events:[{kind,t,a,b}] 원본 이벤트, splits:[{t,r}]}
 * @param o  {start:{y,m}, end:{y,m}, monthly, initial, buyDay:"first"|"n"|"last", buyDayN,
 *            dividends:"accumulate"|"reinvest", fractional, ccy:"USD"|"KRW", native:"USD"|"KRW", fx: fxLookup|null, lump}
 */
export function runDca(s, o) {
  const bars = s.bars;
  const splits = s.splits ?? [];
  const F = (day) => splitFactorAt(splits, day); // 그날 실제 가격 = 수정주가 × F
  // 배당: 1주당 (분할 반영 = 실제 금액 ÷ 그날 이후 분할)
  const divByDay = new Map();
  for (const e of s.events ?? []) if (e.kind === "div" && e.a > 0) divByDay.set(e.t, { raw: e.a, adj: e.a / F(e.t) });
  const splitByDay = new Map(splits.map((x) => [x.t, x.r]));

  const fxOn = o.ccy !== o.native;
  let fxMiss = 0;
  let fxMaxGap = 0;
  const fx = (day) => {
    if (!fxOn) return 1;
    const r = o.fx?.(day);
    if (!r) return null;
    if (r.gap > 0) {
      fxMiss++;
      if (r.gap > fxMaxGap) fxMaxGap = r.gap;
    }
    return r.rate;
  };
  // 통화 바꾸기 (원화 ↔ 달러)
  const toNative = (amt, rate) => (!fxOn ? amt : o.ccy === "KRW" ? amt / rate : amt * rate);
  const toCcy = (amt, rate) => (!fxOn ? amt : o.ccy === "KRW" ? amt * rate : amt / rate);
  // 비용 (0이면 빼지 않음): 살 때 수수료, 배당세, 환전 수수료(살 돈을 바꿀 때만)
  const fee = Math.max(0, o.fee ?? 0);
  const divTax = Math.max(0, o.divTax ?? 0);
  const fxFee = fxOn ? Math.max(0, o.fxFee ?? 0) : 0;
  let feeCcy = 0;
  let taxCcy = 0;
  let fxCcy = 0;

  // 매수일: 한 번에 넣기(onceAt)면 그날(쉬는 날이면 다음 거래일) 하루,
  //         매주(freq "weekly")면 그 주의 고른 요일(쉬면 그 주 다음 거래일, 없으면 그 주 마지막 거래일),
  //         요일마다(freq "days")면 고른 요일의 모든 거래일 (월~금 모두 = 매 영업일), 아니면 달마다
  const buyDays = new Set();
  const wdOf = (t) => new Date(t * 1000).getUTCDay(); // 일봉 t는 현지 날짜의 UTC 자정 → 현지 요일
  if (o.onceAt != null) {
    const b = bars.find((x) => x.t >= o.onceAt);
    if (b) buyDays.add(b.t);
  } else if (o.freq === "weekly" || o.freq === "days") {
    const a = monthStart(o.start.y, o.start.m);
    const b = monthStart(nextYm(o.end).y, nextYm(o.end).m);
    const inRange = bars.filter((x) => x.t >= a && x.t < b);
    if (o.freq === "days") {
      const set = new Set(o.weekdays?.length ? o.weekdays : [1, 2, 3, 4, 5]);
      for (const x of inRange) if (set.has(wdOf(x.t))) buyDays.add(x.t);
    } else {
      const want = o.weekday ?? 1;
      const weeks = new Map(); // 월요일 시작 주 → 그 주 거래일들
      for (const x of inRange) {
        const w = Math.floor((x.t / DAY + 3) / 7);
        if (!weeks.has(w)) weeks.set(w, []);
        weeks.get(w).push(x.t);
      }
      for (const days of weeks.values()) buyDays.add(days.find((t) => (wdOf(t) || 7) >= want) ?? days[days.length - 1]);
    }
  } else {
    let cur = { ...o.start };
    let i = 0;
    while (ymKey(cur) <= ymKey(o.end)) {
      const a = monthStart(cur.y, cur.m);
      const b = monthStart(nextYm(cur).y, nextYm(cur).m);
      while (i < bars.length && bars[i].t < a) i++;
      const days = [];
      for (let k = i; k < bars.length && bars[k].t < b; k++) days.push(bars[k].t);
      const d = pickDay(days, o.buyDay, o.buyDayN);
      if (d != null) buyDays.add(d);
      cur = nextYm(cur);
    }
  }
  if (!buyDays.size) return null;
  const firstBuy = Math.min(...buyDays);
  const endT = monthStart(nextYm(o.end).y, nextYm(o.end).m);
  const i0 = bars.findIndex((b) => b.t === firstBuy);
  let i1 = i0;
  while (i1 + 1 < bars.length && bars[i1 + 1].t < endT) i1++;

  let shares = 0;
  let cash = 0; // 쌓아 둔 배당 (원래 통화)
  let left = 0; // 정수 주 모드에서 남은 돈 (원래 통화)
  let principal = 0; // 넣은 돈 (고른 통화)
  let spent = 0; // 주식 사는 데 쓴 돈 (원래 통화, 재투자 제외)
  let bought = 0; // 산 수량 (재투자 제외)
  let divNative = 0;
  let divCcy = 0;
  let first = true;
  let lastRate = 1;
  const days = [];
  const buys = [];
  const flows = []; // XIRR 현금흐름 [t, 금액(고른 통화)] — 넣은 돈은 음수
  const divRows = []; // [{t, perShare, amount}]

  // 거치식 비교: 같은 총액을 첫 매수일에 한 번에
  const lump = o.lump ? { shares: 0, cash: 0, left: 0, series: [] } : null;
  let lumpTotal = 0;
  if (lump) {
    for (const t of buyDays) if (t <= bars[i1].t) lumpTotal += o.monthly;
    lumpTotal += o.initial || 0;
  }

  for (let i = i0; i <= i1; i++) {
    const { t, c: P } = bars[i];
    const rate = fx(t);
    if (rate == null) continue; // 환율 기록 이전 (화면에서 막지만 혹시)
    // 1) 배당락일
    const dv = divByDay.get(t);
    if (dv) {
      const gross = shares * dv.adj;
      const amt = gross * (1 - divTax);
      taxCcy += toCcy(gross - amt, rate);
      if (amt > 0) {
        if (o.dividends === "reinvest") {
          shares += amt / (P * (1 + fee));
          feeCcy += toCcy(amt - amt / (1 + fee), rate);
        } else cash += amt;
        divNative += amt;
        divCcy += toCcy(amt, rate);
        divRows.push({ t, perShare: dv.raw, amount: amt, amountCcy: toCcy(amt, rate) });
      }
      if (lump && lump.shares > 0) {
        const la = lump.shares * dv.adj * (1 - divTax);
        if (o.dividends === "reinvest") lump.shares += la / (P * (1 + fee));
        else lump.cash += la;
      }
    }
    // 2) 매수일
    if (buyDays.has(t)) {
      const amtCcy = o.monthly + (first ? o.initial || 0 : 0);
      const native = toNative(amtCcy * (1 - fxFee), rate);
      fxCcy += amtCcy * fxFee;
      const cost = P * (1 + fee); // 1주 사는 데 드는 돈 (수수료 포함, 지금 기준 가격)
      // 1주 단위는 그날 실제 가격으로 센다: 실제 n주 = 지금 기준 n × F주 (예: 그 뒤 2:1 분할 → 100주가 200주)
      const fNow = F(t);
      let q;
      if (o.fractional) {
        q = native / cost;
        spent += native;
      } else {
        const rawQ = Math.floor((native + left) / (cost * fNow));
        q = rawQ * fNow;
        spent += q * cost;
        left = native + left - q * cost;
      }
      feeCcy += toCcy(q * P * fee, rate);
      shares += q;
      bought += q;
      principal += amtCcy;
      flows.push([t, -amtCcy]);
      const f = F(t);
      buys.push({ t, price: P, raw: P * f, shares: q, rawShares: q / f, cum: shares, principal, fx: fxOn ? rate : null, invested: amtCcy });
      if (lump && first) {
        const ln = toNative(lumpTotal * (1 - fxFee), rate);
        if (o.fractional) lump.shares = ln / cost;
        else {
          lump.shares = Math.floor(ln / (cost * fNow)) * fNow;
          lump.left = ln - lump.shares * cost;
        }
      }
      first = false;
    }
    // 3) 평가
    const value = toCcy(shares * P + cash + left, rate);
    lastRate = rate;
    days.push({ t, principal, value });
    if (lump) lump.series.push({ t, value: toCcy(lump.shares * P + lump.cash + lump.left, rate) });
    if (buys.length && buys[buys.length - 1].t === t) buys[buys.length - 1].value = value;
  }
  if (!days.length) return null;

  const last = days[days.length - 1];
  flows.push([last.t, last.value]);

  // 최대 낙폭 (평가금 기준) · 원금 대비 최악
  let peak = 0;
  let peakT = null;
  let mdd = 0;
  let mddPeak = null;
  let mddTrough = null;
  let worst = Infinity;
  let worstT = null;
  for (const d of days) {
    if (d.value > peak) {
      peak = d.value;
      peakT = d.t;
    }
    const dd = peak > 0 ? 1 - d.value / peak : 0;
    if (dd > mdd) {
      mdd = dd;
      mddPeak = peakT;
      mddTrough = d.t;
    }
    if (d.principal > 0) {
      const r = d.value / d.principal - 1;
      if (r < worst) {
        worst = r;
        worstT = d.t;
      }
    }
  }

  // 달마다 표에 넣을 분할·배당 표시
  for (const b of buys) {
    const ym = ymOf(b.t);
    b.notes = [];
    for (const [t, r] of splitByDay) if (ymOf(t) === ym) b.notes.push(r >= 1 ? `${fmtR(r)}:1 분할` : `1:${fmtR(1 / r)} 병합`);
    for (const d of divRows) if (ymOf(d.t) === ym) b.notes.push({ div: d });
  }

  const lumpFlows = lump ? [[days[0].t, -lumpTotal], [last.t, lump.series[lump.series.length - 1].value]] : null;
  return {
    days,
    buys,
    divs: divRows,
    years: yearly(days, flows, divRows),
    lump: lump ? lump.series : null,
    summary: {
      principal,
      value: last.value,
      profit: last.value - principal,
      ret: principal ? last.value / principal - 1 : 0,
      xirr: xirr(flows),
      shares,
      avgCost: bought > 0 ? spent / bought : null,
      div: divCcy,
      divNative,
      cash: toCcy(cash, lastRate),
      mdd,
      mddPeak,
      mddTrough,
      worst: Number.isFinite(worst) ? worst : 0,
      worstT,
      buys: buys.length,
      first: days[0].t,
      last: last.t,
      fxMiss,
      fxMaxGap,
      lumpValue: lump ? lump.series[lump.series.length - 1].value : null,
      lumpPrincipal: lump ? lumpTotal : null,
      lumpXirr: lumpFlows ? xirr(lumpFlows) : null,
      fee: feeCcy,
      tax: taxCcy,
      fxFee: fxCcy,
      // 평가금 나눠 보기 (고른 통화): 내 돈으로 산 주식 + 배당 몫(쌓인 현금 또는 배당으로 산 주식) + 1주 단위 잔돈
      stockValue: toCcy(bought * bars[i1].c, lastRate),
      divValue: toCcy((shares - bought) * bars[i1].c + cash, lastRate),
      divShares: shares - bought,
      leftValue: toCcy(left, lastRate),
      // 기간 안에 있었던 분할·병합 (수량·가격은 이미 지금 기준으로 맞춰져 있다)
      splits: splits.filter((x) => x.t > days[0].t && x.t <= last.t).map((x) => ({ t: x.t, r: x.r })),
    },
  };
}

const fmtR = (r) => (Math.abs(r - Math.round(r)) < 1e-6 ? String(Math.round(r)) : r.toFixed(2));

/** 연도별: 연말 원금·평가금, 그해 배당, 그해 수익률(넣은 돈을 뺀 수익률 = Modified Dietz), 누적 수익률 */
function yearly(days, flows, divRows) {
  const out = [];
  let prev = null; // 지난해 마지막 날
  let k = 0;
  for (let i = 0; i < days.length; i++) {
    const y = new Date(days[i].t * 1000).getUTCFullYear();
    const lastOfYear = i === days.length - 1 || new Date(days[i + 1].t * 1000).getUTCFullYear() !== y;
    if (!lastOfYear) continue;
    const d = days[i];
    const t0 = prev ? prev.t : days[0].t - DAY;
    const V0 = prev ? prev.value : 0;
    let C = 0;
    let W = 0;
    while (k < flows.length - 1 && flows[k][0] <= d.t) {
      const [ft, amt] = flows[k];
      const c = -amt;
      C += c;
      W += c * ((d.t - ft) / (d.t - t0 || 1));
      k++;
    }
    let div = 0;
    for (const r of divRows) if (new Date(r.t * 1000).getUTCFullYear() === y) div += r.amountCcy;
    const denom = V0 + W;
    out.push({ year: y, principal: d.principal, value: d.value, div, ret: denom > 0 ? (d.value - V0 - C) / denom : null, cumRet: d.principal ? d.value / d.principal - 1 : null });
    prev = d;
  }
  return out;
}

/** XIRR (엑셀과 같은 정의, 365일 기준): 뉴턴법 → 안 되면 이분법 */
export function xirr(flows) {
  if (flows.length < 2) return null;
  const t0 = flows[0][0];
  const yrs = flows.map(([t]) => (t - t0) / (365 * DAY));
  const npv = (r) => flows.reduce((s, [, a], i) => s + a / (1 + r) ** yrs[i], 0);
  const dnpv = (r) => flows.reduce((s, [, a], i) => s - (yrs[i] * a) / (1 + r) ** (yrs[i] + 1), 0);
  let r = 0.1;
  for (let k = 0; k < 100; k++) {
    const f = npv(r);
    const d = dnpv(r);
    if (!Number.isFinite(f) || !Number.isFinite(d) || d === 0) break;
    const nr = r - f / d;
    if (!Number.isFinite(nr) || nr <= -0.9999) break;
    if (Math.abs(nr - r) < 1e-10) return nr;
    r = nr;
  }
  // 이분법
  let lo = -0.9999;
  let hi = 10;
  let flo = npv(lo);
  if (!Number.isFinite(flo) || flo * npv(hi) > 0) return null;
  for (let k = 0; k < 300; k++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-9 || hi - lo < 1e-12) return mid;
    if (fm * flo < 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}
