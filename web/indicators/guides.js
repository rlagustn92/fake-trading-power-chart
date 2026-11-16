// 매매 방식 지표 (0.21.0): 여러 공개 강의에서 배운 규칙을 AI 없이 숫자 규칙으로 옮겨, 진입·손절·익절 후보 선과 신호를 그린다.
// 계산은 setups.js (순수 함수), 여기는 그리기. index.js가 그리기 도구를 넘겨준다 (서로 import하지 않게).
// 원칙: ① 주문은 절대 내지 않는다 (선과 표시만) ② 미래 봉을 안 본다 ③ 숫자로 정한 값은 설정에서 바꿀 수 있다
// ④ 한 지표가 켜 둔 봉에 따라 다르게 동작한다 (큰 봉 = 계획, 작은 봉 = 진입 신호) — 지표 설명(explain.js)에 봉별 쓰는 법
import * as C from "./calc.js";
import * as S from "./setups.js";
import { Levels, Bands } from "../ui/primitives.js";
import { upColor, downColor, tpColor, rgba } from "../core/colors.js";

const ENTRY = "#e8eaed"; // 진입선
const STOP = "#ff8a3d"; // 손절선 (한국식·미국식 봉 색과 안 겹치게 주황)
const MUTE = "#8e99a6";
const LIM = 3000; // 신호는 최근 이만큼의 봉에서만 찾는다 (실시간으로 매번 다시 계산해도 가볍게)

const tickOf = (ctx) => 1 / 10 ** (ctx.decimals ?? 2);
const closes = (bars) => bars.map((b) => b.c);
const sgn = (v, d = 2) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`;
const money = (v) => (v == null ? "—" : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));
const qtyText = (q) => (q == null ? "—" : q >= 100 ? Math.round(q).toLocaleString() : q.toLocaleString(undefined, { maximumFractionDigits: 4 }));
const lastOf = (a) => a[a.length - 1];

/** 최근 LIM봉만 잘라 주기: {off, bars, arrs} — 찾은 봉 번호에는 off를 다시 더한다 (shift) */
function win(bars, ...arrs) {
  const off = Math.max(0, bars.length - LIM);
  return { off, bars: off ? bars.slice(off) : bars, arrs: off ? arrs.map((a) => a.slice(off)) : arrs };
}
const shift = (evs, off) =>
  !off
    ? evs
    : evs.map((e) => {
        const o = { ...e };
        for (const k of ["i", "s", "e", "h", "l"]) if (o[k] != null) o[k] += off;
        return o;
      });
/** 뒤집은 봉(숏)에서 찾은 것을 원래 가격으로 */
const unflip = (e) => {
  const o = { ...e, short: true };
  for (const k of ["entry", "stop", "target", "from", "half"]) if (o[k] != null) o[k] = -o[k];
  if (e.hi != null) {
    o.hi = -e.lo;
    o.lo = -e.hi;
  }
  return o;
};

const mark = (ctx, bars, i, long, text, color) => ({ time: ctx.time(bars[i].t), position: long ? "belowBar" : "aboveBar", shape: long ? "arrowUp" : "arrowDown", color: color ?? (long ? upColor() : downColor()), text });

/** 계획 한 벌의 가로선: 진입(흰색) · 손절(주황 점선) · 목표들(익절색 점선). ev = {i, entry, stop, targets:[{label, price}]} */
function planSegs(ctx, ev, to = null) {
  const f = ctx.fmt;
  const d = Math.abs(ev.entry - ev.stop);
  const segs = [
    { from: ev.i, to, price: ev.entry, color: ENTRY, label: `진입 ${f(ev.entry)}` },
    { from: ev.i, to, price: ev.stop, color: STOP, label: `손절 ${f(ev.stop)} (−${((d / Math.abs(ev.entry)) * 100).toFixed(2)}%)`, dash: true },
  ];
  for (const t of ev.targets ?? []) if (t.price != null && Number.isFinite(t.price)) segs.push({ from: ev.i, to, price: t.price, color: tpColor(), label: `${t.label} ${f(t.price)}`, dash: true });
  return segs;
}
/** 최근 count개 신호의 계획선. 맨 끝 신호가 최근 것이면 오른쪽 끝까지, 지난 것은 25봉만 */
function spanPlans(ctx, evs, n, count) {
  const use = count > 0 ? evs.slice(-count) : [];
  const segs = [];
  use.forEach((ev, k) => {
    const next = use[k + 1];
    const to = next ? Math.max(ev.i + 1, Math.min(next.i - 1, ev.i + 25)) : n - 1 - ev.i <= 40 ? null : ev.i + 25;
    segs.push(...planSegs(ctx, ev, to));
  });
  return segs;
}
/** R배 목표 (진입·손절 거리의 배수) */
const rTargets = (ev, list) => {
  const d = ev.entry - ev.stop; // 숏이면 음수 → 목표가 아래로
  return list.map(([k, label]) => ({ label: label ?? `${k}R`, price: ev.entry + k * d }));
};

const linesParam = { key: "lines", label: "계획선 그릴 신호 수", def: 2, min: 0, max: 10, tip: "가장 최근 신호 몇 개까지 진입·손절·익절 선을 그릴지\n0이면 화살표만" };
const shortsParam = { key: "shorts", label: "숏 신호도", def: true, type: "bool" };

const SIX = [
  { n: 7, color: "#ff8a3d" },
  { n: 21, color: "#b18cff" },
  { n: 60, color: "#5ec8d8" },
  { n: 120, color: "#3d8bff" },
  { n: 224, color: "#ff6fae" },
  { n: 365, color: "#e8eaed" },
];
const SIX_KO = { up: "정배열 ▲ 롱만", down: "역배열 ▼ 올라올 때 숏", box: "박스 · 위아래 끝에서만 단타", turn: "전환 중 · 확인하고" };
const stColor = (s) => (s === "up" ? upColor() : s === "down" ? downColor() : "#a0a6ae");
const BASE_KO = { "1h": "1시간", "4h": "4시간", "1D": "일봉" };

export function guideIndicators(T) {
  const { paintLine, paintHist, paintSessionLine, hexA, mapHtf, mapHtfLive, htfOpt, tfMode } = T;
  const liveOpt = (ctx, tf) => {
    const intraday = ctx.tf !== "1D" && ctx.tf !== "1W";
    return { htfKey: ctx.htfKeyOf(tf), dayOnly: (tf === "1D" || tf === "1W") && intraday && ctx.isRegular ? (t) => !ctx.isRegular(t) : null };
  };
  const isDaily = (ctx) => ctx.tf === "1D" || ctx.tf === "1W";

  // ── 권총·ㄴ자·50·200 셋업 (같은 계산, 보여 주는 것만 다르다) ──
  const KIND_KO = { pistol: "권총", lshape: "ㄴ자" };
  function makeSetup(kinds, full) {
    return (ctx, inst) => {
      const p = inst.params;
      const w = inst.width ?? 1;
      const sFast = ctx.addLine(0, { color: full ? "#f5c542" : inst.color, lineWidth: w, lastValueVisible: false, title: "" });
      const sSlow = full ? ctx.addLine(0, { color: "#e8eaed", lineWidth: w + 1 }) : null;
      const sVw = full && p.vwma && ctx.info?.volume ? ctx.addLine(0, { color: "#4cd5a0", lineWidth: 1, lineStyle: 2 }) : null;
      // 강의의 전체 세팅 7·25·100 (기본은 꺼 둠: 선이 많으면 판단이 흐려진다)
      const extra = full && p.allma ? [[7, "#b18cff"], [25, "#ff8a3d"], [100, "#5ec8d8"]].map(([n, color]) => ({ n, s: ctx.addLine(0, { color: hexA(color, 0.7), lineWidth: 1 }) })) : [];
      const hasVol = !!ctx.info?.volume;
      let vw = [];
      const lv = new Levels();
      ctx.attach(lv);
      let m50 = [];
      let m200 = [];
      let evs = [];
      let pend = null;
      let last = [];
      const o = () => ({ tight: p.tight, impK: p.impK });
      return {
        series: [sFast, sSlow, sVw, ...extra.map((x) => x.s)].filter(Boolean),
        prims: [lv],
        render(bars, from) {
          last = bars;
          const cl = closes(bars);
          for (const x of extra) paintLine(x.s, bars, C.sma(cl, x.n), ctx.time, from);
          m50 = C.sma(cl, p.len);
          paintLine(sFast, bars, m50, ctx.time, from);
          if (sSlow) {
            m200 = C.sma(cl, p.slow);
            paintLine(sSlow, bars, m200, ctx.time, from);
          }
          if (sVw) {
            vw = C.vwma(bars, 100);
            paintLine(sVw, bars, vw, ctx.time, from);
          }
          const atr = C.atr(bars, 14);
          const x = win(bars, m50, atr);
          // 거래량 확인: 벗어나는 봉의 거래량이 앞 20봉 평균의 몇 배인지. 기준에 못 미치면 "거래량 약함"(회색, 계획선 없음)
          evs = shift(S.findSetups(x.bars, x.arrs[0], x.arrs[1], o()), x.off)
            .filter((e) => kinds.includes(e.kind))
            .map((e) => {
              const vr = hasVol ? S.volRatio(bars, e.i) : null;
              return { ...e, vr, weak: e.dir === "go" && p.volK > 0 && vr != null && vr < p.volK };
            });
          const pd = S.pendingSetup(x.bars, x.arrs[0], x.arrs[1], o());
          pend = pd && kinds.includes(pd.kind) ? shift([pd], x.off)[0] : null;
          const marks = evs.map((e) => mark(ctx, bars, e.i, e.dir === "go", `${KIND_KO[e.kind]} ${e.dir === "go" ? "▲" : "이탈"}${e.weak ? " 거래량 약함" : e.vr != null && e.dir === "go" ? ` 거래량×${e.vr.toFixed(1)}` : ""}`, e.weak ? MUTE : undefined));
          // 골든크로스·데드크로스 (50선이 200선을 넘는 봉): 사이클이 다시 시작되거나 꺾이는 자리
          if (sSlow) {
            for (let i = Math.max(1, bars.length - LIM); i < bars.length; i++) {
              if (m50[i] == null || m200[i] == null || m50[i - 1] == null || m200[i - 1] == null) continue;
              const up = m50[i] > m200[i] && m50[i - 1] <= m200[i - 1];
              const dn = m50[i] < m200[i] && m50[i - 1] >= m200[i - 1];
              if (up || dn) marks.push({ time: ctx.time(bars[i].t), position: up ? "belowBar" : "aboveBar", shape: "circle", size: 0.6, color: up ? upColor() : downColor(), text: up ? "골크" : "데크" });
            }
          }
          ctx.setMarkers(inst.uid, marks);
          const go = evs.filter((e) => e.dir === "go" && !e.weak).map((e) => ({
            ...e,
            targets:
              e.kind === "lshape"
                ? [{ label: "절반 익절", price: e.half }, sVw && vw[e.i] > e.entry ? { label: "VWMA 100", price: vw[e.i] } : null, sSlow && m200[e.i] > e.entry ? { label: `${p.slow}선`, price: m200[e.i] } : null].filter(Boolean)
                : rTargets(e, [[1], [2], [3]]),
          }));
          const segs = spanPlans(ctx, go, bars.length, p.lines);
          // 신호가 나온 베이스(옆으로 긴 구간)의 위·아래
          for (const e of go.slice(-Math.max(0, p.lines))) segs.push({ from: e.s, to: e.i, price: e.hi, color: MUTE }, { from: e.s, to: e.i, price: e.lo, color: MUTE });
          if (pend) {
            const c = full ? "#f5c542" : inst.color;
            segs.push({ from: pend.s, to: null, price: pend.hi, color: c, dash: true, label: `${KIND_KO[pend.kind]} 대기 · 위로 마감하면 롱` });
            segs.push({ from: pend.s, to: null, price: pend.lo, color: c, dash: true, label: pend.kind === "pistol" ? "아래로 마감하면 추세 변곡" : "아래로 마감하면 하락 지속" });
          }
          lv.setData(segs);
        },
        legend(i) {
          const items = [];
          if (full) {
            const b = last[i];
            const ord = S.s50Order(m50[i], m200[i]);
            const st = b ? S.s50State(b.c, m50[i], m200[i]) : null;
            items.push({ label: `50·200 셋업 ${p.len}/${p.slow}`, value: `${ctx.fmt(m50[i])} / ${ctx.fmt(m200[i])}`, color: "#f5c542" });
            items.push({ label: ord == null ? "배열 —" : `${ord === "up" ? "정배열 ▲" : "역배열 ▼"} · ${st === "up" ? "롱 적극" : st === "down" ? "소극 · 오름 숏" : ord === "up" ? "눌림 중 · 50선 대기" : "반등 중 · 비중 작게"}`, value: "", color: stColor(st ?? "") });
            items.push({ br: true });
          } else items.push({ label: `${kinds.map((k) => KIND_KO[k]).join("·")} (이평 ${p.len})`, value: ctx.fmt(m50[i]), color: inst.color });
          const e = lastOf(evs.filter((x) => x.i <= i));
          if (pend && i >= last.length - 1) items.push({ label: `${KIND_KO[pend.kind]} 만들어지는 중`, value: `${pend.e - pend.s + 1}봉째 옆으로 · ${ctx.fmt(pend.lo)} ~ ${ctx.fmt(pend.hi)}`, color: "#f5c542" });
          else if (e) {
            const rr = e.dir === "go" && e.kind === "lshape" ? S.rrOf(e.entry, e.stop, e.half) : null;
            items.push({ label: `최근: ${KIND_KO[e.kind]} ${e.dir === "go" ? "▲" : "이탈"}${e.weak ? " (거래량 약함)" : ""}`, value: `${i - e.i}봉 전${e.vr != null ? ` · 거래량 ×${e.vr.toFixed(1)}` : ""}${rr != null ? ` · 절반 익절까지 손익비 ${rr.toFixed(1)}${rr < 1 ? " (낮음 → 패스)" : ""}` : ""}`, color: e.dir === "go" && !e.weak ? upColor() : e.dir === "go" ? MUTE : downColor() });
            // 시간 손절: 6봉이 지나도록 1R만큼도 못 갔으면 (4시간봉 롱 뒤 캔들 6개 동안 센 반등이 없으면 정리)
            const b = last[i];
            if (e.dir === "go" && !e.weak && b && i - e.i >= 6 && b.c > e.stop && b.c < e.entry + (e.entry - e.stop)) items.push({ br: true }, { label: `${i - e.i}봉째 반응 없음 → 시간 손절(본전 정리) 고려`, value: "", color: STOP });
          } else items.push({ label: "최근 신호 없음", value: "", color: "#a0a6ae" });
          return items;
        },
      };
    };
  }
  const setupParams = [
    { key: "len", label: "이평 기간", def: 50, min: 5, max: 500, tip: "옆으로 기는 동안 따라와 붙는 이평선이에요 (기본 50)" },
    { key: "tight", label: "횡보 폭 기준", def: 1, min: 0.5, max: 3, step: 0.1, tip: "'옆으로 좁게 긴다'의 기준이에요 (제가 정한 값)\n1 = 기본. 키우면 조금 넓은 횡보도 잡고(신호 많아짐), 줄이면 아주 좁은 것만 잡아요" },
    { key: "impK", label: "직전 움직임 크기", def: 5, min: 2, max: 20, step: 0.5, tip: "횡보 앞의 급등·급락이 평소 한 봉 폭(ATR)의 몇 배 이상이어야 하는지 (제가 정한 값)\n키우면 아주 강한 움직임 뒤만 잡아요" },
    { key: "volK", label: "거래량 확인 배수", def: 1.5, min: 0, max: 10, step: 0.1, tip: "벗어나는 봉의 거래량이 앞 20봉 평균의 이 배수 이상이어야 신호로 쳐요 (배수는 제가 정한 값)\n못 미치면 '거래량 약함'(회색)으로만 표시하고 계획선은 안 그려요\n0이면 거래량을 안 봐요. 거래량이 없는 종목은 자동으로 건너뛰어요" },
    linesParam,
  ];

  return {
    // ── 공통 1. 손익 계획선 ──
    rplan: {
      short: "계획선",
      pane: "price",
      noColor: true,
      params: [
        { key: "side", label: "방향", def: "auto", type: "select", options: [["auto", "자동 (20선 위면 롱)"], ["long", "롱"], ["short", "숏"]] },
        { key: "stopMode", label: "손절 자리", def: "swing", type: "select", options: [["swing", "직전 저점·고점"], ["atr", "ATR 배수"], ["bar", "앞 봉 저가·고가"]], tip: "직전 저점·고점: 가장 가까운 꼭짓점 바로 너머 (근거가 깨지는 자리)\nATR 배수: 지금 가격에서 평소 한 봉 폭의 몇 배\n앞 봉 저가·고가: 바로 앞 봉 너머 (아주 짧은 손절)" },
        { key: "swingN", label: "꼭짓점 양옆 봉", def: 3, min: 1, max: 20, tip: "양옆으로 이만큼의 봉보다 낮아야(높아야) 저점(고점)으로 쳐요. 키우면 더 큰 저점을 잡아요" },
        { key: "atrMult", label: "ATR 배수", def: 1.5, min: 0.1, max: 10, step: 0.1 },
        { key: "risk", label: "잃어도 되는 돈", def: 100, min: 1, max: 10000000, step: 10, tip: "손절에 닿았을 때 잃을 돈 (이 종목의 통화 그대로)\n수량 = 이 돈 ÷ 손절까지 거리. 수수료·미끄러짐은 넣지 않은 값이에요" },
        { key: "r3", label: "3R까지", def: true, type: "bool" },
      ],
      color: "#e8eaed",
      make(ctx, inst) {
        const p = inst.params;
        const lv = new Levels();
        ctx.attach(lv);
        let pl = null;
        return {
          series: [],
          prims: [lv],
          render(bars) {
            pl = null;
            const n = bars.length;
            if (n < 30) return lv.setData([]);
            const tick = tickOf(ctx);
            const entry = bars[n - 1].c;
            let side = p.side;
            if (side === "auto") side = entry >= (lastOf(C.sma(closes(bars.slice(-40)), 20)) ?? entry) ? "long" : "short";
            const long = side === "long";
            let stop = null;
            let from = Math.max(0, n - 12);
            if (p.stopMode === "atr") {
              const a = lastOf(C.atr(bars.slice(-200), 14));
              if (a > 0) stop = long ? entry - p.atrMult * a : entry + p.atrMult * a;
            } else if (p.stopMode === "bar") {
              stop = long ? bars[n - 2].l - tick : bars[n - 2].h + tick;
              from = n - 2;
            } else {
              const off = Math.max(0, n - 400);
              const sw = S.swingPoints(bars.slice(off), Math.max(1, Math.round(p.swingN)));
              for (let k = sw.length - 1; k >= 0; k--) {
                const x = sw[k];
                if (long ? x.kind === "L" && x.p < entry : x.kind === "H" && x.p > entry) {
                  stop = long ? x.p - tick : x.p + tick;
                  from = x.i + off;
                  break;
                }
              }
            }
            pl = stop == null ? null : S.tradePlan(side, entry, stop, p.risk, p.r3 ? [1, 2, 3] : [1, 2]);
            lv.setData(pl ? planSegs(ctx, { i: from, entry, stop, targets: pl.targets.map((t) => ({ label: `${t.k}R`, price: t.price })) }) : []);
          },
          legend: () =>
            pl
              ? [
                  { label: `${pl.side === "long" ? "▲ 롱" : "▼ 숏"} 계획`, value: `진입 ${ctx.fmt(pl.entry)} · 손절 ${ctx.fmt(pl.stop)} (−${pl.distPct.toFixed(2)}%)`, color: pl.side === "long" ? upColor() : downColor() },
                  { label: "수량", value: `${qtyText(pl.qty)} (약 ${money(pl.notional)}) · 손절 시 −${money(p.risk)}`, color: ENTRY },
                ]
              : [{ label: "계획선", value: "손절 자리를 못 찾았어요 (꼭짓점 봉 수를 줄이거나 ATR 방식으로)", color: "#a0a6ae" }],
        };
      },
    },

    // ── 공통 2. 국면 신호등 (보조 창) ──
    regime: {
      short: "신호등",
      pane: "sub",
      params: [{ key: "tf", label: "기준 봉", def: "", type: "tf" }],
      color: "#f5c542",
      make(ctx, inst) {
        const p = inst.params;
        const pane = ctx.newPane();
        const hs = ctx.addHist(pane, { priceFormat: { type: "price", precision: 0, minMove: 1 } });
        hs.createPriceLine({ price: 3, color: hexA(upColor(), 0.5), lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        hs.createPriceLine({ price: -3, color: hexA(downColor(), 0.6), lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        const NAMES = [["six", "6선"], ["s50", "50·200"], ["e20", "20선"], ["stage", "4단계"], ["ai", "봉 읽기"]];
        const code = (s) => (s === "up" ? 1 : s === "down" ? -1 : 0);
        const compute = (src) => {
          const cl = closes(src);
          const atr = C.atr(src, 14);
          const m = Object.fromEntries([7, 21, 60, 50, 200, 20].map((n) => [n, C.sma(cl, n)]));
          const ai = S.alwaysIn(src, C.ema(cl, 20));
          const r = { six: [], s50: [], e20: [], stage: [], ai, sum: [] };
          for (let i = 0; i < src.length; i++) {
            r.six[i] = code(S.sixState(m[7][i], m[21][i], m[60][i], atr[i]));
            r.s50[i] = code(S.s50State(cl[i], m[50][i], m[200][i]));
            r.e20[i] = code(S.e20State(cl[i], m[20][i], m[20][i - 5], atr[i]));
            const stg = S.stageOf(cl[i], m[50][i], m[50][i - 5], m[200][i]);
            r.stage[i] = stg === 2 ? 1 : stg === 4 ? -1 : 0;
            r.sum[i] = m[60][i] == null ? null : r.six[i] + r.s50[i] + r.e20[i] + r.stage[i] + r.ai[i];
          }
          return r;
        };
        let r = null;
        return {
          series: [hs],
          render(bars, from) {
            const mode = tfMode(p.tf, ctx.tf);
            if (mode === "lower") r = null;
            else if (mode === "htf") {
              const htf = ctx.htf(p.tf);
              const h = htf ? compute(htf) : null;
              r = h ? Object.fromEntries(Object.entries(h).map(([k, v]) => [k, mapHtf(bars, htf, v, htfOpt(ctx, p.tf))])) : null;
            } else r = compute(bars);
            const sum = r?.sum ?? [];
            paintHist(hs, bars, sum, ctx.time, from, (i) => (sum[i] > 0 ? rgba(upColor(), sum[i] >= 3 ? 0.85 : 0.4) : sum[i] < 0 ? rgba(downColor(), sum[i] <= -3 ? 0.9 : 0.45) : "rgba(160,166,174,0.4)"));
          },
          legend(i) {
            const tag = tfMode(p.tf, ctx.tf) === "htf" ? ` (${ctx.tfName(p.tf)})` : "";
            if (!r || r.sum[i] == null) return [{ label: `국면 신호등${tag}`, value: tfMode(p.tf, ctx.tf) === "lower" ? "이 봉에선 숨김" : "—", color: inst.color }];
            const items = [{ label: `국면 신호등${tag}`, value: "", color: inst.color }];
            let up = 0;
            let dn = 0;
            for (const [k, name] of NAMES) {
              const v = r[k][i] ?? 0;
              if (v > 0) up++;
              if (v < 0) dn++;
              items.push({ label: `${name} ${v > 0 ? "▲" : v < 0 ? "▼" : "–"}`, value: "", color: v > 0 ? upColor() : v < 0 ? downColor() : "#a0a6ae" });
            }
            items.push({ label: up >= 4 ? `→ 롱 쪽 ${up}/5` : dn >= 4 ? `→ 숏 쪽 ${dn}/5` : `→ 엇갈림 (롱 ${up} · 숏 ${dn}) 쉬는 쪽`, value: "", color: up >= 4 ? upColor() : dn >= 4 ? downColor() : "#a0a6ae" });
            return items;
          },
        };
      },
    },

    // ── 6선 자리 ──
    sixma: {
      short: "6선",
      pane: "price",
      noColor: true,
      params: [
        { key: "base", label: "계획 봉", def: "4h", type: "select", options: [["", "차트 봉 그대로"], ["1h", "1시간봉"], ["4h", "4시간봉"], ["1D", "일봉"]], tip: "자리를 정하는 큰 봉이에요 (기본 4시간봉)\n차트가 이 봉이거나 더 크면: 6선과 자리(지지·저항)를 그려요\n차트가 더 작으면(예: 5분봉): 이 봉의 선을 자리로 깔고, 작은 봉의 7·21선으로 진입 신호를 찾아요" },
        { key: "gap", label: "7선 이격 %", def: 0.6, min: 0.1, max: 5, step: 0.1, tip: "작은 봉에서 7선과 이만큼 벌어지며 꽂혀야 '힘이 실렸다'고 봐요\n비트코인 기준 0.6~1.2%. 덜 움직이는 종목은 줄이세요" },
        { key: "near", label: "자리 근처 %", def: 0.3, min: 0.05, max: 3, step: 0.05, tip: "가격이 자리(큰 봉 이평선)에서 이 % 안에 들어와야 신호를 찾아요" },
        { key: "marks", label: "첫 닿음 표시", def: true, type: "bool", tip: "한동안(20봉) 안 닿았던 이평선에 처음 닿은 봉을 표시해요\n'(약)' = 캔들이 간 게 아니라 이평선이 다가와 닿은 것" },
        { key: "zones", label: "매물대(자동·참고)", def: true, type: "bool", tip: "여러 봉이 같은 값에서 막히던 좁은 구간을 몸통 큰 봉이 뚫은 자리 = 손바뀜 자리(저항 → 지지, 지지 → 저항)\n아직 다시 안 닿은 것만 주황 선으로 그려요 (첫 리테스트가 가장 세다)\n기계가 찾은 근사치예요. 직접 그은 매물대가 더 정확해요" },
        { key: "daily", label: "일봉 이평 겹침 세기", def: true, type: "bool", tip: "지지·저항 자리에 일봉 이평선(21·60·120·224·365)이 같이 있으면 '근거 겹침'으로 세요" },
        { key: "both", label: "큰 방향 반대 신호도", def: false, type: "bool", tip: "끄면(기본): 계획 봉이 정배열이면 롱 신호만, 역배열이면 숏 신호만 보여요" },
        linesParam,
        { key: "tags", label: "눈금에 이름표", def: true, type: "bool" },
        { key: "fit", label: "선 때문에 화면 안 늘림", def: true, type: "bool", tip: "켜면(기본): 멀리 있는 선(224·365) 때문에 캔들이 납작해지지 않아요. 대신 화면 밖 선은 안 보여요" },
      ],
      color: "#b18cff",
      make(ctx, inst) {
        const p = inst.params;
        const w = inst.width ?? 1;
        const trig = tfMode(p.base, ctx.tf) === "htf";
        const noFit = p.fit ? { autoscaleInfoProvider: () => null } : {};
        const lv = new Levels();
        ctx.attach(lv);
        const baseName = BASE_KO[p.base] ?? "";
        const big = SIX.filter((x) => !trig || x.n !== 7).map((x) => ({ ...x, name: trig ? `${baseName} ${x.n}` : `${x.n}`, vals: [], s: ctx.addLine(0, { color: x.color, lineWidth: Math.min(4, w + (trig || x.n >= 120 ? 1 : 0)), lastValueVisible: !!p.tags, title: p.tags ? (trig ? `${baseName} ${x.n}` : `${x.n}`) : "", ...noFit }) }));
        const small = trig ? [7, 21].map((n, k) => ({ n, vals: [], color: hexA(SIX[k].color, 0.75), s: ctx.addLine(0, { color: hexA(SIX[k].color, 0.75), lineWidth: 1 }) })) : [];
        let last = [];
        let atr = [];
        let hst = []; // 작은 봉 모드: 계획 봉의 국면 (봉별)
        let evs = [];
        let info = null; // 지지·저항 요약 (맨 끝 봉)
        let dayLv = [];
        let zoneLv = []; // 아직 안 닿은 매물대 [{name, v}]
        const ZONE = "#ffb020";
        /** 매물대 찾기 (최근 LIM봉) → 봉 번호를 원래대로 */
        const zonesOf = (src) => {
          const x = win(src, C.atr(src, 14));
          return S.findZones(x.bars, x.arrs[0]).map((z) => ({ ...z, i: z.i + x.off, s: z.s + x.off, test: z.test < 0 ? -1 : z.test + x.off }));
        };
        const stateAt = (i) => (trig ? hst[i] ?? null : S.sixState(big[0].vals[i], big[1].vals[i], big[2].vals[i], atr[i]));

        function levelsNow(bars) {
          const n = bars.length;
          const c = bars[n - 1].c;
          const mine = big.filter((L) => L.n !== 7 && L.vals[n - 1] != null).map((L) => ({ name: `${L.name}선`, v: L.vals[n - 1] }));
          const all = [...mine, ...dayLv, ...zoneLv];
          const near = (x) => all.filter((y) => y !== x && Math.abs(y.v / x.v - 1) * 100 <= p.near * 2).map((y) => y.name);
          const below = mine.filter((x) => x.v < c).sort((a, b) => b.v - a.v).slice(0, 2);
          const above = mine.filter((x) => x.v >= c).sort((a, b) => a.v - b.v).slice(0, 2);
          return { c, below: below.map((x) => ({ ...x, with: near(x) })), above: above.map((x) => ({ ...x, with: near(x) })) };
        }

        return {
          series: [...big.map((L) => L.s), ...small.map((L) => L.s)],
          prims: [lv],
          render(bars, from) {
            last = bars;
            const n = bars.length;
            const cl = closes(bars);
            atr = C.atr(bars, 14);
            const marks = [];
            const segs = [];
            evs = [];
            if (!trig) {
              for (const L of big) {
                L.vals = C.sma(cl, L.n);
                paintLine(L.s, bars, L.vals, ctx.time, from);
              }
              if (p.marks) {
                for (const L of big) {
                  if (L.n === 7) continue;
                  for (const t of S.firstTouches(bars, L.vals)) marks.push(mark(ctx, bars, t.i, t.side === "sup", `${L.n} 첫 닿음${t.strong ? "" : " (약)"}`, L.color));
                }
              }
              zoneLv = [];
              if (p.zones) {
                const zs = zonesOf(bars);
                for (const z of zs) if (z.test >= 0) marks.push(mark(ctx, bars, z.test, z.kind === "sup", "매물대 리테", ZONE));
                const c = bars[n - 1].c;
                const open = zs.filter((z) => z.test < 0).sort((a, b) => Math.abs(a.level - c) - Math.abs(b.level - c)).slice(0, 4);
                for (const z of open) {
                  zoneLv.push({ name: "매물대", v: z.level });
                  segs.push({ from: z.s, to: null, price: z.level, color: ZONE, width: 2, label: `매물대(자동) ${z.kind === "sup" ? "지지" : "저항"} ${ctx.fmt(z.level)}` });
                }
              }
            } else {
              const htf = ctx.htf(p.base);
              for (const L of small) {
                L.vals = C.sma(cl, L.n);
                paintLine(L.s, bars, L.vals, ctx.time, from);
              }
              for (const L of big) {
                L.vals = htf ? mapHtfLive(bars, htf, L.n, "sma", liveOpt(ctx, p.base)) : [];
                paintLine(L.s, bars, L.vals, ctx.time, from);
              }
              hst = [];
              if (htf) {
                const hc = closes(htf);
                const [h7, h21, h60] = [7, 21, 60].map((k) => C.sma(hc, k));
                const ha = C.atr(htf, 14);
                const CODE = ["box", "up", "down", "turn"];
                const codes = htf.map((_, k) => {
                  const s = S.sixState(h7[k], h21[k], h60[k], ha[k]);
                  return s == null ? null : CODE.indexOf(s);
                });
                hst = mapHtf(bars, htf, codes, htfOpt(ctx, p.base)).map((x) => (x == null ? null : CODE[x]));
                const lvl = big.map((L) => ({ name: `${L.name}선`, vals: L.vals }));
                // 계획 봉의 매물대도 자리로: 만들어진 계획 봉이 끝난 뒤부터, 처음 다시 닿는 계획 봉이 끝날 때까지 살아 있다
                zoneLv = [];
                if (p.zones) {
                  const key = ctx.htfKeyOf(p.base);
                  const hidx = new Array(n).fill(-1);
                  let j = 0;
                  for (let i = 0; i < n; i++) {
                    const k = key(bars[i].t);
                    while (j + 1 < htf.length && htf[j + 1].t <= k) j++;
                    if (htf[j] && htf[j].t <= k) hidx[i] = j;
                  }
                  for (const z of zonesOf(htf).slice(-16)) {
                    const vals = hidx.map((h) => (h > z.i && (z.test < 0 || h <= z.test) ? z.level : null));
                    if (!vals.some((v) => v != null)) continue;
                    lvl.push({ name: `${baseName} 매물대`, vals });
                    if (vals[n - 1] != null) {
                      zoneLv.push({ name: `${baseName} 매물대`, v: z.level });
                      segs.push({ from: vals.findIndex((v) => v != null), to: null, price: z.level, color: ZONE, width: 2, label: `${baseName} 매물대(자동) ${z.kind === "sup" ? "지지" : "저항"} ${ctx.fmt(z.level)}` });
                    }
                  }
                }
                const o = { gapPct: p.gap, nearPct: p.near, tick: tickOf(ctx) };
                const x = win(bars, small[0].vals, small[1].vals, atr, ...lvl.map((L) => L.vals));
                const lv2 = lvl.map((L, k) => ({ name: L.name, vals: x.arrs[3 + k] }));
                const longs = shift(S.findSixTriggers(x.bars, x.arrs[0], x.arrs[1], x.arrs[2], lv2, o), x.off);
                const shorts = shift(S.findSixTriggers(S.flipBars(x.bars), S.neg(x.arrs[0]), S.neg(x.arrs[1]), x.arrs[2], lv2.map((L) => ({ name: L.name, vals: S.neg(L.vals) })), o), x.off).map(unflip);
                evs = [...longs.filter((e) => p.both || hst[e.i] !== "down"), ...shorts.filter((e) => p.both || hst[e.i] !== "up")].sort((a, b) => a.i - b.i);
                for (const e of evs) marks.push(mark(ctx, bars, e.i, !e.short, `${e.type} ${e.short ? "숏" : "롱"}`));
                segs.push(...spanPlans(ctx, evs.map((e) => ({ ...e, targets: [{ label: e.type === "A" ? "익절 21선" : "익절 쌍고·쌍저", price: e.target }] })), n, p.lines));
              }
            }
            // 일봉 이평 (겹침 세기용): 끝난 일봉 값
            dayLv = [];
            if (p.daily && !isDaily(ctx) && n) {
              const d = ctx.htf("1D");
              if (d) {
                const dc = closes(d);
                for (const k of [21, 60, 120, 224, 365]) {
                  const v = lastOf(mapHtf(bars, d, C.sma(dc, k), htfOpt(ctx, "1D")));
                  if (v != null) dayLv.push({ name: `일봉 ${k}선`, v });
                }
              }
            }
            info = n ? levelsNow(bars) : null;
            if (info && !trig) {
              const down = stateAt(n - 1) === "down";
              const from8 = Math.max(0, n - 8);
              const pc = (v) => sgn((v / info.c - 1) * 100);
              info.below.forEach((x, k) => segs.push({ from: from8, to: null, price: x.v, color: down ? tpColor() : k ? STOP : ENTRY, dash: true, label: `${down ? "지지 (익절 후보)" : k ? "지지 ② 폐기선 (종가 이탈 시)" : "지지 ① 매수 자리"} ${x.name} ${pc(x.v)}` }));
              info.above.forEach((x, k) => segs.push({ from: from8, to: null, price: x.v, color: down ? (k ? STOP : ENTRY) : tpColor(), dash: true, label: `${down ? (k ? "저항 ② 폐기선 (종가 돌파 시)" : "저항 ① 숏 자리") : `저항 ${k ? "②" : "①"} 익절 후보`} ${x.name} ${pc(x.v)}` }));
            }
            lv.setData(segs);
            ctx.setMarkers(inst.uid, marks);
          },
          legend(i) {
            const b = last[i];
            const st = stateAt(i);
            const items = [{ label: trig ? `6선 · ${baseName}봉 자리 + 진입 신호` : "6선 자리", value: "", color: inst.color }];
            if (trig && !hst.length) return [...items, { label: "계획 봉을 읽는 중…", value: "", color: "#a0a6ae" }];
            items.push({ label: st ? `${trig ? `${baseName}봉 ` : ""}${SIX_KO[st]}` : "국면 —", value: "", color: stColor(st) });
            const m7 = trig ? small[0].vals[i] : big[0].vals[i];
            if (b && m7 != null) {
              const g = (b.c / m7 - 1) * 100;
              items.push({ label: "7선 이격", value: sgn(g), color: SIX[0].color });
            }
            if (info && i >= last.length - 1) {
              const txt = (x) => `${x.name} ${ctx.fmt(x.v)}${x.with.length ? ` · 근거 ${x.with.length + 1}개 겹침 (${x.with.join(", ")})` : ""}`;
              if (info.below[0]) items.push({ br: true }, { label: "아래 자리", value: txt(info.below[0]), color: ENTRY });
              if (info.above[0]) items.push({ br: true }, { label: "위 자리", value: txt(info.above[0]), color: tpColor() });
            }
            const e = lastOf(evs.filter((x) => x.i <= i));
            if (e) {
              const rr = S.rrOf(e.entry, e.stop, e.target);
              items.push({ br: true }, { label: `최근: ${e.type} ${e.short ? "숏" : "롱"} (${e.lv})`, value: `${i - e.i}봉 전 · 손익비 ${rr == null ? "—" : rr.toFixed(1)}`, color: e.short ? downColor() : upColor() });
            }
            return items;
          },
        };
      },
    },

    // ── 20·200 눌림 ──
    pull20: {
      short: "20·200",
      pane: "price",
      params: [
        { key: "len", label: "빠른 선", def: 20, min: 5, max: 200 },
        { key: "slow", label: "느린 선", def: 200, min: 20, max: 500 },
        { key: "flatK", label: "평평함 기준", def: 0.25, min: 0.05, max: 2, step: 0.05, tip: "20선이 5봉 동안 움직인 폭이 평소 한 봉 폭(ATR)의 이 배수보다 작으면 '평평'으로 봐요 (제가 정한 값)\n평평하면 추세가 없는 것 → 매매하지 않는 구간" },
        { key: "lo", label: "되돌림 최소 %", def: 40, min: 10, max: 90 },
        { key: "hi", label: "되돌림 최대 %", def: 60, min: 20, max: 100, tip: "직전 상승폭의 40~60%만 되돌린 자리('골든존')에서만 신호를 내요" },
        { key: "reds", label: "연속 음봉(양봉) 수", def: 3, min: 1, max: 6, tip: "눌림 동안 음봉이 이만큼 이어져야 해요 (숏은 양봉)" },
        { key: "minRR", label: "최소 손익비", def: 2, min: 0.5, max: 10, step: 0.5 },
        { key: "gapMin", label: "갭 최소 % (주식 분봉)", def: 1, min: 0, max: 20, step: 0.5, tip: "꼭 있어야 하는 조건 '의미 있는 갭': 그날 시가가 전날 종가보다 이만큼 이상 높게(숏은 낮게) 시작한 날만 신호를 내요\n몇 %가 '의미 있는'지는 강의에 없어서 제가 1%로 정했어요\n정규장이 있는 종목(주식)의 분봉에만 적용돼요. 0이면 갭을 안 봐요" },
        shortsParam,
        { key: "bg", label: "평평한 구간 회색", def: true, type: "bool" },
        linesParam,
      ],
      color: "#3d8bff",
      make(ctx, inst) {
        const p = inst.params;
        const w = inst.width ?? 1;
        const s20 = ctx.addLine(0, { color: inst.color, lineWidth: Math.min(4, w + 1) });
        const s200 = ctx.addLine(0, { color: "#e8eaed", lineWidth: w });
        const lv = new Levels();
        const bg = new Bands();
        ctx.attach(bg);
        ctx.attach(lv);
        let m20 = [];
        let m200 = [];
        let atr = [];
        let evs = [];
        let last = [];
        let gapArr = null; // 봉별 그날 갭 % (정규장이 있는 종목의 분봉만)
        const st = (i) => (last[i] ? S.e20State(last[i].c, m20[i], m20[i - 5], atr[i], p.flatK) : null);
        return {
          series: [s20, s200],
          prims: [bg, lv],
          render(bars, from) {
            last = bars;
            const n = bars.length;
            const cl = closes(bars);
            m20 = C.sma(cl, p.len);
            m200 = C.sma(cl, p.slow);
            atr = C.atr(bars, 14);
            paintLine(s20, bars, m20, ctx.time, from);
            paintLine(s200, bars, m200, ctx.time, from);
            const flats = [];
            if (p.bg) {
              let s = -1;
              for (let i = 0; i <= n; i++) {
                const f = i < n && st(i) === "flat";
                if (f && s < 0) s = i;
                if (!f && s >= 0) {
                  if (i - s >= 3) flats.push({ from: s, to: i - 1, color: "rgba(142,153,166,0.10)" });
                  s = -1;
                }
              }
            }
            bg.setTimeBands(flats);
            const o = { flatK: p.flatK, lo: p.lo / 100, hi: p.hi / 100, reds: p.reds, minRR: p.minRR, tick: tickOf(ctx) };
            const x = win(bars, m20, atr);
            const longs = shift(S.findPullbacks(x.bars, x.arrs[0], x.arrs[1], o), x.off);
            const shorts = p.shorts ? shift(S.findPullbacks(S.flipBars(x.bars), S.neg(x.arrs[0]), x.arrs[1], o), x.off).map(unflip) : [];
            gapArr = null;
            if (p.gapMin > 0 && ctx.info?.rth && !isDaily(ctx)) {
              gapArr = new Array(n).fill(null);
              let key = null;
              let lastClose = null;
              let g = null;
              for (let i = 0; i < n; i++) {
                if (ctx.isRegular(bars[i].t)) {
                  const k = ctx.dayKey(bars[i].t);
                  if (k !== key) {
                    key = k;
                    g = lastClose ? (bars[i].o / lastClose - 1) * 100 : null;
                  }
                  lastClose = bars[i].c;
                }
                gapArr[i] = g;
              }
            }
            const gapOk = (e) => !gapArr || (gapArr[e.i] != null && (e.short ? gapArr[e.i] <= -p.gapMin : gapArr[e.i] >= p.gapMin));
            evs = [...longs, ...shorts].filter(gapOk).sort((a, b) => a.i - b.i);
            ctx.setMarkers(inst.uid, evs.map((e) => (e.ok ? mark(ctx, bars, e.i, !e.short, `눌림 ${e.rr.toFixed(1)}R`) : { ...mark(ctx, bars, e.i, !e.short, `손익비 ${e.rr.toFixed(1)}`, MUTE), shape: "circle", size: 0.5 })));
            lv.setData(spanPlans(ctx, evs.filter((e) => e.ok).map((e) => ({ ...e, targets: [{ label: e.short ? "목표 직전 저점" : "목표 직전 고점", price: e.target }] })), n, p.lines));
          },
          legend(i) {
            const s = st(i);
            const b = last[i];
            const KO = { up: "상승 ▲ 선이 가격 아래 · 위로 기움 → 눌림 매수", down: "하락 ▼ 선이 가격 위 · 아래로 기움 → 반등 매도", flat: "평평 → 매매 금지", mixed: "애매 (선 방향과 가격 위치가 다름) → 기다림" };
            const items = [
              { label: `20·200 눌림 ${p.len}/${p.slow}`, value: `${ctx.fmt(m20[i])} / ${ctx.fmt(m200[i])}`, color: inst.color },
              { label: s ? KO[s] : "—", value: "", color: stColor(s) },
            ];
            if (b && m20[i] != null && atr[i] > 0) {
              const ext = (b.c - m20[i]) / atr[i];
              if (Math.abs(ext) > 3) items.push({ label: `이격 큼 (${ext.toFixed(1)} ATR) → 지금은 진입 금지`, value: "", color: STOP });
              // 스퀴즈: 평평한 느린 선 아래에서, 오르는 빠른 선이 받치며 사이가 좁아짐
              if (m200[i] != null && m200[i - 20] != null && Math.abs(m200[i] - m200[i - 20]) < 0.5 * atr[i] && s !== "flat" && m20[i] > m20[i - 5] && b.c > m20[i] && b.c < m200[i] && m200[i] - m20[i] < 3 * atr[i]) items.push({ label: "스퀴즈 후보 (위 200 · 아래 20 사이가 좁아짐)", value: "", color: "#f5c542" });
            }
            if (gapArr) items.push({ label: gapArr[i] == null ? "갭 —" : `오늘 갭 ${sgn(gapArr[i])}${Math.abs(gapArr[i]) >= p.gapMin ? "" : " (작음 → 신호 없음)"}`, value: "", color: "#a0a6ae" });
            const e = lastOf(evs.filter((x) => x.i <= i && x.ok));
            if (e) items.push({ br: true }, { label: `최근: 눌림 ${e.short ? "숏" : "롱"}`, value: `${i - e.i}봉 전 · 되돌림 ${(e.ret * 100).toFixed(0)}% · 손익비 ${e.rr.toFixed(1)}`, color: e.short ? downColor() : upColor() });
            return items;
          },
        };
      },
    },

    // ── 50·200 셋업 (권총·ㄴ자 포함) / 권총 / ㄴ자 ──
    setup50: {
      short: "50·200",
      pane: "price",
      noColor: true,
      params: [
        setupParams[0],
        { key: "slow", label: "느린 선", def: 200, min: 20, max: 500 },
        { key: "vwma", label: "VWMA 100도", def: true, type: "bool", tip: "거래량 가중 이평 100 (1차 익절 기준으로 쓰는 선). ㄴ자 신호에 'VWMA 100' 익절선이 같이 그려져요. 거래량이 있는 종목만" },
        { key: "allma", label: "7·25·100선도", def: false, type: "bool", tip: "강의의 전체 세팅(7·25·50·100·200)으로 보고 싶을 때. 선이 많으면 판단이 흐려져서 기본은 꺼 둬요" },
        ...setupParams.slice(1),
      ],
      color: "#f5c542",
      make: makeSetup(["pistol", "lshape"], true),
    },
    pistol: { short: "권총", pane: "price", params: setupParams, color: "#ff8a3d", make: makeSetup(["pistol"], false) },
    lshape: { short: "ㄴ자", pane: "price", params: setupParams, color: "#4cd5a0", make: makeSetup(["lshape"], false) },

    // ── VWAP 스윙 ──
    vwapswing: {
      short: "VWAP 스윙",
      pane: "price",
      needsVolume: true,
      params: [
        { key: "ytd", label: "앵커: 연초", def: true, type: "bool", tip: "올해 첫 봉부터의 거래량 가중 평균가 = 올해 산 사람들의 평균 단가\n차트에 올해 첫 봉이 있어야 그려져요" },
        { key: "ahi", label: "앵커: 최근 큰 고점", def: true, type: "bool", tip: "꼭대기 근처에서 산 사람들의 평균 단가 → 반등의 저항이 되기 쉬워요" },
        { key: "alo", label: "앵커: 최근 큰 저점", def: true, type: "bool", tip: "바닥 이후 산 사람들의 평균 단가 → 눌림의 지지가 되기 쉬워요" },
        { key: "look", label: "고점·저점 찾는 봉 수", def: 250, min: 30, max: 2000, step: 10 },
        { key: "vwf", label: "VWAP 위에서만 신호", def: true, type: "bool", tip: "분봉에서: 종가가 그날 VWAP 위일 때만 진입 신호를 내요 (VWAP 아래 반등은 믿지 않는다)" },
        linesParam,
      ],
      color: "#f5c542",
      make(ctx, inst) {
        const p = inst.params;
        const w = inst.width ?? 1;
        const daily = isDaily(ctx);
        const s5 = ctx.addLine(0, { color: inst.color, lineWidth: Math.min(4, w + 1) });
        const sv = daily ? null : ctx.addLine(0, { color: "#ff6fae", lineWidth: 2 });
        const s50 = daily ? ctx.addLine(0, { color: "#5ec8d8", lineWidth: w }) : null;
        const s200 = daily ? ctx.addLine(0, { color: "#e8eaed", lineWidth: w + 1 }) : null;
        const anchors = [p.ytd && { key: "ytd", name: "연초 AVWAP", color: "#b18cff" }, p.ahi && { key: "hi", name: "고점 AVWAP", color: "#3d8bff" }, p.alo && { key: "lo", name: "저점 AVWAP", color: "#4cd5a0" }]
          .filter(Boolean)
          .map((a) => ({ ...a, idx: -2, vals: [], s: ctx.addLine(0, { color: a.color, lineWidth: 1, lineStyle: 2 }) }));
        const lv = new Levels();
        ctx.attach(lv);
        let ma5 = [];
        let n5 = 5;
        let vw = [];
        let stage = [];
        let evs = [];
        let last = [];
        const anchorIdx = (bars, key) => {
          const n = bars.length;
          if (key === "ytd") {
            const y = new Date(bars[n - 1].t * 1000).getUTCFullYear();
            let i = n - 1;
            while (i > 0 && new Date(bars[i - 1].t * 1000).getUTCFullYear() === y) i--;
            return i > 0 ? i : -1; // 차트가 올해 첫 봉까지 안 닿으면 못 그린다
          }
          let best = -1;
          for (let i = Math.max(0, n - Math.round(p.look)); i < n - 3; i++) {
            if (best < 0 || (key === "hi" ? bars[i].h > bars[best].h : bars[i].l < bars[best].l)) best = i;
          }
          return best;
        };
        return {
          series: [s5, sv, s50, s200, ...anchors.map((a) => a.s)].filter(Boolean),
          prims: [lv],
          render(bars, from) {
            last = bars;
            const n = bars.length;
            if (!n) return;
            const cl = closes(bars);
            const atr = C.atr(bars, 14);
            n5 = daily ? 5 : Math.max(5, Math.min(2000, 5 * S.barsPerDay(bars, ctx.dayKey)));
            ma5 = C.sma(cl, n5);
            paintLine(s5, bars, ma5, ctx.time, from);
            if (daily) {
              const m50 = C.sma(cl, 50);
              const m200 = C.sma(cl, 200);
              paintLine(s50, bars, m50, ctx.time, from);
              paintLine(s200, bars, m200, ctx.time, from);
              stage = cl.map((c, i) => S.stageOf(c, m50[i], m50[i - 5], m200[i]));
            } else {
              vw = C.vwap(bars, ctx.dayKey).vwap;
              paintSessionLine(sv, bars, vw, ctx, from);
              const d = ctx.htf("1D");
              if (d) {
                const dc = closes(d);
                const m50 = C.sma(dc, 50);
                const m200 = C.sma(dc, 200);
                stage = mapHtf(bars, d, dc.map((c, i) => S.stageOf(c, m50[i], m50[i - 5], m200[i])), htfOpt(ctx, "1D"));
              } else stage = [];
            }
            for (const a of anchors) {
              const idx = anchorIdx(bars, a.key);
              a.vals = idx >= 0 ? C.anchoredVwap(bars, idx) : [];
              paintLine(a.s, bars, a.vals, ctx.time, idx === a.idx ? from : 0); // 앵커가 옮겨 가면 처음부터 다시 그린다
              a.idx = idx;
            }
            const x = win(bars, ma5, atr);
            evs = shift(S.findFirstHH(x.bars, x.arrs[0], x.arrs[1], { tick: tickOf(ctx) }), x.off).filter((e) => daily || !p.vwf || vw[e.i] == null || bars[e.i].c > vw[e.i]);
            ctx.setMarkers(inst.uid, evs.map((e) => mark(ctx, bars, e.i, true, stage[e.i] === 4 ? "HH (4단계 · 사지 않기)" : "첫 HH", stage[e.i] === 4 ? MUTE : undefined)));
            lv.setData(spanPlans(ctx, evs.filter((e) => stage[e.i] !== 4).map((e) => ({ ...e, targets: rTargets(e, [[1, "1R (1/3 덜기)"], [2, "2R"]]) })), n, p.lines));
          },
          legend(i) {
            const b = last[i];
            const STG = { 1: "1단계 매집 · 계획만", 2: "2단계 상승 · 눌림 뒤 매수", 3: "3단계 분배 · 주의", 4: "4단계 하락 · 사지 않기" };
            const items = [{ label: `VWAP 스윙 · 5일선(${n5})`, value: ctx.fmt(ma5[i]), color: inst.color }];
            if (stage[i]) items.push({ label: `${daily ? "" : "일봉 "}${STG[stage[i]]}`, value: "", color: stage[i] === 2 ? upColor() : stage[i] === 4 ? downColor() : "#a0a6ae" });
            if (b && ma5[i] != null && ma5[i - 5] != null) {
              const falling = ma5[i] < ma5[i - 5];
              const below = b.c < ma5[i];
              items.push({ label: falling && below ? "하락하는 5일선 아래 → 사지 않기" : below ? "5일선 아래 · 기다림" : falling ? "5일선 위지만 선이 내림 · 주의" : "5일선 위 · 선 오름", value: "", color: falling && below ? downColor() : !below && !falling ? upColor() : "#a0a6ae" });
            }
            if (!daily && b && vw[i] != null) items.push({ br: true }, { label: "VWAP", value: `${ctx.fmt(vw[i])} · ${b.c >= vw[i] ? "위 (오늘 매수자 주도)" : "아래 (오늘 매도자 주도)"}`, color: "#ff6fae" });
            for (const a of anchors) if (a.vals[i] != null) items.push({ br: true }, { label: a.name, value: `${ctx.fmt(a.vals[i])}${b ? ` · 가격이 ${b.c >= a.vals[i] ? "위" : "아래"}` : ""}`, color: a.color });
            return items;
          },
        };
      },
    },

    // ── 봉 읽기 ──
    barread: {
      short: "봉 읽기",
      pane: "price",
      params: [
        { key: "len", label: "EMA 기간", def: 20, min: 5, max: 200 },
        { key: "minBars", label: "추세로 보는 봉 수", def: 10, min: 3, max: 50, tip: "종가가 이평선 한쪽에 이만큼 이어지면 추세로 봐요 (대략적인 기준 10)" },
        { key: "rr", label: "목표 (위험의 몇 배)", def: 2, min: 0.5, max: 10, step: 0.5 },
        { key: "skip", label: "장 시작 후 쉬는 봉", def: 6, min: 0, max: 30, tip: "정규장이 있는 종목(주식)의 분봉에서, 장 시작 후 이만큼의 봉은 신호를 안 내요 (6~12봉 권장)\n24시간 종목(코인)에는 적용되지 않아요" },
        { key: "rangeLen", label: "레인지 길이(봉)", def: 40, min: 10, max: 300, step: 5 },
        { key: "all", label: "취소·경고 신호도 표시", def: false, type: "bool", tip: "켜면: 다음 봉이 진입가를 못 넘어 취소된 신호(흐린 화살표)와 3번째 다리 경고(회색)도 보여요" },
        shortsParam,
        linesParam,
      ],
      color: "#f5c542",
      make(ctx, inst) {
        const p = inst.params;
        const sE = ctx.addLine(0, { color: inst.color, lineWidth: inst.width ?? 1 });
        const lv = new Levels();
        ctx.attach(lv);
        let ema = [];
        let st = [];
        let evs = [];
        let legs = 0;
        let last = [];
        return {
          series: [sE],
          prims: [lv],
          render(bars, from) {
            last = bars;
            const n = bars.length;
            ema = C.ema(closes(bars), p.len);
            paintLine(sE, bars, ema, ctx.time, from);
            const atr = C.atr(bars, 14);
            st = S.alwaysIn(bars, ema, p.minBars);
            legs = S.legCount(bars, st);
            // 장 시작 직후 봉 (정규장이 있는 종목의 분봉만)
            let skipArr = null;
            if (p.skip > 0 && ctx.info?.rth && !isDaily(ctx)) {
              skipArr = new Array(n).fill(false);
              let key = null;
              let cnt = 0;
              for (let i = 0; i < n; i++) {
                const k = ctx.dayKey(bars[i].t);
                if (k !== key) {
                  key = k;
                  cnt = 0;
                }
                if (!ctx.isRegular(bars[i].t)) skipArr[i] = true;
                else skipArr[i] = cnt++ < p.skip;
              }
            }
            const x = win(bars, ema, atr, st);
            const o = { tick: tickOf(ctx), rr: p.rr, rangeLen: p.rangeLen, skip: skipArr ? (i) => skipArr[i + x.off] : null };
            const longs = shift(S.findBarSignals(x.bars, x.arrs[0], x.arrs[1], x.arrs[2], o), x.off);
            const shorts = p.shorts ? shift(S.findBarSignals(S.flipBars(x.bars), S.neg(x.arrs[0]), x.arrs[1], x.arrs[2].map((v) => -v), o), x.off).map(unflip) : [];
            evs = [...longs, ...shorts].sort((a, b) => a.i - b.i);
            ctx.setMarkers(
              inst.uid,
              // 기본: 살아 있는 신호만. 취소된 것(다음 봉이 진입가를 못 넘음)·3번째 다리 경고는 '모두 표시'를 켜야 보인다 (화살표가 너무 많아져서)
              evs.filter((e) => p.all || (e.hit !== false && !e.warn)).map((e) => {
                const text = e.range ? `레인지 ${e.short ? "▼" : "▲"}` : e.warn ? `${e.leg}번째 다리` : `${e.short ? "L" : "H"}${e.n}`;
                const base = e.short ? downColor() : upColor();
                return mark(ctx, bars, e.i, !e.short, text, e.warn ? MUTE : e.hit === false ? hexA(base, 0.4) : base);
              })
            );
            const segs = spanPlans(ctx, evs.filter((e) => e.hit !== false && !e.warn).map((e) => ({ ...e, targets: [{ label: e.range ? "목표 (반대쪽 1/3)" : `목표 ${p.rr}R`, price: e.target }] })), n, p.lines);
            if (n && st[n - 1] === 0) {
              const z = S.rangeZone(bars, n, p.rangeLen);
              if (z) {
                segs.push({ from: z.s, to: null, price: z.hi, color: MUTE, label: "레인지 위" }, { from: z.s, to: null, price: z.lo, color: MUTE, label: "레인지 아래" });
                segs.push({ from: z.s, to: null, price: z.t2, color: hexA(downColor(), 0.7), dash: true, label: "이 위 1/3 = 파는 쪽" }, { from: z.s, to: null, price: z.t1, color: hexA(upColor(), 0.7), dash: true, label: "이 아래 1/3 = 사는 쪽 · 가운데는 금지" });
              }
            }
            lv.setData(segs);
          },
          legend(i) {
            const s = st[i];
            const items = [
              { label: `봉 읽기 · EMA ${p.len}`, value: ctx.fmt(ema[i]), color: inst.color },
              { label: s > 0 ? "상승 추세 ▲ 롱만 · 들고 간다" : s < 0 ? "하락 추세 ▼ 숏만 · 들고 간다" : "레인지 · 아래 1/3 매수, 위 1/3 매도, 짧게", value: "", color: s > 0 ? upColor() : s < 0 ? downColor() : "#a0a6ae" },
            ];
            if (i >= last.length - 1 && legs) items.push({ label: legs >= 3 ? `${legs}번째 다리 → 새로 들어가지 않기` : `${legs}번째 다리`, value: "", color: legs >= 3 ? STOP : "#a0a6ae" });
            const e = lastOf(evs.filter((x) => x.i <= i));
            if (e) items.push({ br: true }, { label: `최근: ${e.range ? "레인지" : `${e.short ? "L" : "H"}${e.n}`} ${e.short ? "숏" : "롱"}`, value: `${i - e.i}봉 전 · ${e.hit === false ? "다음 봉이 안 넘어 취소" : e.hit ? "다음 봉에서 진입가 넘음" : "다음 봉이 넘으면 진입"}`, color: e.short ? downColor() : upColor() });
            return items;
          },
        };
      },
    },
  };
}

/** 지표 창 순서 (맨 위에 모아서 보여 준다) */
export const GUIDE_ORDER = ["rplan", "regime", "sixma", "pull20", "setup50", "pistol", "lshape", "vwapswing", "barread"];
