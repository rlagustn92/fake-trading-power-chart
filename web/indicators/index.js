// 지표 목록: 이름(교과서 원래 이름), 들어가는 창, 파라미터, 그리는 법 (SPEC §3.2, §3.5)
// make(ctx, inst) → { render(bars, from), legend(i), series:[], prims:[] }
//   render(bars, from): from=0이면 전체 다시, 아니면 from번째 봉부터만 고침(실시간)
import * as C from "./calc.js";
import { BandFill, Levels, VolumeProfile, AutoTriangle, Segments } from "../ui/primitives.js";
import { TF_SEC } from "../core/bars.js";
import { findTriangle } from "./triangle.js";
import { upColor, downColor, rgba } from "../core/colors.js";

// 오름·내림 색은 한국식·미국식 설정을 따른다 (core/colors.js, 0.13.0) → 그릴 때마다 읽는다
const close = (bars) => bars.map((b) => b.c);

// 같은 지표를 여러 번 넣을 때 돌아가며 쓰는 색
export const PALETTE = ["#f5c542", "#b18cff", "#4cd5a0", "#ff8a3d", "#5ec8d8", "#ff6fae", "#9ad04a", "#e8eaed"];
// 지표 설정에서 고를 수 있는 색 16가지 (0.13.0, 사용자: "지표 색상 더 다양하게") + 🎨 직접 고르기 (ui/indpanel.js)
export const SWATCHES = [...PALETTE, "#ff4d4f", "#3d8bff", "#00c853", "#26a69a", "#7c4dff", "#a1887f", "#8e99a6", "#ffffff"];

/** 선 하나 그리기 (전체 또는 from부터) */
function paintLine(series, bars, vals, time, from) {
  if (!from) {
    const data = [];
    for (let i = 0; i < bars.length; i++) if (vals[i] != null && Number.isFinite(vals[i])) data.push({ time: time(bars[i].t), value: vals[i] });
    series.setData(data);
    return;
  }
  for (let i = from; i < bars.length; i++) {
    if (vals[i] == null || !Number.isFinite(vals[i])) continue;
    series.update({ time: time(bars[i].t), value: vals[i] });
  }
}

function paintHist(series, bars, vals, time, from, color) {
  const pt = (i) => ({ time: time(bars[i].t), value: vals[i], color: color(i) });
  if (!from) {
    const data = [];
    for (let i = 0; i < bars.length; i++) if (vals[i] != null) data.push(pt(i));
    series.setData(data);
    return;
  }
  for (let i = from; i < bars.length; i++) if (vals[i] != null) series.update(pt(i));
}

/**
 * 다른 봉 기준(MTF) 값을 지금 봉에 계단 모양으로 맞추기 — 미래 값을 쓰지 않게 (TradingView lookahead_off와 같음):
 * 상위 봉이 아직 안 끝난 동안에는 직전(끝난) 상위 봉 값, 그 상위 봉의 마지막 아래 봉에서야 그 값으로 바뀐다.
 * 차트 맨 끝(지금 만들어지는 봉)은 진행 중 값 — 단, 리플레이 중에는 그것도 쓰지 않는다(뒤의 값이 섞여 있어서).
 */
export function mapHtf(bars, htf, vals, o) {
  const out = new Array(bars.length).fill(null);
  const key = o.htfKey; // 지금 봉 시각 → 상위 봉과 비교할 값 (상위 봉마다 다르다: 일봉은 날짜, 15분은 시각)
  // 리플레이 중 맨 끝 봉: 그 상위 봉이 리플레이 시각(o.endT)까지 다 지났으면 끝난 봉이니 그 값 (0.16.0).
  // 전에는 늘 직전 상위 봉 값이라, "⏭ 한 칸"으로 15:00 정각에 멈추면 방금 끝난 14시 1시간봉이 아니라 13시 봉 값이 보였다 (한 칸 늦음, 미래 값은 아님)
  const doneBy = (j0) => o.replaying && o.endT != null && o.span > 0 && key(o.endT) >= htf[j0].t + o.span;
  const idx = new Array(bars.length).fill(-1);
  let j = 0;
  for (let i = 0; i < bars.length; i++) {
    const k = key(bars[i].t);
    while (j + 1 < htf.length && htf[j + 1].t <= k) j++;
    if (htf[j] && htf[j].t <= k) idx[i] = j;
  }
  for (let i = 0; i < bars.length; i++) {
    const j0 = idx[i];
    if (j0 < 0) continue;
    const lastOfHtf = i + 1 < bars.length ? idx[i + 1] !== j0 : o.replaying ? doneBy(j0) : j0 === htf.length - 1;
    const v = lastOfHtf ? vals[j0] : vals[j0 - 1];
    out[i] = v ?? null;
  }
  return out;
}

/** mapHtf에 넘길 것: 시각 → 비교 값, 리플레이 중인지, 리플레이 시각, 상위 봉 길이(초) — 모든 "기준 봉" 지표가 같이 쓴다 */
const htfOpt = (ctx, tf) => ({ htfKey: ctx.htfKeyOf(tf), replaying: ctx.replaying, endT: ctx.replayEnd, span: TF_SEC[tf] });

/**
 * 기준 봉(want)과 차트 봉 비교 (0.16.0): "same" 차트 봉으로 계산 · "htf" 큰 봉으로 계산해 계단 · "lower" 차트보다 작은 봉이라 숨김.
 * 예전에는 "lower"일 때 조용히 차트 봉으로 계산해서, 4시간봉 차트의 "SMA 20 (1시간봉)"이 실제로는 4시간 SMA 20이었다.
 */
export function tfMode(want, chartTf) {
  if (!want || want === chartTf) return "same";
  return TF_SEC[want] > TF_SEC[chartTf] ? "htf" : "lower";
}
/** 범례 이름 뒤에 붙는 기준 봉: "" · " (1시간봉)" · " (1시간봉 · 이 봉에선 숨김)" */
const tfTag = (want, ctx) => {
  const m = tfMode(want, ctx.tf);
  return m === "same" ? "" : ` (${ctx.tfName(want)}${m === "lower" ? " · 이 봉에선 숨김" : ""})`;
};

/** 가격 창 이동평균류 공통 (SMA·EMA·VWMA) — 기준 봉(tf)이 다르면 그 봉으로 계산. fn(bars, 기간, params) */
function maIndicator(fn, short) {
  return (ctx, inst) => {
    const p = inst.params;
    const s = ctx.addLine(0, { color: inst.color, lineWidth: inst.width ?? 1 });
    let vals = [];
    const calc = (bars) => {
      const m = tfMode(p.tf, ctx.tf);
      if (m === "lower") return new Array(bars.length).fill(null);
      if (m === "htf") {
        const htf = ctx.htf(p.tf);
        if (!htf) return new Array(bars.length).fill(null);
        return mapHtf(bars, htf, fn(htf, p.length, p), htfOpt(ctx, p.tf));
      }
      return fn(bars, p.length, p);
    };
    const srcName = p.src && p.src !== "c" ? ` ${C.SOURCES.find(([k]) => k === p.src)?.[1] ?? p.src}` : ""; // 범례: "SMA 20 고가"
    return {
      series: [s],
      render(bars, from) {
        vals = calc(bars);
        paintLine(s, bars, vals, ctx.time, from);
      },
      legend: (i) => [{ label: `${short} ${p.length}${srcName}${tfTag(p.tf, ctx)}`, value: ctx.fmt(vals[i]), color: inst.color }],
    };
  };
}

const lenParam = (def) => ({ key: "length", label: "기간", def, min: 1, max: 2000 });
// 소스 (TradingView 기본 기능과 같게, 0.14.0): 고가·저가로 바꾸면 이동평균 위·아래 선 (듀얼 이동평균 밴드를 직접 만들 때)
const srcParam = { key: "src", label: "소스", def: "c", type: "select", options: C.SOURCES, tip: "이 가격으로 평균을 내요 (TradingView '소스'와 같아요)\n고가·저가로 바꾸면 종가 이동평균 위·아래에 선이 하나씩 생겨요" };
const multParam = { key: "mult", label: "배수(σ)", def: 2, min: 0.1, max: 10, step: 0.1 };

/**
 * 가운데 선(점선) + 위·아래 띠 + 옅은 채우기 (볼린저 밴드류: BB·VWBB)
 * - 기준 봉(tf)이 더 크면 그 봉으로 계산해서 계단 모양으로 (끝난 봉 값만, SMA·VWMA와 같은 규칙)
 * - p.bands13이면 ±1σ·±3σ 점선도 (TradingView vwBB처럼), 아래 선은 p.tvLower 방식을 따른다
 */
function bandIndicator(calc, short) {
  return (ctx, inst) => {
    const p = inst.params;
    const o = { color: inst.color, lineWidth: inst.width ?? 1 };
    const mid = ctx.addLine(0, { ...o, lineStyle: 2 });
    const up = ctx.addLine(0, o);
    const dn = ctx.addLine(0, o);
    const thin = { color: hexA(inst.color, 0.6), lineWidth: 1, lineStyle: 1 };
    const extra = p.bands13 ? [1, 3].flatMap((k) => [{ k, side: "u", s: ctx.addLine(0, thin) }, { k, side: "l", s: ctx.addLine(0, thin) }]) : [];
    const fill = new BandFill(hexA(inst.color, 0.08));
    ctx.attach(fill);
    let r = { basis: [], upper: [], lower: [] };
    const htfOn = () => tfMode(p.tf, ctx.tf) === "htf";
    // 한 묶음 봉으로 계산: 가운데·위·아래 (+ ±1σ·±3σ)
    const calcAll = (src) => {
      const x = calc(src, p);
      const out = { basis: x.basis, upper: x.upper, lower: x.lower };
      for (const e of extra) {
        out[`${e.side}${e.k}`] = x.basis.map((b, i) => (b == null || x.dev?.[i] == null ? null : e.side === "u" ? b + e.k * x.dev[i] : C.bandLower(b, x.dev[i], e.k, p.tvLower)));
      }
      return out;
    };
    return {
      series: [mid, up, dn, ...extra.map((e) => e.s)],
      prims: [fill],
      render(bars, from) {
        if (tfMode(p.tf, ctx.tf) === "lower") r = { basis: [], upper: [], lower: [] }; // 차트보다 작은 기준 봉 → 숨김 (0.16.0)
        else if (htfOn()) {
          const htf = ctx.htf(p.tf);
          if (!htf) r = { basis: [], upper: [], lower: [] };
          else {
            const h = calcAll(htf);
            const o2 = htfOpt(ctx, p.tf);
            r = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, mapHtf(bars, htf, v, o2)]));
          }
        } else r = calcAll(bars);
        paintLine(mid, bars, r.basis, ctx.time, from);
        paintLine(up, bars, r.upper, ctx.time, from);
        paintLine(dn, bars, r.lower, ctx.time, from);
        for (const e of extra) paintLine(e.s, bars, r[`${e.side}${e.k}`] ?? [], ctx.time, from);
        fill.setData(bars.map((b, i) => ({ up: r.upper[i], dn: r.lower[i] })));
      },
      legend: (i) => [
        {
          label: `${short} ${p.length} ${p.mult}${tfTag(p.tf, ctx)}${p.tvLower ? " TV" : ""}`,
          value: `${ctx.fmt(r.upper[i])} / ${ctx.fmt(r.basis[i])} / ${ctx.fmt(r.lower[i])}`,
          color: inst.color,
        },
      ],
    };
  };
}
const tfParam = { key: "tf", label: "기준 봉", def: "", type: "tf" };

/** RSI 창 기준선: 위·아래 점선 + 50 옅은 선 */
function rsiLevels(s, hi, lo) {
  s.createPriceLine({ price: hi, color: hexA(upColor(), 0.6), lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
  s.createPriceLine({ price: lo, color: hexA(downColor(), 0.7), lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
  s.createPriceLine({ price: 50, color: "rgba(160,166,174,0.25)", lineStyle: 3, lineWidth: 1, axisLabelVisible: false });
}

// 다이버전스 종류: 이름표, 색(오를 쪽 빨강·내릴 쪽 파랑), 히든은 점선, 바닥(저가)끼리인지 꼭대기(고가)끼리인지
const DIV = {
  bull: { name: "상승", get color() { return upColor(); }, low: true },
  hbull: { name: "히든 상승", get color() { return upColor(); }, low: true, hidden: true },
  bear: { name: "하락", get color() { return downColor(); }, low: false },
  hbear: { name: "히든 하락", get color() { return downColor(); }, low: false, hidden: true },
};
const divSeg = (d, pa, pb, label) => {
  const k = DIV[d.kind];
  return { a: d.a, pa, b: d.b, pb, color: k.hidden ? hexA(k.color, 0.8) : k.color, dash: !!k.hidden, label: label ? k.name : "", above: !k.low };
};

// ── 멀티 이평 (0.16.0, 사용자 아이디어: "5분봉에서 1시간·4시간·일봉 이평을 한 번에") ──
// 줄마다 봉·기간을 따로 켜고 끈다. 큰 봉 줄은 '기준 봉'과 같은 규칙(mapHtf: 끝난 상위 봉 값만, TradingView lookahead_off)으로 계단.
// 차트 봉과 같은 줄은 차트 봉으로 계산, 차트보다 작은 봉 줄은 숨긴다 (tfMode). 색은 줄마다 정해 두고, 큰 봉일수록 굵게(w)
export const MTF_ROWS = [
  { tf: "15m", len: 20, on: true, color: "#5ec8d8", w: 0 },
  { tf: "1h", len: 20, on: true, color: "#f5c542", w: 0 },
  { tf: "4h", len: 20, on: true, color: "#b18cff", w: 1 },
  { tf: "1D", len: 200, on: true, color: "#ff8a3d", w: 1 },
  { tf: "1W", len: 20, on: false, color: "#e8eaed", w: 2 },
];
const MTF_KO = { "15m": "15분", "1h": "1시간", "4h": "4시간", "1D": "일봉", "1W": "주봉" };

/**
 * 이평선 배열 (0.16.0): 짧은 선(봉 길이 × 기간이 짧은 것)부터 늘어놓아
 * 위→아래로 차례면 "up"(정배열), 아래→위로 차례면 "down"(역배열), 아니면 "mix". 값이 2개 안 되면 null.
 * list = [{ span: 초, v: 값 }]
 */
export function maOrder(list) {
  const xs = list.filter((x) => x.v != null && Number.isFinite(x.v)).sort((a, b) => a.span - b.span);
  if (xs.length < 2) return null;
  let up = true;
  let dn = true;
  for (let k = 1; k < xs.length; k++) {
    if (!(xs[k - 1].v > xs[k].v)) up = false;
    if (!(xs[k - 1].v < xs[k].v)) dn = false;
  }
  return up ? "up" : dn ? "down" : "mix";
}
/** 지금 가격이 선보다 몇 % 위(+)·아래(−)인지 */
export const distPct = (price, v) => (price == null || v == null || !v || !Number.isFinite(price / v) ? null : (price / v - 1) * 100);

/**
 * 멀티 이평 "매끄럽게" (0.17.0, 사용자: "계단식 보니까 웃기다 · 계단/매끄럽게 선택하게"):
 * 아래 봉마다 "끝난 상위 봉 n−1개 + 그 아래 봉의 종가(= 그 순간 상위 봉의 진행 중 종가)"로 이평을 다시 계산한다.
 * = 그 순간 상위 봉 차트를 켰다면 보였을 값. 상위 봉의 진행 중 값은 저장소 것(끝난 봉)을 쓰지 않으니 리플레이에서도 미래가 섞이지 않는다.
 * 상위 봉이 끝나는 아래 봉에서는 계단(mapHtf)과 같은 값이 된다. kind = "sma" | "ema"
 * o: {htfKey, dayOnly(t) → 이 아래 봉이 상위 봉(일봉 등) 값을 바꾸지 않는 봉이면 true (프리·애프터 → 직전 끝난 값)}
 */
export function mapHtfLive(bars, htf, n, kind, o) {
  const out = new Array(bars.length).fill(null);
  const key = o.htfKey;
  const closes = htf.map((b) => b.c);
  const ps = [0];
  for (const c of closes) ps.push(ps[ps.length - 1] + c);
  const em = kind === "ema" ? C.ema(closes, n) : null;
  const a = 2 / (n + 1);
  let j = 0;
  for (let i = 0; i < bars.length; i++) {
    const k = key(bars[i].t);
    while (j + 1 < htf.length && htf[j + 1].t <= k) j++;
    if (!htf[j] || htf[j].t > k) continue;
    const c = o.dayOnly?.(bars[i].t) ? null : bars[i].c; // 정규장 밖 봉은 일봉을 안 바꾼다 → 직전 끝난 값
    if (kind === "ema") {
      const e = em[j - 1];
      if (e == null) continue;
      out[i] = c == null ? e : e + a * (c - e);
    } else {
      if (c == null) {
        out[i] = j - n >= 0 ? (ps[j] - ps[j - n]) / n : null;
        continue;
      }
      if (j - (n - 1) < 0) continue;
      out[i] = (ps[j] - ps[j - (n - 1)] + c) / n;
    }
  }
  return out;
}

function makeMtfMa(ctx, inst) {
  const p = inst.params;
  const w = inst.width ?? 1;
  const ema = p.kind === "ema";
  const lines = MTF_ROWS.filter((r) => p[`on_${r.tf}`]).map((r) => {
    const n = Math.max(1, Math.round(p[`len_${r.tf}`] ?? r.len));
    const name = `${MTF_KO[r.tf]} ${ema ? "EMA " : ""}${n}`;
    // B. 선 이름표: 오른쪽 가격 눈금에 이름 + 지금 값 (lightweight-charts가 눈금 글자끼리 겹치지 않게 비켜 놓는다)
    // 화면 높이 안 늘림 (기본 켬, 사용자 결정 2026-11-04): 먼 선(일봉 200 등) 때문에 캔들이 납작해지지 않게 자동 눈금 계산에서 뺀다.
    // 대신 화면 밖으로 나간 선과 그 이름표는 안 보인다 (범례의 값·%는 그대로). 끄면 TradingView 기본처럼 선까지 화면에 넣는다
    const noFit = p.fit ? { autoscaleInfoProvider: () => null } : {};
    const s = ctx.addLine(0, { color: r.color, lineWidth: Math.min(4, w + r.w), lastValueVisible: !!p.tags, title: p.tags ? name : "", ...noFit });
    return { tf: r.tf, n, name, color: r.color, s, vals: [] };
  });
  let last = [];
  const shown = () => lines.filter((L) => tfMode(L.tf, ctx.tf) !== "lower");
  return {
    series: lines.map((L) => L.s),
    render(bars, from) {
      last = bars;
      for (const L of lines) {
        const m = tfMode(L.tf, ctx.tf);
        if (m === "lower") L.vals = [];
        else if (m === "same") L.vals = ema ? C.ema(close(bars), L.n) : C.sma(close(bars), L.n);
        else {
          const htf = ctx.htf(L.tf); // 처음에는 null → 읽고 나서 다시 그린다
          if (!htf) L.vals = [];
          else if (p.shape === "step") L.vals = mapHtf(bars, htf, ema ? C.ema(close(htf), L.n) : C.sma(close(htf), L.n), htfOpt(ctx, L.tf));
          else {
            // 매끄럽게 (기본): 일·주봉 줄은 정규장 밖 봉(프리·애프터)에서 값이 안 바뀐다 (저장된 일봉이 정규장만이라)
            const intraday = ctx.tf !== "1D" && ctx.tf !== "1W";
            const dayOnly = (L.tf === "1D" || L.tf === "1W") && intraday && ctx.isRegular ? (t) => !ctx.isRegular(t) : null;
            L.vals = mapHtfLive(bars, htf, L.n, ema ? "ema" : "sma", { htfKey: ctx.htfKeyOf(L.tf), dayOnly });
          }
        }
        paintLine(L.s, bars, L.vals, ctx.time, from);
      }
    },
    legend(i) {
      const vis = shown();
      if (!vis.length) return [{ label: "멀티 이평", value: "이 봉보다 큰 줄이 없어요 (설정에서 켜기)", color: inst.color }];
      const price = last[i]?.c;
      const items = [];
      // E. 정배열·역배열 (짧은 선이 위·긴 선이 아래로 차례면 정배열)
      const ord = maOrder(vis.map((L) => ({ span: TF_SEC[L.tf] * L.n, v: L.vals[i] })));
      if (ord) items.push({ label: ord === "up" ? "정배열 ▲" : ord === "down" ? "역배열 ▼" : "섞임", value: "", color: ord === "up" ? upColor() : ord === "down" ? downColor() : "#a0a6ae" });
      vis.forEach((L, k) => {
        // D. 거리: 지금 가격이 이 선보다 몇 % 위·아래
        const d = distPct(price, L.vals[i]);
        if (k > 0) items.push({ br: true });
        items.push({ label: L.name, value: ctx.fmt(L.vals[i]), color: L.color, more: d == null ? null : { text: `${d >= 0 ? "+" : ""}${d.toFixed(2)}%`, cls: d > 0 ? "up" : d < 0 ? "down" : "flat" } });
      });
      return items;
    },
  };
}

export const INDICATORS = {
  sma: {
    short: "SMA",
    pane: "price",
    params: [lenParam(20), srcParam, tfParam],
    color: "#f5c542",
    make: maIndicator((bars, n, p) => C.sma(C.source(bars, p.src), n), "SMA"),
  },
  ema: {
    short: "EMA",
    pane: "price",
    params: [lenParam(20), srcParam, tfParam],
    color: "#ff8a3d",
    make: maIndicator((bars, n, p) => C.ema(C.source(bars, p.src), n), "EMA"),
  },
  // 멀티 이평 (0.16.0): 15분·1시간·4시간·일봉·주봉 이동평균을 한 지표로. 설정 칸에서 줄마다 [✓ 봉] [기간]이 한 묶음(group)
  mtfma: {
    short: "멀티 이평",
    pane: "price",
    noColor: true, // 색은 줄마다 정해져 있다 (MTF_ROWS) → 지표 창에 색 고르기를 안 띄운다
    params: [
      ...MTF_ROWS.flatMap((r) => [
        { key: `on_${r.tf}`, label: `${MTF_KO[r.tf]}${r.tf.endsWith("D") || r.tf.endsWith("W") ? "" : "봉"}`, def: r.on, type: "bool", group: r.tf },
        { key: `len_${r.tf}`, label: "기간", def: r.len, min: 1, max: 2000, group: r.tf },
      ]),
      { key: "kind", label: "종류", def: "sma", type: "select", options: [["sma", "단순 (SMA)"], ["ema", "지수 (EMA)"]], tip: "단순: 기간 안의 가격을 똑같이 쳐서 평균\n지수: 최근 가격을 더 크게 쳐서 더 빨리 따라와요" },
      // 0.17.0 (사용자: "계단/매끄럽게 선택하게"). 처음 값 = 매끄럽게
      { key: "shape", label: "모양", def: "smooth", type: "select", options: [["smooth", "매끄럽게"], ["step", "계단"]], tip: "매끄럽게: 봉마다 그 순간 큰 봉 차트를 켰다면 보였을 값 (진행 중인 큰 봉 포함, 미래 값 없음)\n계단: 큰 봉이 끝나야 한 칸 바뀌는 확정 값만 (TradingView 기본과 같은 모양)\n큰 봉이 끝나는 순간에는 둘이 같은 값이에요" },
      { key: "tags", label: "눈금에 이름표", def: true, type: "bool", tip: "오른쪽 가격 눈금에 '1시간 20'처럼 선 이름과 지금 값을 붙여요" },
      { key: "fit", label: "선 때문에 화면 안 늘림", def: true, type: "bool", tip: "켜면(기본): 멀리 있는 선(예: 일봉 200) 때문에 캔들이 납작해지지 않아요\n대신 화면 밖으로 나간 선은 안 보여요 (범례의 값과 %는 그대로)\n끄면: TradingView 기본처럼 모든 선이 화면에 들어오게 넓혀요" },
    ],
    color: "#f5c542",
    make: makeMtfMa,
  },
  // 듀얼 이동평균 밴드 (0.14.0, 사용자가 본 유튜브 "이동평균 매매법" 14:30~): 같은 길이 이동평균을 종가·고가·저가로 세 줄 → 좁은 밴드.
  // 종가가 밴드 위로 마감 = 강세(롱 자리), 아래로 마감 = 약세(숏 자리), 밴드 안에서 마감 = 정리·쉬기. 200선은 큰 추세 확인 (영상의 "레벨 2")
  dualma: {
    short: "듀얼 이평",
    pane: "price",
    params: [
      lenParam(20),
      { key: "kind", label: "종류", def: "sma", type: "select", options: [["sma", "단순 (SMA)"], ["ema", "지수 (EMA)"]] },
      { key: "show200", label: "200선도", def: false, type: "bool", tip: "종가 200 이동평균도 같이 (큰 추세: 위면 롱 쪽, 아래면 숏 쪽만 보기)" },
      tfParam,
    ],
    color: "#5ec8d8",
    make(ctx, inst) {
      const p = inst.params;
      const w = inst.width ?? 1;
      const mid = ctx.addLine(0, { color: inst.color, lineWidth: w + 1 });
      const up = ctx.addLine(0, { color: hexA(inst.color, 0.85), lineWidth: w });
      const dn = ctx.addLine(0, { color: hexA(inst.color, 0.85), lineWidth: w });
      const long = p.show200 ? ctx.addLine(0, { color: "#e8eaed", lineWidth: 2 }) : null;
      const fill = new BandFill(hexA(inst.color, 0.12));
      ctx.attach(fill);
      const empty = { mid: [], up: [], dn: [], l200: [] };
      let r = empty;
      const ma = (vals, n) => (p.kind === "ema" ? C.ema(vals, n) : C.sma(vals, n));
      const calc = (src) => ({ mid: ma(C.source(src, "c"), p.length), up: ma(C.source(src, "h"), p.length), dn: ma(C.source(src, "l"), p.length), l200: p.show200 ? ma(C.source(src, "c"), 200) : [] });
      const htfOn = () => tfMode(p.tf, ctx.tf) === "htf";
      return {
        series: [mid, up, dn, long].filter(Boolean),
        prims: [fill],
        render(bars, from) {
          if (tfMode(p.tf, ctx.tf) === "lower") r = empty; // 차트보다 작은 기준 봉 → 숨김 (0.16.0)
          else if (htfOn()) {
            const htf = ctx.htf(p.tf);
            const o2 = htfOpt(ctx, p.tf);
            r = htf ? Object.fromEntries(Object.entries(calc(htf)).map(([k, v]) => [k, mapHtf(bars, htf, v, o2)])) : empty;
          } else r = calc(bars);
          paintLine(mid, bars, r.mid, ctx.time, from);
          paintLine(up, bars, r.up, ctx.time, from);
          paintLine(dn, bars, r.dn, ctx.time, from);
          if (long) paintLine(long, bars, r.l200, ctx.time, from);
          fill.setData(bars.map((b, i) => ({ up: r.up[i], dn: r.dn[i] })));
        },
        legend: (i) =>
          [
            { label: `듀얼 이평 ${p.length}${p.kind === "ema" ? " EMA" : ""}${tfTag(p.tf, ctx)}`, value: `${ctx.fmt(r.up[i])} / ${ctx.fmt(r.mid[i])} / ${ctx.fmt(r.dn[i])}`, color: inst.color },
            long ? { label: "200", value: ctx.fmt(r.l200[i]), color: "#e8eaed" } : null,
          ].filter(Boolean),
      };
    },
  },
  vwma: {
    short: "VWMA",
    pane: "price",
    params: [lenParam(20), tfParam],
    color: "#4cd5a0",
    needsVolume: true,
    make: maIndicator((bars, n) => C.vwma(bars, n), "VWMA"),
  },
  bb: {
    short: "BB",
    pane: "price",
    params: [lenParam(20), multParam, tfParam],
    color: "#5ec8d8",
    make: bandIndicator((bars, p) => C.bollinger(bars, p.length, p.mult), "BB"),
  },
  vwbb: {
    short: "VWBB",
    pane: "price",
    params: [
      lenParam(20),
      multParam,
      tfParam,
      { key: "bands13", label: "±1σ·±3σ 선도", def: false, type: "bool", tip: "TradingView vwBB처럼 ±1σ·±3σ 점선도 그려요 (가운데 굵은 띠는 위 '배수')" },
      { key: "tvLower", label: "아래 밴드 TradingView 방식", def: false, type: "bool", tip: "TradingView vwBB(xinolia) 기본과 같게: 아래 밴드 = 가운데² ÷ (가운데 + 배수×σ)\n끄면(기본) 보통 볼린저처럼 가운데 − 배수×σ\n예: 가운데 100, 2σ=10 → 끄면 90, 켜면 90.91" },
    ],
    color: "#c39bff",
    needsVolume: true,
    make: bandIndicator((bars, p) => C.vwbb(bars, p.length, p.mult, p.tvLower), "VWBB"),
  },
  hl52: {
    short: "52W",
    pane: "price",
    params: [],
    color: "#a0a6ae",
    dailyOnly: true,
    make(ctx, inst) {
      const hi = ctx.addLine(0, { color: hexA(upColor(), 0.7), lineWidth: 1, lineStyle: 2 });
      const lo = ctx.addLine(0, { color: hexA(downColor(), 0.8), lineWidth: 1, lineStyle: 2 });
      let r = { hi: [], lo: [] };
      return {
        series: [hi, lo],
        render(bars, from) {
          r = C.rollingHighLow(bars, ctx.tf === "1W" ? 52 : 252);
          paintLine(hi, bars, r.hi, ctx.time, from);
          paintLine(lo, bars, r.lo, ctx.time, from);
        },
        legend: (i) => [{ label: "52W 고/저", value: `${ctx.fmt(r.hi[i])} / ${ctx.fmt(r.lo[i])}`, color: inst.color }],
      };
    },
  },
  fractals: {
    short: "Fractals",
    pane: "price",
    params: [{ key: "n", label: "양옆 봉 수", def: 2, min: 1, max: 10 }],
    color: "#e8eaed",
    make(ctx, inst) {
      return {
        series: [],
        render(bars) {
          const f = C.fractals(bars, inst.params.n);
          const m = [];
          for (const i of f.up) m.push({ time: ctx.time(bars[i].t), position: "aboveBar", shape: "arrowDown", color: hexA(upColor(), 0.85), size: 0.6 });
          for (const i of f.down) m.push({ time: ctx.time(bars[i].t), position: "belowBar", shape: "arrowUp", color: hexA(downColor(), 0.9), size: 0.6 });
          ctx.setMarkers(inst.uid, m);
        },
        legend: () => [{ label: `Fractals ${inst.params.n}`, value: "", color: inst.color }],
      };
    },
  },
  vwap: {
    short: "VWAP",
    pane: "price",
    params: [{ key: "bands", label: "표준편차 밴드", def: 0, min: 0, max: 3 }],
    color: "#ff6fae",
    intradayOnly: true,
    needsVolume: true,
    make(ctx, inst) {
      const s = ctx.addLine(0, { color: inst.color, lineWidth: inst.width ?? 2 });
      const nb = Math.round(inst.params.bands ?? 0);
      const bands = [];
      for (let k = 1; k <= nb; k++) bands.push([ctx.addLine(0, { color: hexA(inst.color, 0.6), lineWidth: 1, lineStyle: 2 }), ctx.addLine(0, { color: hexA(inst.color, 0.6), lineWidth: 1, lineStyle: 2 })]);
      let r = { vwap: [], bands: [] };
      return {
        series: [s, ...bands.flat()],
        render(bars, from) {
          r = C.vwap(bars, ctx.dayKey, bands.map((_, k) => k + 1));
          paintSessionLine(s, bars, r.vwap, ctx, from);
          bands.forEach(([u, d], k) => {
            paintSessionLine(u, bars, r.bands[k].up, ctx, from);
            paintSessionLine(d, bars, r.bands[k].dn, ctx, from);
          });
        },
        legend: (i) => [{ label: "VWAP", value: ctx.fmt(r.vwap[i]), color: inst.color }],
      };
    },
  },
  orb: {
    short: "ORB",
    pane: "price",
    params: [{ key: "minutes", label: "장 시작 몇 분", def: 15, min: 1, max: 120 }],
    color: "#ffb020",
    intradayOnly: true,
    make(ctx, inst) {
      const up = ctx.addLine(0, { color: hexA(upColor(), 0.9), lineWidth: inst.width ?? 2, lineStyle: 2 });
      const dn = ctx.addLine(0, { color: hexA(downColor(), 0.9), lineWidth: inst.width ?? 2, lineStyle: 2 });
      const m = Math.max(1, Math.round(inst.params.minutes ?? 15));
      let r = { hi: [], lo: [] };
      return {
        series: [up, dn],
        render(bars, from) {
          const start = ctx.info.rth ? ctx.info.rth[0] : ctx.info.anchor ?? 0;
          r = C.openingRange(bars, m, ctx.dayKey, ctx.tod, start);
          paintSessionLine(up, bars, r.hi, ctx, from);
          paintSessionLine(dn, bars, r.lo, ctx, from);
        },
        legend: (i) => [
          { label: `ORB ${m}분 고`, value: ctx.fmt(r.hi[i]), color: hexA(upColor(), 0.9) },
          { label: "저", value: ctx.fmt(r.lo[i]), color: hexA(downColor(), 0.9) },
        ],
      };
    },
  },
  pdhl: {
    short: "PDH/PDL",
    pane: "price",
    params: [],
    color: "#c9ced6",
    intradayOnly: true,
    make(ctx, inst) {
      const lv = new Levels();
      ctx.attach(lv);
      return {
        series: [],
        prims: [lv],
        render(bars) {
          lv.setData(dayLevels(bars, ctx, (prev, cur, day) => {
            const out = [];
            if (prev) {
              out.push({ price: prev.h, color: hexA(upColor(), 0.8), label: "PDH", dash: true });
              out.push({ price: prev.l, color: hexA(downColor(), 0.9), label: "PDL", dash: true });
              out.push({ price: prev.c, color: "rgba(201,206,214,0.7)", label: "PDC", dash: true });
            }
            if (day.pre) {
              out.push({ price: day.pre.h, color: "rgba(255,176,32,0.8)", label: "PMH", dash: true });
              out.push({ price: day.pre.l, color: "rgba(255,176,32,0.8)", label: "PML", dash: true });
            }
            return out;
          }));
        },
        legend: () => [{ label: "PDH/PDL/PDC", value: "", color: inst.color }],
      };
    },
  },
  pivots: {
    short: "Pivots",
    pane: "price",
    params: [],
    color: "#b18cff",
    intradayOnly: true,
    make(ctx, inst) {
      const lv = new Levels();
      ctx.attach(lv);
      return {
        series: [],
        prims: [lv],
        render(bars) {
          lv.setData(dayLevels(bars, ctx, (prev) => {
            if (!prev) return [];
            const p = C.pivotLevels(prev.h, prev.l, prev.c);
            return [
              { price: p.R2, color: hexA(upColor(), 0.55), label: "R2" },
              { price: p.R1, color: hexA(upColor(), 0.8), label: "R1" },
              { price: p.P, color: "rgba(232,234,237,0.8)", label: "P" },
              { price: p.S1, color: hexA(downColor(), 0.85), label: "S1" },
              { price: p.S2, color: hexA(downColor(), 0.6), label: "S2" },
            ];
          }));
        },
        legend: () => [{ label: "Pivots (Classic)", value: "", color: inst.color }],
      };
    },
  },
  triangle_auto: {
    short: "Auto Triangle",
    pane: "price",
    params: [
      { key: "n", label: "프랙탈 크기", def: 2, min: 1, max: 6 },
      { key: "lookback", label: "찾는 구간(봉)", def: 150, min: 40, max: 600, step: 10 },
    ],
    color: "#ffb020",
    make(ctx, inst) {
      const prim = new AutoTriangle(inst.color);
      ctx.attach(prim);
      let tri = null;
      let lastN = -1;
      return {
        series: [],
        prims: [prim],
        render(bars, from) {
          // 새 봉이 생길 때만 다시 찾는다 (실시간으로 마지막 봉만 바뀌면 그대로)
          if (from && bars.length === lastN && !tri?.breakout) return;
          lastN = bars.length;
          const log = ctx.log;
          tri = ctx.info.line ? null : findTriangle(bars, { n: inst.params.n, lookback: inst.params.lookback, f: log ? Math.log : (x) => x, finv: log ? Math.exp : (x) => x });
          prim.setData(tri, tri ? `자동 · 참고용 · ${tri.name}` : "");
          const b = tri?.breakout;
          ctx.setMarkers(inst.uid, b ? [{ time: ctx.time(bars[b.i].t), position: b.up ? "aboveBar" : "belowBar", shape: b.up ? "arrowUp" : "arrowDown", color: b.up ? upColor() : downColor(), text: b.up ? "▲ 위 이탈" : "▼ 아래 이탈" }] : []);
        },
        legend: () => [
          { label: "Auto Triangle", value: tri ? `${tri.name} (자동·참고용)` : "지금은 없음", color: inst.color },
          tri ? { label: "", action: { text: "📌 그림으로 고정", tip: "이 삼각형을 직접 그린 Triangle Pattern으로 바꿔요", onclick: () => ctx.pinTriangle(tri) } } : null,
        ].filter(Boolean),
      };
    },
  },
  vpvr: {
    short: "VPVR",
    pane: "price",
    params: [{ key: "rows", label: "칸 수", def: 24, min: 6, max: 120 }],
    color: "#ffb020",
    needsVolume: true,
    make(ctx, inst) {
      let bars = [];
      const vp = new VolumeProfile((from, to) => C.volumeProfile(bars.slice(from, to + 1), inst.params.rows));
      ctx.attach(vp);
      return {
        series: [],
        prims: [vp],
        render(b) {
          bars = b;
          vp.refresh();
        },
        legend: () => [{ label: `VPVR ${inst.params.rows}`, value: "", color: inst.color }],
      };
    },
  },

  // ── 보조 창 ──
  volume: {
    short: "Vol",
    pane: "sub",
    params: [{ key: "ma", label: "이평", def: 20, min: 0, max: 500 }],
    color: "#a0a6ae",
    needsVolume: true,
    make(ctx, inst) {
      const pane = ctx.newPane();
      const hs = ctx.addHist(pane, { priceFormat: { type: "volume" } });
      const ma = inst.params.ma ? ctx.addLine(pane, { color: "#f5c542", lineWidth: 1, priceFormat: { type: "volume" } }) : null;
      let vals = [];
      let mav = [];
      return {
        series: [hs, ma].filter(Boolean),
        render(bars, from) {
          vals = bars.map((b) => b.v);
          paintHist(hs, bars, vals, ctx.time, from, (i) => (bars[i].c >= bars[i].o ? rgba(upColor(), 0.45) : rgba(downColor(), 0.45)));
          if (ma) {
            mav = C.sma(vals, inst.params.ma);
            paintLine(ma, bars, mav, ctx.time, from);
          }
        },
        legend: (i) => [{ label: "Vol", value: ctx.compact(vals[i]), color: inst.color }, ma ? { label: `MA ${inst.params.ma}`, value: ctx.compact(mav[i]), color: "#f5c542" } : null].filter(Boolean),
      };
    },
  },
  rvol: {
    short: "RVOL",
    pane: "sub",
    params: [
      { key: "length", label: "일·주봉: 비교할 봉 수", def: 20, min: 2, max: 500 },
      { key: "days", label: "분봉: 비교할 날 수", def: 10, min: 1, max: 60 },
    ],
    color: "#ffb020",
    needsVolume: true,
    make(ctx, inst) {
      const p = inst.params;
      const pane = ctx.newPane();
      const fmt = { type: "custom", formatter: (v) => `${v.toFixed(2)}x`, minMove: 0.01 };
      const hs = ctx.addHist(pane, { priceFormat: fmt });
      hs.createPriceLine({ price: 1, color: "rgba(160,166,174,0.6)", lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
      hs.createPriceLine({ price: 2, color: "rgba(255,138,61,0.7)", lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
      const atTime = !["1D", "1W"].includes(ctx.tf);
      let vals = [];
      return {
        series: [hs],
        render(bars, from) {
          vals = atTime ? C.rvolAtTime(bars, p.days, ctx.dayKey, ctx.tod) : C.rvol(bars, p.length);
          // 2배 이상 = 진한 주황(사람이 확 몰림), 1~2배 = 옅은 주황, 1배 아래 = 회색
          paintHist(hs, bars, vals, ctx.time, from, (i) => (vals[i] >= 2 ? "rgba(255,138,61,0.9)" : vals[i] >= 1 ? "rgba(255,176,32,0.5)" : "rgba(160,166,174,0.35)"));
        },
        legend: (i) => [{ label: atTime ? `RVOL at Time ${p.days}일` : `RVOL ${p.length}`, value: vals[i] == null ? "—" : `${vals[i].toFixed(2)}x`, color: inst.color }],
      };
    },
  },
  rsi: {
    short: "RSI",
    pane: "sub",
    params: [lenParam(14), { key: "hi", label: "위 기준선", def: 70, min: 50, max: 100 }, { key: "lo", label: "아래 기준선", def: 30, min: 0, max: 50 }],
    color: "#b18cff",
    make(ctx, inst) {
      const p = inst.params;
      const pane = ctx.newPane();
      const s = ctx.addLine(pane, { color: inst.color, lineWidth: inst.width ?? 1, priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
      rsiLevels(s, p.hi, p.lo);
      let vals = [];
      return {
        series: [s],
        render(bars, from) {
          vals = C.rsi(bars, p.length);
          paintLine(s, bars, vals, ctx.time, from);
        },
        legend: (i) => [{ label: `RSI ${p.length}`, value: vals[i] == null ? "—" : vals[i].toFixed(2), color: inst.color }],
      };
    },
  },
  rsi_div: {
    short: "RSI Div",
    pane: "sub",
    params: [
      lenParam(14),
      { key: "left", label: "꼭짓점 왼쪽 봉", def: 5, min: 1, max: 30 },
      { key: "right", label: "꼭짓점 오른쪽 봉", def: 5, min: 1, max: 30 },
      { key: "minGap", label: "두 꼭짓점 사이 최소 봉", def: 5, min: 0, max: 500 },
      { key: "maxGap", label: "최대 봉", def: 60, min: 1, max: 1000 },
      { key: "hiddenDiv", label: "히든 다이버전스도", def: false, type: "bool", tip: "히든 상승: 가격 바닥은 높아졌는데 RSI 바닥은 낮아짐 (오르던 흐름이 이어질 수 있음)\n히든 하락: 가격 꼭대기는 낮아졌는데 RSI 꼭대기는 높아짐 (내리던 흐름이 이어질 수 있음)\n점선으로 그려요" },
      { key: "onPrice", label: "가격 차트에도 선", def: true, type: "bool", tip: "RSI 창의 선과 같은 두 봉을 가격 차트에서도 이어요 (저가끼리·고가끼리)" },
    ],
    color: "#b18cff",
    make(ctx, inst) {
      const p = inst.params;
      const pane = ctx.newPane();
      const s = ctx.addLine(pane, { color: inst.color, lineWidth: inst.width ?? 1, priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
      rsiLevels(s, 70, 30);
      const inPane = new Segments();
      s.attachPrimitive(inPane);
      const onPrice = p.onPrice ? new Segments() : null;
      if (onPrice) ctx.attach(onPrice);
      let vals = [];
      let divs = [];
      return {
        series: [s],
        prims: onPrice ? [onPrice] : [],
        render(bars, from) {
          vals = C.rsi(bars, p.length);
          paintLine(s, bars, vals, ctx.time, from);
          divs = C.divergences(bars, vals, p).filter((d) => p.hiddenDiv || !DIV[d.kind].hidden);
          inPane.setData(divs.map((d) => divSeg(d, vals[d.a], vals[d.b], true)));
          onPrice?.setData(divs.map((d) => (DIV[d.kind].low ? divSeg(d, bars[d.a].l, bars[d.b].l) : divSeg(d, bars[d.a].h, bars[d.b].h))));
        },
        legend: (i) => {
          // 이 봉에서 이미 확정된 것(꼭짓점 오른쪽 봉이 다 생긴 것) 중 마지막
          let last = null;
          for (const d of divs) if (d.b + p.right <= i) last = d;
          return [
            { label: `RSI Div ${p.length}`, value: vals[i] == null ? "—" : vals[i].toFixed(2), color: inst.color },
            { label: "최근", value: last ? `${DIV[last.kind].name} 다이버전스 · ${i - last.b}봉 전` : "없음", color: last ? DIV[last.kind].color : "#a0a6ae" },
          ];
        },
      };
    },
  },
  macd: {
    short: "MACD",
    pane: "sub",
    params: [{ key: "fast", label: "빠른 선", def: 12, min: 1, max: 500 }, { key: "slow", label: "느린 선", def: 26, min: 1, max: 500 }, { key: "signal", label: "시그널", def: 9, min: 1, max: 500 }],
    color: "#5ec8d8",
    make(ctx, inst) {
      const p = inst.params;
      const pane = ctx.newPane();
      const fmt = { type: "price", precision: ctx.decimals, minMove: 1 / 10 ** ctx.decimals };
      const hs = ctx.addHist(pane, { priceFormat: fmt });
      const m = ctx.addLine(pane, { color: inst.color, lineWidth: 1, priceFormat: fmt });
      const sg = ctx.addLine(pane, { color: "#ff8a3d", lineWidth: 1, priceFormat: fmt });
      let r = { macd: [], signal: [], hist: [] };
      return {
        series: [hs, m, sg],
        render(bars, from) {
          r = C.macd(bars, p.fast, p.slow, p.signal);
          paintHist(hs, bars, r.hist, ctx.time, from, (i) => {
            const v = r.hist[i];
            const pv = r.hist[i - 1] ?? 0;
            return v >= 0 ? rgba(upColor(), v >= pv ? 0.75 : 0.35) : rgba(downColor(), v <= pv ? 0.8 : 0.4);
          });
          paintLine(m, bars, r.macd, ctx.time, from);
          paintLine(sg, bars, r.signal, ctx.time, from);
        },
        legend: (i) => [
          { label: `MACD ${p.fast} ${p.slow} ${p.signal}`, value: ctx.fmt(r.macd[i]), color: inst.color },
          { label: "Signal", value: ctx.fmt(r.signal[i]), color: "#ff8a3d" },
          { label: "Hist", value: ctx.fmt(r.hist[i]), color: "#a0a6ae" },
        ],
      };
    },
  },
  stoch: {
    short: "Stoch",
    pane: "sub",
    params: [lenParam(14), { key: "k", label: "%K 평활", def: 3, min: 1, max: 50 }, { key: "d", label: "%D 평활", def: 3, min: 1, max: 50 }],
    color: "#5ec8d8",
    make(ctx, inst) {
      const p = inst.params;
      const pane = ctx.newPane();
      const f2 = { type: "price", precision: 2, minMove: 0.01 };
      const k = ctx.addLine(pane, { color: inst.color, lineWidth: 1, priceFormat: f2 });
      const d = ctx.addLine(pane, { color: "#ff8a3d", lineWidth: 1, priceFormat: f2 });
      k.createPriceLine({ price: 80, color: hexA(upColor(), 0.6), lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
      k.createPriceLine({ price: 20, color: hexA(downColor(), 0.7), lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
      let r = { k: [], d: [] };
      return {
        series: [k, d],
        render(bars, from) {
          r = C.stoch(bars, p.length, p.k, p.d);
          paintLine(k, bars, r.k, ctx.time, from);
          paintLine(d, bars, r.d, ctx.time, from);
        },
        legend: (i) => [
          { label: `Stoch ${p.length} ${p.k} ${p.d}  %K`, value: r.k[i] == null ? "—" : r.k[i].toFixed(2), color: inst.color },
          { label: "%D", value: r.d[i] == null ? "—" : r.d[i].toFixed(2), color: "#ff8a3d" },
        ],
      };
    },
  },
  atr: {
    short: "ATR",
    pane: "sub",
    params: [lenParam(14)],
    color: "#ff8a3d",
    make(ctx, inst) {
      const pane = ctx.newPane();
      const s = ctx.addLine(pane, { color: inst.color, lineWidth: 1, priceFormat: { type: "price", precision: ctx.decimals, minMove: 1 / 10 ** ctx.decimals } });
      let vals = [];
      return {
        series: [s],
        render(bars, from) {
          vals = C.atr(bars, inst.params.length);
          paintLine(s, bars, vals, ctx.time, from);
        },
        legend: (i) => [{ label: `ATR ${inst.params.length}`, value: ctx.fmt(vals[i]), color: inst.color }],
      };
    },
  },
  drawdown: {
    short: "DD",
    pane: "sub",
    params: [],
    color: "#3d8bff",
    make(ctx, inst) {
      const pane = ctx.newPane();
      const s = ctx.addArea(pane, {
        lineColor: inst.color,
        topColor: "rgba(61,139,255,0.05)",
        bottomColor: "rgba(61,139,255,0.35)",
        lineWidth: 1,
        invertFilledArea: true,
        priceFormat: { type: "custom", formatter: (v) => `${v.toFixed(1)}%`, minMove: 0.1 },
      });
      let vals = [];
      return {
        series: [s],
        render(bars, from) {
          vals = C.drawdown(bars);
          paintLine(s, bars, vals, ctx.time, from);
        },
        legend: (i) => [{ label: "Drawdown", value: vals[i] == null ? "—" : `${vals[i].toFixed(1)}%`, color: inst.color }],
      };
    },
  },
  disparity: {
    short: "Disparity",
    pane: "sub",
    params: [lenParam(200)],
    color: "#9ad04a",
    make(ctx, inst) {
      const pane = ctx.newPane();
      const s = ctx.addLine(pane, { color: inst.color, lineWidth: 1, priceFormat: { type: "custom", formatter: (v) => `${v.toFixed(1)}%`, minMove: 0.1 } });
      s.createPriceLine({ price: 0, color: "rgba(160,166,174,0.5)", lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
      let vals = [];
      return {
        series: [s],
        render(bars, from) {
          vals = C.disparity(bars, inst.params.length);
          paintLine(s, bars, vals, ctx.time, from);
        },
        legend: (i) => [{ label: `Disparity ${inst.params.length}`, value: vals[i] == null ? "—" : `${vals[i].toFixed(2)}%`, color: inst.color }],
      };
    },
  },
};

/** VWAP처럼 세션마다 새로 시작하는 선: 날짜가 바뀌는 첫 봉은 비워서 선이 이어지지 않게 */
function paintSessionLine(series, bars, vals, ctx, from) {
  const pts = [];
  let key = null;
  const start = from ? Math.max(0, from) : 0;
  if (!from) {
    for (let i = 0; i < bars.length; i++) {
      const k = ctx.dayKey(bars[i].t);
      const t = ctx.time(bars[i].t);
      if (k !== key && key !== null) pts.push({ time: t });
      else if (vals[i] != null) pts.push({ time: t, value: vals[i] });
      key = k;
    }
    series.setData(pts);
    return;
  }
  for (let i = start; i < bars.length; i++) if (vals[i] != null) series.update({ time: ctx.time(bars[i].t), value: vals[i] });
}

/**
 * 하루(세션)마다 가로 구간선 만들기. make(prevDay, curDay, day) → [{price,color,label,dash}]
 * day = {from, to, h, l, c, pre:{h,l}|null}
 */
function dayLevels(bars, ctx, make) {
  const days = [];
  let cur = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const k = ctx.dayKey(b.t);
    if (!cur || cur.key !== k) {
      cur = { key: k, from: i, to: i, h: -Infinity, l: Infinity, c: b.c, pre: null };
      days.push(cur);
    }
    cur.to = i;
    if (ctx.isRegular(b.t)) {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c;
    } else if (ctx.isPre(b.t)) {
      cur.pre ??= { h: -Infinity, l: Infinity };
      if (b.h > cur.pre.h) cur.pre.h = b.h;
      if (b.l < cur.pre.l) cur.pre.l = b.l;
    }
  }
  const segs = [];
  days.forEach((d, i) => {
    const prev = days[i - 1];
    const prevOk = prev && prev.h > -Infinity ? prev : null;
    const last = i === days.length - 1;
    const named = i >= days.length - 3; // 글자는 최근 3일만 (축소하면 지저분해서)
    for (const s of make(prevOk, d, d)) segs.push({ ...s, label: named ? s.label : "", from: d.from, to: last ? null : d.to });
  });
  return segs;
}

/** #rrggbb → rgba */
export function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** 지표 설정 기본값 채우기 */
export function withDefaults(inst, k = 0) {
  const def = INDICATORS[inst.id];
  if (!def) return null;
  const params = {};
  for (const p of def.params) params[p.key] = inst.params?.[p.key] ?? p.def;
  return { uid: inst.uid ?? `${inst.id}-${Math.random().toString(36).slice(2, 8)}`, id: inst.id, params, color: inst.color ?? (k ? PALETTE[k % PALETTE.length] : def.color), width: inst.width ?? 1, hidden: !!inst.hidden };
}

/** 지표 목록 화면 순서 */
export const ORDER = ["sma", "ema", "mtfma", "dualma", "vwma", "bb", "vwbb", "volume", "rvol", "rsi", "rsi_div", "macd", "stoch", "atr", "drawdown", "disparity", "fractals", "hl52", "triangle_auto", "vwap", "vpvr", "orb", "pdhl", "pivots"];
