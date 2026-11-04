// 시험 (SPEC Phase 3·5): 지표 계산이 교과서·TradingView 정의와 같은지, 백테스트가 손계산과 센트 단위까지 같은지
import * as C from "../indicators/calc.js";
import { runDca, fxLookup, xirr } from "../backtest/engine.js";
import { loadSeries } from "../core/series.js";
import { describe } from "../core/symbols.js";
import * as db from "../core/db.js";

const out = document.getElementById("out");
let pass = 0;
let fail = 0;
const section = (name) => out.insertAdjacentHTML("beforeend", `<h2>${name}</h2>`);
function check(name, got, want, tol = 1e-9) {
  const a = [].concat(got);
  const b = [].concat(want);
  const ok = a.length === b.length && a.every((x, i) => (x == null && b[i] == null) || (x != null && b[i] != null && Math.abs(x - b[i]) <= tol));
  ok ? pass++ : fail++;
  const fmt = (v) => [].concat(v).map((x) => (x == null ? "—" : +x.toFixed(6))).join(", ");
  out.insertAdjacentHTML("beforeend", `<div class="row ${ok ? "ok" : "bad"}">${name}${ok ? "" : `<br><span class="muted">얻음: ${fmt(got)}<br>기대: ${fmt(want)}</span>`}</div>`);
}

// ── 지표 ──
section("지표 (TradingView Pine 정의)");
const s10 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
check("SMA 3", C.sma(s10, 3), [null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
check("EMA 3 (첫 값은 SMA로 시작)", C.ema(s10, 3), [null, null, 2, 3, 4, 5, 6, 7, 8, 9]);
const bars5 = [1, 2, 3, 4, 5].map((c) => ({ o: c, h: c, l: c, c, v: 1 }));
const bb = C.bollinger(bars5, 5, 2);
check("Bollinger 5·2 위 (모표준편차)", bb.upper[4], 3 + 2 * Math.SQRT2);
check("VWMA 2", C.vwma([{ c: 10, v: 1 }, { c: 20, v: 3 }], 2)[1], 17.5);
// Wilder RSI 교과서 예 (StockCharts 표: 70.53 66.32 66.55 … — 표는 중간값을 반올림해서 ±0.07 차이)
const wilder = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13];
const rsi = C.rsi(wilder.map((c) => ({ c })), 14).slice(14).map((v) => +v.toFixed(2));
check("RSI 14 (Wilder 교과서 예, 정확한 계산)", rsi, [70.46, 66.25, 66.48, 69.35, 66.29, 57.92, 62.88, 63.21, 56.01, 62.34, 54.67, 50.39, 40.02, 41.49, 41.9, 45.5, 37.32, 33.09, 37.79], 0.005);
check("RSI 14 ≈ StockCharts 표 (±0.1)", rsi, [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.3, 33.08, 37.77], 0.1);
check("Drawdown %", C.drawdown([10, 12, 9, 12, 6].map((c) => ({ c, h: c }))), [0, 0, -25, 0, -50]);
const tr = C.trueRange([{ h: 10, l: 8, c: 9 }, { h: 12, l: 9, c: 11 }, { h: 11, l: 7, c: 8 }]);
check("True Range", tr, [2, 3, 4]);
const fr = C.fractals([1, 2, 5, 2, 1, 2, 0.5, 2, 3].map((x) => ({ h: x, l: x })), 2);
check("Williams Fractals 고점", fr.up, [2]);
check("Williams Fractals 저점", fr.down, [6]);
{
  // 꼭짓점: 왼쪽은 확실히 높아야(낮아야), 오른쪽은 같아도 됨 → 같은 값이 이어지면 왼쪽 것 (TradingView ta.pivothigh)
  const pv = C.pivots([1, 3, 3, 1, 0, 0], 1, 1);
  check("꼭짓점 같은 값: 고점은 왼쪽 것 [1], 저점 [4]", [...pv.hi, ...pv.lo], [1, 4]);
  // RSI 다이버전스: 가격 저가 10 → 9 (더 낮음), RSI 바닥 30 → 35 (더 높음) = 상승
  const KIND = ["bull", "hbull", "bear", "hbear"];
  const enc = (ds) => [ds.length, ...ds.flatMap((d) => [d.a, d.b, KIND.indexOf(d.kind)])];
  const osc1 = [50, 40, 30, 40, 50, 45, 35, 45, 50];
  const b1 = osc1.map((_, i) => ({ h: 20, l: i === 2 ? 10 : i === 6 ? 9 : 15 }));
  const o = { left: 2, right: 2, minGap: 1, maxGap: 60 };
  check("RSI 다이버전스 상승: 2번·6번 바닥", enc(C.divergences(b1, osc1, o)), [1, 2, 6, 0]);
  check("RSI 다이버전스: 두 꼭짓점 사이(3봉)가 최소보다 짧으면 없음", enc(C.divergences(b1, osc1, { ...o, minGap: 4 })), [0]);
  // 가격 고가 20 → 19 (더 낮음), RSI 꼭대기 70 → 75 (더 높음) = 히든 하락
  const osc2 = [50, 60, 70, 60, 50, 55, 75, 55, 50];
  const b2 = osc2.map((_, i) => ({ h: i === 2 ? 20 : i === 6 ? 19 : 10, l: 5 }));
  check("RSI 다이버전스 히든 하락: 2번·6번 꼭대기", enc(C.divergences(b2, osc2, o)), [1, 2, 6, 3]);
}
check("RVOL 3 (이 봉 ÷ 앞 3봉 평균)", C.rvol([10, 10, 10, 30].map((v) => ({ v })), 3), [null, null, null, 3]);
{
  const D = 86400;
  const rb = [{ t: 0, v: 10 }, { t: 60, v: 20 }, { t: D, v: 5 }, { t: D + 60, v: 30 }];
  check("RVOL at Time 1일 (같은 시각까지 누적끼리)", C.rvolAtTime(rb, 1, (t) => Math.floor(t / D), (t) => t % D), [null, null, 0.5, 35 / 30], 1e-9);
}
const piv = C.pivotLevels(110, 90, 100);
check("Pivot Points (P R1 S1 R2 S2)", [piv.P, piv.R1, piv.S1, piv.R2, piv.S2], [100, 110, 90, 120, 80]);
const day = 86400;
check("XIRR: 1년 뒤 10% → 10%", xirr([[0, -1000], [365 * day, 1100]]), 0.1, 1e-9);

// ── QA 회귀 시험 ──
{
  // #2 MTF: 상위 봉(예: 일봉)이 끝나기 전에는 직전 상위 봉 값, 그 상위 봉의 마지막 아래 봉에서야 그 값
  const { mapHtf } = await import("../indicators/index.js");
  const low = [0, 1, 2, 10, 11, 12].map((t) => ({ t }));
  const htf = [{ t: 0 }, { t: 10 }];
  const key = { htfKey: (t) => t, replaying: false };
  check("MTF 미래 값 안 씀: [없음, 없음, A, A, A, B(진행 중 = 맨 끝만)]", mapHtf(low, htf, ["A", "B"].map((x) => (x === "A" ? 1 : 2)), key), [null, null, 1, 1, 1, 2]);
  check("MTF 리플레이 중에는 맨 끝도 끝난 봉 값만", mapHtf(low, htf, [1, 2], { ...key, replaying: true }), [null, null, 1, 1, 1, 1]);
  // 0.16.0: 리플레이 시각이 그 상위 봉의 끝(10~20 → 20)을 지났으면 끝난 봉이니 그 값. 정각에 멈춘 "⏭ 한 칸"에서 한 칸 늦던 것
  check("MTF 리플레이: 상위 봉이 아직 진행 중(13) → 직전 값 / 정각(20)에 끝남 → 그 값", [mapHtf(low, htf, [1, 2], { ...key, replaying: true, endT: 13, span: 10 })[5], mapHtf(low, htf, [1, 2], { ...key, replaying: true, endT: 20, span: 10 })[5]], [1, 2]);

  // 0.16.0 기준 봉 비교 · 멀티 이평 (사용자 아이디어 "5분봉에서 1시간·4시간·일봉 이평을 한 번에")
  const { tfMode, maOrder, distPct, INDICATORS: IND, withDefaults: wd } = await import("../indicators/index.js");
  const yes = (v) => (v ? 1 : 0);
  check("기준 봉: 비움·같음 → 차트 봉 / 큰 봉 → 계단 / 작은 봉 → 숨김", [tfMode("", "5m"), tfMode("5m", "5m"), tfMode("1h", "5m"), tfMode("1W", "1D"), tfMode("1h", "4h")].map((x, k) => yes(x === ["same", "same", "htf", "htf", "lower"][k])), [1, 1, 1, 1, 1]);
  check("이평 배열: 정배열·역배열·섞임·값 하나면 없음", [maOrder([{ span: 3, v: 1 }, { span: 1, v: 3 }, { span: 2, v: 2 }]), maOrder([{ span: 1, v: 1 }, { span: 2, v: 2 }, { span: 3, v: 3 }]), maOrder([{ span: 1, v: 3 }, { span: 2, v: 1 }, { span: 3, v: 2 }]), maOrder([{ span: 1, v: 3 }, { span: 2, v: null }])].map((x, k) => yes(x === ["up", "down", "mix", null][k])), [1, 1, 1, 1]);
  check("선까지 거리 %: 110 vs 100 → +10, 값 없으면 없음", [distPct(110, 100), distPct(90, 100), distPct(110, null)], [10, -10, null]);
  check("멀티 이평 처음 기간: 15분 20 · 1시간 20 · 4시간 20 · 일봉 200, 주봉은 꺼짐, 화면 안 늘림 켬", (() => { const q = wd({ id: "mtfma" }).params; return [q.len_15m, q.len_1h, q.len_4h, q.len_1D, yes(q.on_1D), yes(q.on_1W), yes(q.fit)]; })(), [20, 20, 20, 200, 1, 0, 1]);
  // 가짜 차트 칸: 5분봉 36개(3시간, 종가 = 0, 1, 2 …) + 1시간봉 3개(종가 11, 23, 35)
  const fakeCtx = (tf, htfs) => {
    const series = [];
    const ctx = {
      tf,
      replaying: false,
      time: (t) => t,
      tfName: (t) => `${t}봉`,
      fmt: (v) => (v == null ? "—" : v.toFixed(2)),
      addLine(_, o) {
        const s = { o, data: [], setData(d) { this.data = d; }, update(pt) { this.data.push(pt); } };
        series.push(s);
        return s;
      },
      htf: (t) => htfs[t] ?? null,
      htfKeyOf: () => (x) => x,
    };
    return { ctx, series };
  };
  const b5 = Array.from({ length: 36 }, (_, k) => ({ t: k * 300, o: k, h: k, l: k, c: k }));
  const h1 = [11, 23, 35].map((c, k) => ({ t: k * 3600, o: c, h: c, l: c, c }));
  const only1h = { on_15m: false, on_1h: true, len_1h: 2, on_4h: false, on_1D: false, on_1W: false, kind: "sma", tags: true, shape: "step" };
  {
    const { ctx, series } = fakeCtx("5m", { "1h": h1 });
    const hd = IND.mtfma.make(ctx, { params: only1h, color: "#f5c542", width: 1 });
    hd.render(b5, 0);
    const d = series[0].data;
    // 1시간 SMA 2 = [없음, 17, 29] → 두 번째 시간의 마지막 5분봉(23번째)부터 17, 맨 끝(진행 중)은 29
    check("멀티 이평 5분봉 위 1시간 SMA 2: 계단 (끝난 1시간봉 값만)", [d.length, d[0].time, d[0].value, d[11].value, d[12].value], [13, 23 * 300, 17, 17, 29]);
    check("멀티 이평 눈금 이름표 켜짐", yes(series[0].o.lastValueVisible && series[0].o.title === "1시간 2"), 1);
    const lg = hd.legend(35);
    check("멀티 이평 범례: 이름 · 거리 % (35 vs 29)", [yes(lg[0].label === "1시간 2"), +lg[0].more.text.replace("%", "")], [1, 20.69], 0.005);
  }
  {
    // 0.17.0 매끄럽게 (처음 값): 5분봉마다 (끝난 1시간봉 1개 + 지금 5분봉 종가) ÷ 2. 둘째 시간 첫 봉(12) = (11+12)/2 = 11.5,
    // 그 시간 끝 봉(23) = (11+23)/2 = 17 = 계단 값, 맨 끝(35) = (23+35)/2 = 29. 첫 시간은 끝난 봉이 없어서 비움
    const { ctx, series } = fakeCtx("5m", { "1h": h1 });
    const hd = IND.mtfma.make(ctx, { params: { ...only1h, shape: "smooth" }, color: "#f5c542", width: 1 });
    hd.render(b5, 0);
    const d = series[0].data;
    check("멀티 이평 매끄럽게: 5분봉마다 (끝난 1시간봉 + 지금 가격) — 12번째 11.5 · 23번째 17(계단과 같음) · 맨 끝 29", [d.length, d[0].time, d[0].value, d[11].value, d[23].value], [24, 12 * 300, 11.5, 17, 29]);
    const e = fakeCtx("5m", { "1h": h1 });
    const he = IND.mtfma.make(e.ctx, { params: { ...only1h, shape: "smooth", kind: "ema" }, color: "#f5c542", width: 1 });
    he.render(b5, 0);
    // EMA 2 (α = 2/3): 1시간 EMA = [없음, 17(첫 값은 SMA), 29] → 셋째 시간 봉 c: 17 + 2/3 × (c − 17), 맨 끝 35 → 29 (= EMA 확정 값)
    const de = e.series[0].data;
    check("멀티 이평 매끄럽게 EMA: 셋째 시간 첫 봉(24) 17 + 2/3×7 · 맨 끝 29", [de.length, de[0].value, de[11].value], [12, 17 + (2 / 3) * 7, 29], 1e-9);
    check("멀티 이평 처음 모양 = 매끄럽게", wd({ id: "mtfma" }).params.shape === "smooth" ? 1 : 0, 1);
  }
  {
    const { ctx, series } = fakeCtx("4h", { "1h": h1 });
    const hd = IND.mtfma.make(ctx, { params: only1h, color: "#f5c542", width: 1 });
    hd.render(b5, 0);
    check("멀티 이평: 차트(4시간)보다 작은 1시간 줄은 숨김", [series[0].data.length, yes(/큰 줄이 없어요/.test(hd.legend(0)[0].value))], [0, 1]);
  }
  {
    // 화면 안 늘림: 켜면 자동 눈금에서 뺀다(autoscaleInfoProvider → null), 끄면 라이브러리 기본(선까지 넣음)
    const on = fakeCtx("5m", { "1h": h1 });
    IND.mtfma.make(on.ctx, { params: { ...only1h, fit: true }, color: "#f5c542", width: 1 });
    const off = fakeCtx("5m", { "1h": h1 });
    IND.mtfma.make(off.ctx, { params: { ...only1h, fit: false }, color: "#f5c542", width: 1 });
    check("멀티 이평 '선 때문에 화면 안 늘림': 켬 → 눈금 계산에서 뺌, 끔 → 기본", [yes(on.series[0].o.autoscaleInfoProvider?.() === null), yes(!("autoscaleInfoProvider" in off.series[0].o))], [1, 1]);
  }
  {
    // 0.16.0 브러시 색·두께 (사용자: "브러시 색깔이랑 두께 설정 못 함?"): 처음 주황 2px · 고른 것 · 이상한 값이면 처음 값
    const { brushStyle, BRUSH_WIDTHS } = await import("../drawings/layer.js");
    const a = brushStyle({ chart: {} });
    const b = brushStyle({ chart: { brush: { color: "#3d8bff", width: 5 } } });
    const c = brushStyle({ chart: { brush: { color: "파랑", width: 9 } } });
    check("브러시: 처음 주황 2px · 파랑 5px 고르면 그대로 · 이상한 값은 처음 값 · 두께 1~5", [yes(a.color === "#ffb020" && a.width === 2), yes(b.color === "#3d8bff" && b.width === 5), yes(c.color === "#ffb020" && c.width === 2), BRUSH_WIDTHS.length], [1, 1, 1, 5]);
  }
  {
    const { ctx, series } = fakeCtx("4h", { "1h": h1 });
    const hd = IND.sma.make(ctx, { params: { length: 2, src: "c", tf: "1h" }, color: "#f5c542", width: 1 });
    hd.render(b5, 0);
    check("SMA 기준 봉 1시간인데 차트가 4시간 → 숨기고 범례에 알림 (예전엔 4시간 SMA로 몰래 바뀜)", [series[0].data.length, yes(/숨김/.test(hd.legend(0)[0].label))], [0, 1]);
  }
  // 오프닝 레인지: 9:30~9:45(15분) 고가·저가는 9:45 봉부터, 다음 날은 다시
  const at = (d, hh, mm) => d * 86400 + hh * 3600 + mm * 60;
  const ob = [[0, 9, 30, 10, 8], [0, 9, 35, 12, 9], [0, 9, 40, 11, 7], [0, 9, 45, 13, 10], [1, 9, 30, 20, 19], [1, 9, 45, 21, 18]].map(([d, hh, mm, hi, lo]) => ({ t: at(d, hh, mm), h: hi, l: lo }));
  const orr = C.openingRange(ob, 15, (t) => Math.floor(t / 86400), (t) => t % 86400, 9.5 * 3600);
  check("오프닝 레인지 15분: 고가 [-,-,-,12,-,20] · 저가 [-,-,-,7,-,19]", [...orr.hi, ...orr.lo], [null, null, null, 12, null, 20, null, null, null, 7, null, 19]);
  // #28 Stochastic: 고가 = 저가 구간은 값 없음 (TradingView)
  const flat = C.stoch([1, 1, 1].map((c) => ({ h: c, l: c, c })), 3, 1, 1);
  check("Stochastic 고가=저가 → 빈 값", flat.k[2], null);
}

// ── 범례의 실제 거래가: 맞춘 가격 ÷ k = 그날 실제 가격 ──
{
  const { adjust, weekly } = await import("../core/bars.js");
  const D = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;
  const rows = [{ t: D(2025, 11, 19), o: 100, h: 100, l: 100, c: 100.05, v: 10 }, { t: D(2025, 11, 20), o: 46, h: 47, l: 46, c: 46.45, v: 20 }];
  const adj = adjust(rows, { splits: [{ t: D(2025, 11, 20), r: 2 }], basis: "split" });
  const wk = weekly(adj);
  check("분할 전날: 차트 50.025 · 실제 100.05 / 분할한 날은 그대로 (k 없음)", [adj[0].c, adj[0].c / adj[0].k, adj[1].k ?? 1], [50.025, 100.05, 1]);
  check("주봉은 그 주 마지막 날 기준 (분할 뒤 → k 없음)", [wk.length, wk[0].k ?? 1], [1, 1]);
}

// ── 이동평균 소스 (0.14.0, TradingView source와 같게): 고가·저가·hl2·hlc3·ohlc4 → 듀얼 이동평균 밴드 = SMA(고가)·SMA(종가)·SMA(저가) ──
{
  const C = await import("../indicators/calc.js");
  const bars = [{ o: 10, h: 14, l: 8, c: 12 }, { o: 12, h: 16, l: 11, c: 15 }, { o: 15, h: 18, l: 13, c: 14 }];
  const s = (k) => C.source(bars, k)[1];
  const up = C.sma(C.source(bars, "h"), 2);
  const dn = C.sma(C.source(bars, "l"), 2);
  check("소스: 둘째 봉 종가15·시가12·고가16·저가11·hl2 13.5·hlc3 14·ohlc4 13.5 · SMA2 고가 끝 17 · 저가 끝 12", [s("c"), s("o"), s("h"), s("l"), s("hl2"), s("hlc3"), s("ohlc4"), up[2], dn[2]], [15, 12, 16, 11, 13.5, 14, 13.5, 17, 12]);
}

// ── 봉 색 한국식·미국식 (0.13.0): 기본 한국식 빨강 오름 → 미국식 초록 오름·빨강 내림 → 되돌리기 ──
{
  const K = await import("../core/colors.js");
  const kr = [K.upColor(), K.downColor()];
  K.setCandleStyle("us");
  const us = [K.upColor(), K.downColor(), K.tpColor()];
  K.setCandleStyle("kr");
  const got = [...kr, ...us, K.upColor(), K.rgba("#ff4d4f", 0.5)];
  const want = ["#ff4d4f", "#3d8bff", "#26a69a", "#ef5350", "#5ec8d8", "#ff4d4f", "rgba(255,77,79,0.5)"];
  check("봉 색: 한국식 빨강·파랑 → 미국식 초록·빨강(익절선 하늘색) → 한국식 · rgba (1 = 맞음)", got.map((x, i) => (x === want[i] ? 1 : 0)), want.map(() => 1));
}

// ── 30분봉 (FAKE TRADING 0.12.0): 미국 주식은 5분봉 6개를 정규장 09:30 기준으로 묶는다 ──
{
  const { aggregate, TF_SEC, TIMEFRAMES } = await import("../core/bars.js");
  const t0 = Date.UTC(2024, 0, 2, 14, 30) / 1000; // 2024-01-02 09:30 뉴욕
  const rows = Array.from({ length: 12 }, (_, i) => ({ t: t0 + i * 300, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 10 }));
  const m30 = aggregate(rows, TF_SEC["30m"], "America/New_York", 9.5 * 3600);
  check("30분봉: 09:30~10:25 5분봉 12개 → 09:30·10:00 두 개 · 첫 봉 시100 고106 저99 종105.5 거래량60 · 버튼 순서 15분 다음", [m30.length, (m30[1].t - t0) / 60, m30[0].o, m30[0].h, m30[0].l, m30[0].c, m30[0].v, TIMEFRAMES.indexOf("30m")], [2, 30, 100, 106, 99, 105.5, 60, 3]);
}

// ── 🆕 새 버전 받기 (0.15.0): 버전 비교 · Releases 본문 읽기 좋게 ──
{
  const U = await import("../ui/update.js");
  const n = (a, b) => (U.newer(a, b) ? 1 : 0);
  check("새 버전 비교: 0.15.0>0.14.1 · 0.10.0>0.9.9 · 1.0.0>0.99.99 · 같으면 아님 · 0.14.9 아님 · 0.16 아님 · 0.16.0-beta 아님 · 개발용 아님", [n("0.15.0", "0.14.1"), n("0.10.0", "0.9.9"), n("1.0.0", "0.99.99"), n("0.15.0", "0.15.0"), n("0.14.9", "0.15.0"), n("0.16", "0.15.0"), n("0.16.0-beta", "0.15.0"), n("0.15.0", "개발용")], [1, 1, 1, 0, 0, 0, 0, 0]);
  const t = U.notesText("## 0.15.0 — 2026-11-03\r\n더한 것\r\n- **새 버전 받기**: `update.rs`\r\n\r\n\r\n끝");
  check("바뀐 것 글자: 머리줄·굵게·코드 표시 빼고 빈 줄은 하나만 (1 = 맞음)", t === "0.15.0 — 2026-11-03\n더한 것\n- 새 버전 받기: update.rs\n\n끝" ? 1 : 0, 1);
}

// ── 수수료·세금 (손계산: 10달러 주식을 101달러씩, 수수료 1% → 매달 정확히 10주, 배당 1달러 중 15% 세금) ──
{
  const D = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;
  const bars = [D(2020, 1, 2), D(2020, 2, 3), D(2020, 2, 14), D(2020, 3, 2)].map((t) => ({ t, o: 10, h: 10, l: 10, c: 10, v: 1 }));
  const r = runDca({ bars, splits: [], events: [{ kind: "div", t: D(2020, 2, 14), a: 1 }] }, { start: { y: 2020, m: 1 }, end: { y: 2020, m: 3 }, monthly: 101, initial: 0, buyDay: "first", dividends: "accumulate", fractional: true, ccy: "USD", native: "USD", fx: null, lump: false, fee: 0.01, divTax: 0.15 });
  check("수수료 1%·배당세 15%: 수량 30주 · 평가금 317 · 수수료 3 · 세금 3", [r.summary.shares, r.summary.value, r.summary.fee, r.summary.tax], [30, 317, 3, 3], 1e-9);
}
{
  // 1주 단위 + 그 뒤 2:1 분할: 1월에 실제 20달러짜리를 30달러로 → 실제 1주(지금 기준 2주), 남은 10달러는 2월로
  const D = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;
  const bars = [D(2020, 1, 2), D(2020, 2, 3)].map((t) => ({ t, o: 10, h: 10, l: 10, c: 10, v: 1 }));
  const r = runDca({ bars, splits: [{ t: D(2020, 2, 3), r: 2 }], events: [] }, { start: { y: 2020, m: 1 }, end: { y: 2020, m: 2 }, monthly: 30, initial: 0, buyDay: "first", dividends: "accumulate", fractional: false, ccy: "USD", native: "USD", fx: null, lump: false });
  check("1주 단위는 그날 실제 가격으로: 1월 실제 1주 · 합계 지금 기준 6주 · 평가금 60", [r.buys[0].rawShares, r.summary.shares, r.summary.value], [1, 6, 60]);
}
{
  // 매주·요일마다: 2026-10-05(월) ~ 10-16(금) 2주, 10-07(수)은 쉬는 날
  const D = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;
  const days = [5, 6, 8, 9, 12, 13, 14, 15, 16].map((d) => D(2026, 10, d));
  const bars = days.map((t) => ({ t, o: 10, h: 10, l: 10, c: 10, v: 1 }));
  const run = (o) => runDca({ bars, splits: [], events: [] }, { start: { y: 2026, m: 10 }, end: { y: 2026, m: 10 }, monthly: 10, initial: 0, buyDay: "first", dividends: "accumulate", fractional: true, ccy: "USD", native: "USD", fx: null, lump: false, ...o });
  const dates = (r) => r.buys.map((b) => new Date(b.t * 1000).getUTCDate());
  check("매주 수요일 (첫 주 수요일이 쉬면 목요일)", dates(run({ freq: "weekly", weekday: 3 })), [8, 14]);
  check("요일마다 월·수 (쉬는 수요일은 건너뜀)", dates(run({ freq: "days", weekdays: [1, 3] })), [5, 12, 14]);
  check("매 영업일 (월~금 모두 = 거래일마다)", run({ freq: "days", weekdays: [1, 2, 3, 4, 5] }).summary.buys, 9);
}
{
  const { preferLive } = await import("../core/symbols.js");
  const ok = preferLive("BTC-USD") === "bn:BTCUSDT" && preferLive("QQQ") === "QQQ" && describe("^GSPC").label === "SPX" && describe("^NDX").label === "NDX";
  ok ? pass++ : fail++;
  out.insertAdjacentHTML("beforeend", `<div class="row ${ok ? "ok" : "bad"}">BTC-USD → Binance 실시간 · 지수 이름에서 ^ 빼기 (SPX, NDX)</div>`);
}

// ── CSV 가져오기 (SPEC §2.7): Yahoo 형식 · Investing 형식(따옴표·쉼표·M) ──
{
  const { parseCsv, guessSymbol } = await import("../core/csv.js");
  const y = parseCsv("Date,Open,High,Low,Close,Adj Close,Volume\n2024-01-03,10,11,9,10.5,10.4,1000\n2024-01-02,9,10,8,9.5,9.4,2000\nnull,,,,,,\n");
  check("CSV Yahoo: 날짜 순서·종가·거래량·못 읽은 줄", [y.rows.length, y.rows[0].c, y.rows[1].v, y.skipped], [2, 9.5, 1000, 1]);
  const inv = parseCsv('"Date","Price","Open","High","Low","Vol.","Change %"\n"10/23/2026","1,234.50","1,200.00","1,250.00","1,190.00","1.2M","0.5%"\n');
  check("CSV Investing: 10/23/2026 · 1,234.50 · 1.2M", [inv.rows[0].t, inv.rows[0].c, inv.rows[0].v], [Date.UTC(2026, 9, 23) / 1000, 1234.5, 1.2e6]);
  const ok = guessSymbol("QQQ (1).csv") === "QQQ" && guessSymbol("005930.KS_daily.csv") === "005930.KS";
  ok ? pass++ : fail++;
  out.insertAdjacentHTML("beforeend", `<div class="row ${ok ? "ok" : "bad"}">CSV 파일 이름 → 종목 (QQQ (1).csv → QQQ)</div>`);
}

// ── 백테스트 (SPEC §4.5) ──
// 거래량 가중 볼린저 (VWBB): 손계산 — 종가 10·12·11, 거래량 1·3·2, 3봉, 2σ
// VWMA = 68/6 = 34/3, σ² = (1·16/9 + 3·4/9 + 2·1/9) ÷ 6 = 5/9 → σ = √5/3, 위·아래 = (34 ± 2√5)/3
{
  const r = C.vwbb([{ c: 10, v: 1 }, { c: 12, v: 3 }, { c: 11, v: 2 }], 3, 2);
  check("VWBB 손계산 (가운데·위·아래)", [r.basis[2], r.upper[2], r.lower[2]], [34 / 3, (34 + 2 * Math.sqrt(5)) / 3, (34 - 2 * Math.sqrt(5)) / 3], 1e-9);
  const flat = Array.from({ length: 60 }, (_, i) => ({ c: 100 + 10 * Math.sin(i / 5) + (i % 7), v: 5 }));
  const a = C.vwbb(flat, 20, 2);
  const b = C.bollinger(flat, 20, 2);
  check("거래량이 모두 같으면 VWBB = 볼린저 밴드", [a.upper[59], a.lower[59], a.upper[30]], [b.upper[59], b.lower[59], b.upper[30]], 1e-9);
  // TradingView vwBB(xinolia) Pine 코드를 그대로 옮긴 계산과 비교 (deviation band Mode 켬 = 아래 밴드 TV 방식)
  const bars = Array.from({ length: 80 }, (_, i) => ({ c: 50 + 5 * Math.sin(i / 4) + (i % 5) * 0.3, v: 1000 + ((i * 37) % 900) }));
  const pine = (i, len, k, tv) => {
    let pv = 0;
    let sv = 0;
    for (let j = 0; j < len; j++) (pv += bars[i - j].c * bars[i - j].v), (sv += bars[i - j].v);
    const basis = pv / sv; // vwma(src, length)
    let std = 0;
    for (let j = 0; j < len; j++) std += (bars[i - j].c - basis) ** 2 * bars[i - j].v;
    const dev = Math.sqrt(std / ((sv / len) * len)); // sqrt(std / (sma(vol, len) * len))
    return { up: basis + k * dev, dn: tv ? (basis * basis) / (basis + k * dev) : basis - k * dev };
  };
  const t1 = C.vwbb(bars, 20, 2, true);
  const t0 = C.vwbb(bars, 20, 2, false);
  check("TradingView vwBB 코드와 같음: 위 밴드 · 아래(TV 방식) · 아래(보통)", [t1.upper[79], t1.lower[79], t0.lower[79]], [pine(79, 20, 2, true).up, pine(79, 20, 2, true).dn, pine(79, 20, 2, false).dn], 1e-9);
  check("아래 밴드 예: 가운데 100, σ 5, 2배 → 보통 90 · TV 방식 90.909", [C.bandLower(100, 5, 2, false), C.bandLower(100, 5, 2, true)], [90, 10000 / 110], 1e-9);
}

section("백테스트 — 실제 거래가 + 분할 날 수량 조정으로 따로 계산한 값과 비교 (센트 단위)");
const ym = (t) => {
  const d = new Date(t * 1000);
  return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
};
/** 손계산: 실제 거래가로 사고, 분할 날 수량을 바꾸고, 배당락일에 전날 수량 × 실제 배당 */
async function hand(sym, from, to, monthly, reinvest, krw) {
  const raw = await db.getBars(sym, "1D", { limit: 200000 });
  const ev = await db.getEvents(sym);
  const splits = new Map(ev.filter((e) => e.kind === "split" && e.a > 0 && e.b > 0 && e.a !== e.b).map((e) => [e.t, e.a / e.b]));
  const divs = new Map(ev.filter((e) => e.kind === "div" && e.a > 0).map((e) => [e.t, e.a]));
  const fx = krw ? fxLookup(await db.getBars("KRW=X", "1D", { limit: 200000 })) : null;
  const rng = raw.filter((b) => ym(b.t) >= from && ym(b.t) <= to);
  const buy = new Set();
  const seen = new Set();
  for (const b of rng) if (!seen.has(ym(b.t))) (seen.add(ym(b.t)), buy.add(b.t));
  let sh = 0;
  let cash = 0;
  let last = null;
  for (const b of rng) {
    if (splits.has(b.t)) sh *= splits.get(b.t);
    if (divs.has(b.t)) {
      const amt = sh * divs.get(b.t);
      if (reinvest) sh += amt / b.c;
      else cash += amt;
    }
    if (buy.has(b.t)) sh += (krw ? monthly / fx(b.t).rate : monthly) / b.c;
    last = b;
  }
  return (sh * last.c + cash) * (krw ? fx(last.t).rate : 1);
}
async function app(sym, from, to, monthly, reinvest, krw) {
  const s = await loadSeries(describe(sym), "1D", { basis: "split" });
  const fx = krw ? fxLookup((await loadSeries(describe("KRW=X"), "1D", { basis: "raw" })).bars) : null;
  const r = runDca(s, { start: { y: Math.floor(from / 100), m: from % 100 }, end: { y: Math.floor(to / 100), m: to % 100 }, monthly, initial: 0, buyDay: "first", dividends: reinvest ? "reinvest" : "accumulate", fractional: true, ccy: krw ? "KRW" : "USD", native: "USD", fx, lump: false });
  return r.summary.value;
}
const CASES = [
  ["QQQ 2010-01~2010-12 매월 $100 · 배당 쌓아두기", "QQQ", 201001, 201012, 100, false, false],
  ["TQQQ 2020-10~2021-03 (2021-01-21 2:1 분할)", "TQQQ", 202010, 202103, 100, false, false],
  ["SQQQ 2024-09~2025-01 (1:5 병합)", "SQQQ", 202409, 202501, 100, false, false],
  ["QQQ 2024-01~2024-12 배당 재투자", "QQQ", 202401, 202412, 100, true, false],
  ["QQQ 2008-06~2008-12 원화 50만원 (환율 빈 구간 → 직전 환율)", "QQQ", 200806, 200812, 500000, false, true],
];
for (const [name, ...args] of CASES) {
  try {
    const [a, b] = await Promise.all([app(...args), hand(...args)]);
    check(`${name} → ${a.toFixed(2)}`, +a.toFixed(2), +b.toFixed(2), args[5] ? 1 : 0.01);
  } catch (e) {
    fail++;
    out.insertAdjacentHTML("beforeend", `<div class="row bad">${name}: 데이터가 없어요 (${e.message})</div>`);
  }
}

// ── 국내 주식 (SPEC §2.10) ──
section("국내 주식 — 검색·휴장일 봉·빈 날·장 시간");
{
  const { getStockList } = await import("../core/stocklist.js");
  const { makeQuery } = await import("../ui/search.js");
  const { dropHolidayFill, dataGaps } = await import("../core/series.js");
  const { marketOpen } = await import("../core/session.js");
  const list = await getStockList();
  const top = (text) => {
    const m = makeQuery(text);
    return list.filter((s) => m.test(s.idx)).sort((a, b) => m.score(a.idx) - m.score(b.idx))[0]?.id;
  };
  const same = (name, got, want) => {
    const ok = got === want;
    ok ? pass++ : fail++;
    out.insertAdjacentHTML("beforeend", `<div class="row ${ok ? "ok" : "bad"}">${name}${ok ? "" : ` <span class="muted">얻음 ${got} · 기대 ${want}</span>`}</div>`);
  };
  same("검색 '삼성' → 삼성전자", top("삼성"), "005930.KS");
  same("검색 초성 'ㅅㅅㅈㅈ' → 삼성전자", top("ㅅㅅㅈㅈ"), "005930.KS");
  same("검색 '코덱스 레버' → KODEX 레버리지", top("코덱스 레버"), "122630.KS");
  same("검색 '타이거 나스닥' → TIGER 미국나스닥100", top("타이거 나스닥"), "133690.KS");
  same("검색 '247540' → 에코프로비엠(코스닥)", top("247540"), "247540.KQ");
  same("검색 '엔비디아' → NVDA", top("엔비디아"), "NVDA");
  const d = 86400;
  const fill = dropHolidayFill([{ t: 0, o: 10, h: 11, l: 9, c: 10, v: 5 }, { t: d, o: 10, h: 10, l: 10, c: 10, v: 0 }, { t: 2 * d, o: 10, h: 12, l: 10, c: 11, v: 3 }]);
  check("휴장일 채움 봉(거래량 0·전날 종가 그대로) 빼기", fill.map((b) => b.t), [0, 2 * d]);
  const mon = Date.UTC(2026, 9, 5) / 1000; // 월요일
  check("빈 날: 2주 구멍(평일 9일) → 9일, 짧은 연휴(평일 2일)는 안 셈", dataGaps([{ t: mon }, { t: mon + 3 * d }, { t: mon + 7 * d }, { t: mon + 21 * d }]).days, 9);
  const kst = (dd, hh, mm) => Date.UTC(2026, 9, dd, hh - 9, mm) / 1000;
  const S = describe("005930.KS");
  check("장 시간: 금 09:30 열림 · 22:40 닫힘 · 토 10:00 닫힘", [marketOpen(S, kst(23, 9, 30)), marketOpen(S, kst(23, 22, 40)), marketOpen(S, kst(24, 10, 0))].map(Number), [1, 0, 0]);
}

section("상태 줄 — 다음 FOMC·CPI 계산");
{
  const E = await import("../core/events.js");
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    out.insertAdjacentHTML("beforeend", `<div class="row ${ok ? "ok" : "bad"}">${name}${ok ? "" : ` <span class="muted">얻음 ${JSON.stringify(got)} · 기대 ${JSON.stringify(want)}</span>`}</div>`);
  };
  const ny = E.parseNyFed({ refRates: [{ effectiveDate: "2026-09-17", percentRate: 3.88, targetRateFrom: 3.75, targetRateTo: 4.0 }, { effectiveDate: "2026-09-16", percentRate: 3.63, targetRateFrom: 3.5, targetRateTo: 3.75 }, { effectiveDate: "2026-09-15", percentRate: 3.63, targetRateFrom: 3.5, targetRateTo: 3.75 }, { effectiveDate: "2026-09-19", percentRate: 3.88, targetRateFrom: 3.75, targetRateTo: 4.0 }] });
  eq("뉴욕 연준 금리 읽기 (날짜순)", ny.map((r) => r.d), ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-19"]);
  const tar = ny.map((r) => [r.d, r.hi]);
  eq("직전 FOMC(9-16): 3.75 → 4.00 = 인상", E.lastDecision(tar, "2026-09-16")?.text, "인상");
  eq("다음 날 값이 아직 없으면 모름", E.lastDecision(tar, "2026-09-19"), null);
  eq("금리 변화 글자: 0 동결 · −0.25 인하 · −0.5 인하 0.50%p", [E.rateMove(0), E.rateMove(-0.25), E.rateMove(-0.5)], ["동결", "인하", "인하 0.50%p"]);
  eq("선물 기호: 2026년 11월 = ZQX26 · 13월 → 다음 해 1월", [E.zqOf(2026, 11), E.zqOf(2026, 13)], ["ZQX26.CBT", "ZQF27.CBT"]);
  // 10-28 회의(달 후반) → 11월 선물 96.095 = 3.905%, 지금 3.88% → +0.025%p → 동결 90%
  eq("달 후반 회의: 다음 달 선물로 → 동결 90%", E.oddsText(E.futuresDelta("2026-10-28", 3.88, 96.12, 96.095)), "동결 90%");
  // 12-09 회의(달 전반): 12월 평균 4.04%, 회의 전 9일은 3.905% → 회의 뒤 (4.04×31 − 3.905×9)/22 = 4.095 → +0.19%p → 인상 76%
  eq("달 전반 회의: 그 달 선물에서 회의 전 날수를 빼서 → 인상 76%", E.oddsText(E.futuresDelta("2026-12-09", 3.905, 95.96, 95.9)), "인상 76%");
  const cal = `<h4><a>2024 FOMC Meetings</a></h4><div class="row fomc-meeting"><div class="fomc-meeting__month col-xs-5"><strong>Apr/May</strong></div> <div class="fomc-meeting__date col-xs-4">30-1</div></div>
    <div class="row"><div class="fomc-meeting__month col"><strong>June</strong></div><div class="fomc-meeting__date col">11-12*</div></div>
    <h4><a>2025 FOMC Meetings</a></h4><div><div class="fomc-meeting__month c"><strong>August</strong></div><div class="fomc-meeting__date c">22 (notation vote)</div></div>
    <div><div class="fomc-meeting__month c"><strong>December</strong></div><div class="fomc-meeting__date c">9-10*</div></div>`;
  eq("연준 일정 페이지 읽기: Apr/May 30-1 → 5-01 · 표결만 하는 날 뺌", E.parseFedCalendar(cal), ["2024-05-01", "2024-06-12", "2025-12-10"]);
  const nc = E.nowcastOf([
    { chart: { subcaption: "2026-9" }, dataset: [{ seriesname: "CPI Inflation", data: [{ value: "3.6" }] }, { seriesname: "Actual CPI Inflation", data: [{ value: "" }, { value: "3.74" }] }, { seriesname: "Actual Core CPI Inflation", data: [{ value: "2.56" }] }] },
    { chart: { subcaption: "2026-10" }, dataset: [{ seriesname: "CPI Inflation", data: [{ value: "3.7" }, { value: "3.75" }, { value: "" }] }, { seriesname: "Core CPI Inflation", data: [{ value: "2.48" }] }, { seriesname: "Actual CPI Inflation", data: [{ value: "" }] }] },
  ]);
  eq("CPI 날짜 알림: 2026-10 (2027 있음) → 없음 · 2027-10 → 2028 넣기 · 2028-01 (표 끝남) → 2028", [E.cpiNeedYear(new Date(2026, 9, 25)), E.cpiNeedYear(new Date(2027, 9, 20)), E.cpiNeedYear(new Date(2028, 0, 5))], [null, 2028, 2028]);
  // 신고가·ORB 알림: 그날 처음 넘은 봉에서 울림 (QA N4 — 9:45 첫 돌파, 연속 신고가)
  const A = await import("../alerts/engine.js");
  const S = { x: [9, 11, 12, 13, 5, 13], lv: (i) => [null, null, 10, 10, null, 12][i], day: [1, 1, 1, 1, 2, 2] };
  const hiA = { kind: "dayhigh", op: "up" };
  eq("신고가 알림: 기준이 처음 생긴 봉(9:45)에서 바로 · 연속 신고가는 하루 한 번 · 다음 날 다시", [0, 1, 2, 3, 4, 5].map((i) => A.firstBreakAt(hiA, S, i)), [false, false, true, false, false, true]);
  const orbA = { kind: "ind", op: "down", ind: { id: "orbl" } };
  eq("ORB 아래 돌파: 그날 처음 ORL 아래로 내려간 봉", [A.isFirstBreak(orbA), A.firstBreakAt(orbA, { x: [10, 9, 8], lv: (i) => [null, 9.5, 9.5][i], day: [1, 1, 1] }, 1), A.firstBreakAt(orbA, { x: [10, 9, 8], lv: (i) => [null, 9.5, 9.5][i], day: [1, 1, 1] }, 2)], [true, true, false]);
  // 실시간 현재가로 분봉 끝 고치기: 같은 칸이면 고치고, 다음 칸이면 새 봉 (1분봉 차트가 한 칸 늦던 문제)
  {
    const B = await import("../core/bars.js");
    const T0 = Date.UTC(2026, 9, 27, 14, 44) / 1000; // 뉴욕 10:44
    const list = [{ t: T0 - 60, o: 95, h: 96, l: 95, c: 96, v: 10 }, { t: T0, o: 96, h: 96.1, l: 95.9, c: 96.04, v: 5 }];
    const same = B.applyLiveQuote(list, { price: 96.2, ts: T0 + 30 }, 60, "America/New_York", 9.5 * 3600);
    const next = B.applyLiveQuote(list, { price: 96.15, ts: T0 + 95 }, 60, "America/New_York", 9.5 * 3600);
    const far = B.applyLiveQuote(list, { price: 97, ts: T0 + 3 * 3600 }, 60, "America/New_York", 9.5 * 3600);
    const old = B.applyLiveQuote(list, { price: 90, ts: T0 - 30 }, 60, "America/New_York", 9.5 * 3600);
    eq("실시간 현재가: 같은 1분 안이면 마지막 봉 종가·고가를 고침", [same.length, same[1].c, same[1].h], [2, 96.2, 96.2]);
    eq("실시간 현재가: 다음 1분이면 그 칸(10:45)에 새 봉을 연다", [next.length, next[2].t - T0, next[2].o, next[2].c], [3, 60, 96.15, 96.15]);
    eq("실시간 현재가: 3시간 떨어졌거나 지난 시각이면 그대로", [far === list, old === list], [true, true]);
  }
  let emptyOk = true;
  try {
    describe(null);
  } catch {
    emptyOk = false;
  }
  eq("빈 칸(종목 null)으로 저장돼 있어도 칸 만들기가 멈추지 않음 (켤 때 화면 멈춤 버그)", emptyOk, true);
  eq("클리블랜드: 10월 예측(마지막 값) + 9월 실제", [nc.y, nc.m, nc.cpi, nc.core, nc.actual.m, nc.actual.cpi, nc.actual.core], [2026, 10, 3.75, 2.48, 9, 3.74, 2.56]);
}

// ── 💰 모의매매 가상 체결 (web/trade/engine.js, 기획서 §6·§12) ──
section("모의매매 체결 규칙 (기획서 §6·§12)");
{
  const E = await import("../trade/engine.js");
  const r0 = E.rules({ fee_taker: 0, fee_maker: 0, slip: 0, tp_pct: 0.5, sl_pct: 0.25 });
  const L = { side: 1, entry: 100, tp: 101, sl: 99.5 };
  const S = { side: -1, entry: 100, tp: 99, sl: 100.5 };
  // 결과 → [체결 가격, 1=익절 2=손절] (안 걸리면 [0, 0])
  const x = (p, o, hi, lo, r = r0, brk = false) => {
    const v = E.exitOnBar(p, { o, h: hi, l: lo, c: o, brk }, r);
    return v ? [v.price, v.why === "tp" ? 1 : 2] : [0, 0];
  };
  check("롱 익절: 익절가에 닿기만 하면 안 걸림 (한 틱 넘어야)", x(L, 100.5, 101, 100.2), [0, 0]);
  check("롱 익절: 한 틱 넘으면 익절가로", x(L, 100.5, 101.01, 100.2), [101, 1]);
  check("롱 손절: 손절가에 닿으면 손절가로", x(L, 100, 100.4, 99.5), [99.5, 2]);
  check("롱: 한 봉에서 둘 다 닿으면 손절 먼저", x(L, 100, 102, 99), [99.5, 2]);
  check("롱: 시가가 손절선 아래로 건너뛰면(갭) 시가로", x(L, 99, 99.2, 98.5), [99, 2]);
  // 0.16.0 (사용자 결정): 걸어 둔 익절(지정가)은 장중 갭이면 익절가 그대로, 거래가 끊겼다 다시 시작된 첫 봉(장 시작·주말 뒤)만 시가
  check("롱: 장중에 시가가 익절선 위로 건너뛰면 익절가 그대로 (걸어 둔 지정가가 먼저 체결)", x(L, 101.5, 102, 101.2), [101, 1]);
  check("롱: 장 시작 첫 봉(밤사이 갭)에 익절선 위로 열리면 시가로", x(L, 101.5, 102, 101.2, r0, true), [101.5, 1]);
  check("롱: 손절 갭은 장중이든 장 시작이든 시가로 (불리하게)", [...x(L, 99, 99.2, 98.5), ...x(L, 99, 99.2, 98.5, r0, true)], [99, 2, 99, 2]);
  check("숏 익절: 닿기만 하면 안 걸림 · 한 틱 넘으면 익절가로", [...x(S, 99.5, 99.8, 99), ...x(S, 99.5, 99.8, 98.99)], [0, 0, 99, 1]);
  check("숏 손절: 손절가에 닿으면 손절가로", x(S, 100, 100.5, 99.8), [100.5, 2]);
  check("숏: 한 봉에서 둘 다 닿으면 손절 먼저", x(S, 100, 101, 98), [100.5, 2]);
  check("숏: 갭 위로 → 손절 시가 · 장중 갭 아래로 → 익절가 99 · 장 시작 갭 아래로 → 익절 시가", [...x(S, 101, 101.2, 100.8), ...x(S, 98.5, 98.7, 98.2), ...x(S, 98.5, 98.7, 98.2, r0, true)], [101, 2, 99, 1, 98.5, 1]);
  check("손절은 시장가 → 미끄러짐 0.1% (롱 99.5 → 99.4005)", x(L, 100, 100.2, 99.4, E.rules({ slip: 0.1 }))[0], 99.4005, 1e-9);
  const r = E.rules({ fee_taker: 0.09, fee_maker: 0.03, slip: 0.01, tp_pct: 0.5, sl_pct: 0.25 });
  const p = E.open({ side: 1, price: 100, margin: 1000, lev: 1, t: 0, tick: 0.01, r });
  check("시장가 진입: 미끄러짐 0.01% → 평단 100.01 · 수량 9.999 · 익절 +0.5% 100.51 · 손절 −0.25% 99.76", [p.entry, p.qty, p.tp, p.sl], [100.01, 9.999, 100.51, 99.76]);
  const q = { side: 1, qty: 10, entry: 100, fee: 100 * 10 * 0.0009, tp: 101, sl: 99, hi: 100, lo: 100 };
  check("손익: 롱 10주 100 → 101 익절 = 10 − 들어올 때 0.9 − 나갈 때(지정가 0.03%) 0.303 = 8.797", E.netAt(q, 101, "tp", r), 8.797, 1e-9);
  const tr = E.close(q, { price: 99, why: "sl", t: 60, sym: "T", r });
  check("손절 기록: 손익 −10 − 수수료 1.791 = −11.791 · 손익비 1", [tr.net, tr.fees, tr.rr], [-11.791, 1.791, 1], 1e-9);
  check("선 끌기 제한: 롱 익절을 현재가 아래로 → 현재가+1틱 · 롱 손절을 위로 → 현재가−1틱", [E.clampLevel("tp", 99, L, 100.5, 0.01), E.clampLevel("sl", 101, L, 100.5, 0.01)], [100.51, 100.49]);
  check("선 끌기 제한: 숏 익절을 위로 → 현재가−1틱 · 숏 손절을 아래로 → 현재가+1틱", [E.clampLevel("tp", 101, S, 99.5, 0.01), E.clampLevel("sl", 99, S, 99.5, 0.01)], [99.49, 99.51]);
  const st = E.stats([10, -5, 20, -5].map((net, i) => ({ net, t1: i })));
  check("통계: 승률 50% · 합계 20 · 평균 이익/손실 3 · 최대 낙폭 −5", [st.winRate, st.net, st.payoff, st.maxDD], [0.5, 20, 3, -5]);

  // 레버리지·청산 (격리, 최대 20배 → 유지증거금 2.5%) · 분할 매수 · 일부 정리 (사용자 요청 2026-10-30)
  const rl = E.rules({ fee_taker: 0.09, fee_maker: 0.03, slip: 0, max_lev: 20 });
  const p10 = E.open({ side: 1, price: 100, margin: 100, lev: 10, t: 0, tick: 0.01, r: rl });
  check("10배 롱: 증거금 $100 → 10주 · 청산가 (100 − 10) ÷ 0.975 = 92.31", [p10.qty, p10.margin, p10.liq], [10, 100, 90 / 0.975], 1e-9);
  const s10 = E.open({ side: -1, price: 100, margin: 100, lev: 10, t: 0, tick: 0.01, r: rl });
  check("10배 숏: 청산가 (100 + 10) ÷ 1.025 = 107.32 · 1배 롱은 청산 없음", [s10.liq, E.open({ side: 1, price: 100, margin: 1000, lev: 1, t: 0, tick: 0.01, r: rl }).liq ?? 0], [110 / 1.025, 0], 1e-9);
  const p375 = E.open({ side: 1, price: 100, margin: 100, lev: 3.75, t: 0, tick: 0.01, r: rl });
  check("3.75배 롱 (직접 넣은 배율, 0.8.0): 증거금 $100 → 3.75주 · 청산가 (100 − 26.67) ÷ 0.975 = 75.21", [p375.qty, p375.margin, p375.liq], [3.75, 100, (100 - 100 / 3.75) / 0.975], 1e-9);
  const xl = (sl) => E.exitOnBar({ ...p10, sl }, { o: 99, h: 99.5, l: 91, c: 92 }, rl);
  check("청산가가 손절보다 먼저 닿으면 강제 청산 · 손절이 더 가까우면 손절", [xl(90).why === "liq" ? 1 : 0, xl(90).price, xl(95).why === "sl" ? 1 : 0], [1, 90 / 0.975, 1], 1e-9);
  const pa = E.open({ side: 1, price: 100, margin: 100, lev: 10, t: 0, tick: 0.01, r: rl });
  const qa = E.add(pa, { price: 110, margin: 100, lev: 10, tick: 0.01, r: rl });
  check("분할 매수: 100에 10주 + 110에 9.09주 → 평단 104.76 · 증거금 199.99 · 배율 그대로 10", [qa, pa.qty, pa.entry, pa.margin, pa.lev], [9.09, 19.09, 1999.9 / 19.09, 199.99, 10], 1e-9);
  const pr = { side: 1, qty: 10, entry: 100, fee: 0.9, margin: 100, marginIn: 100, lev: 10, tp: 120, sl: 95, hi: 100, lo: 100, t: 0 };
  const n1 = E.reduce(pr, 4, 105, "close", rl);
  check("일부 정리: 10주 중 4주를 105에 → +20 − 진입 수수료 몫 0.36 − 0.378 = 19.262 · 남은 6주 · 증거금 60", [n1, pr.qty, pr.margin, pr.fee], [19.262, 6, 60, 0.54], 1e-9);
  const rec = E.close(pr, { price: 110, why: "close", t: 60, sym: "T", r: rl });
  check("나머지 6주를 110에 → 한 번의 매매로 기록: 손익 78.128 · 나간 가격 평균 108 · 증거금 대비 78.1%", [rec.last, rec.net, rec.exit, rec.qty, rec.roe], [58.866, 78.128, 108, 10, 78.128], 1e-9);
  // 0.16.0: 0.102주를 0.051 · 0.012 · 0.039로 나눠 정리하면 합이 0.10200000000000001 → 기록 수량은 0.102 그대로
  const pq = { side: 1, qty: 0.102, entry: 100, fee: 0, margin: 10.2, marginIn: 10.2, lev: 1, tp: 120, sl: 95, hi: 100, lo: 100, t: 0 };
  E.reduce(pq, 0.051, 101, "close", rl);
  E.reduce(pq, 0.012, 101, "close", rl);
  check("나눠 정리한 기록의 수량에 소수 찌꺼기가 없다 (0.102)", E.close(pq, { price: 101, why: "close", t: 60, sym: "T", r: rl }).qty === 0.102 ? 1 : 0, 1);

  // 미리 깔기 (대기 주문) · 손절 기준 수량 (0.4.0)
  check("대기선 종류: 롱 현재가 아래 = 지정가 · 위 = 돌파 · 숏 위 = 지정가 · 아래 = 돌파", [E.pendingType(1, 99, 100), E.pendingType(1, 101, 100), E.pendingType(-1, 101, 100), E.pendingType(-1, 99, 100)].map((x) => (x === "limit" ? 1 : 2)), [1, 2, 1, 2]);
  const pf = (o, bo, bh, bl, brk = false) => {
    const v = E.fillPending(o, { o: bo, h: bh, l: bl, c: bo, brk }, rl);
    return v ? [v.price, v.maker ? 1 : 0] : [0, 0];
  };
  const lim = { side: 1, price: 99, type: "limit" };
  check("롱 지정가 99: 닿기만 하면 안 됨 · 한 틱 넘으면 99에 지정가 수수료 · 장중 98.5로 건너뛰면 99 · 장 시작 첫 봉이면 98.5", [...pf(lim, 99.5, 100, 99), ...pf(lim, 99.5, 100, 98.99), ...pf(lim, 98.5, 99, 98), ...pf(lim, 98.5, 99, 98, true)], [0, 0, 99, 1, 99, 1, 98.5, 1]);
  // 끊긴 뒤 첫 봉 (0.16.0): 1분봉이 이어지면 아님 · 30분 넘게 비면(미국 주식 16:00 → 다음 날 9:30) 맞음 · 주식 일봉은 늘 맞음 · 24시간 코인 일봉은 아님 · 앞 봉 모름 = 맞음
  const MIN1 = 60;
  const DAY1 = 86400;
  check("끊긴 뒤 첫 봉: 이어진 1분봉 · 20분 빔 · 장 마감 → 다음 날 장 시작 · 주식 일봉 · 코인 일봉 · 앞 봉 없음", [E.isBreak({ t: 0 }, { t: MIN1 }, MIN1, false), E.isBreak({ t: 0 }, { t: 21 * MIN1 }, MIN1, false), E.isBreak({ t: 0 }, { t: 17.5 * 3600 }, MIN1, false), E.isBreak({ t: 0 }, { t: DAY1 }, DAY1, false), E.isBreak({ t: 0 }, { t: DAY1 }, DAY1, true), E.isBreak(undefined, { t: 0 }, MIN1, true)].map((v) => (v ? 1 : 0)), [0, 0, 1, 1, 0, 1]);
  const stp = { side: 1, price: 101, type: "stop" };
  check("롱 돌파 101: 닿으면 시장가 · 시가가 102로 건너뛰면 102 (미끄러짐 0)", [...pf(stp, 100, 101, 99.8), ...pf(stp, 102, 102.5, 101.5)], [101, 0, 102, 0]);
  const sh = { side: -1, price: 101, type: "limit" };
  check("숏 지정가 101: 한 틱 넘게 올라오면 101", pf(sh, 100.5, 101.01, 100.2), [101, 1]);
  check("손절 기준 수량: $100 · 손절 0.25% · 미끄러짐 0 · 수수료 0.09%×2 → 포지션 $23,255.81", E.sizeForRisk(100, 0.0025, rl), 100 / 0.0043, 1e-6);
  const pm = E.open({ side: 1, price: 100, margin: 1000, lev: 1, t: 0, tick: 0.01, r: rl, exact: true, maker: true, tp: 103, sl: 98 });
  check("대기선 체결: 그 가격 그대로 · 지정가 수수료 · 미리 깐 익절·손절", [pm.entry, pm.fee, pm.tp, pm.sl], [100, 1000 * 0.0003, 103, 98], 1e-9);

  // 📒 매매 일지 (web/trade/journal.js, 시안 A + C)
  const J = await import("../trade/journal.js");
  const tl = [
    { sym: "bn:NVDAUSDT", side: 1, net: 5, ses: 2, why: "tp" },
    { sym: "bn:NVDAUSDT", side: -1, net: -3, ses: 2, why: "sl" },
    { sym: "QQQ", side: 1, net: 10, why: "close" },
  ]; // 새것부터
  check("누적 손익 곡선: 매매한 차례대로 (옛것부터) 0 → 10 → 7 → 12", J.curve(tl), [0, 10, 7, 12]);
  check("걸러 보기: NVDA만 2개 · 숏만 1개 · 판 2만 2개 · 예전 기록 1개", [J.filterTrades(tl, { sym: "bn:NVDAUSDT" }).length, J.filterTrades(tl, { side: -1 }).length, J.filterTrades(tl, { ses: "2" }).length, J.filterTrades(tl, { ses: "old" }).length], [2, 1, 2, 1]);
  const ss = J.sessionsOf(tl);
  check("연습 판 묶기: 2판 · 판 2는 2번 +2 · 판 표시 없는 것은 '예전 기록'", [ss.length, ss[0].n, ss[0].net, ss[1].label === "예전 기록" ? 1 : 0], [2, 2, 2, 1]);
  check("익절인데 손해 알림: 익절 −1.33 → 알림 · 익절 +5 → 없음", [J.tpLoss({ why: "tp", net: -1.33 }) ? 1 : 0, J.tpLoss({ why: "tp", net: 5 }) ? 1 : 0], [1, 0]);
  const csv = J.toCsv([{ sym: "QQQ", label: "QQQ", tf: "1D", side: 1, lev: 1, qty: 2, entry: 100, exit: 101, why: "tp", t0: 0, t1: 86400, net: 1.5, fees: 0.5, memo: '지지선, "확인" 후' }]).split("\r\n");
  check("CSV: 머리 22칸 + 한 줄 · 쉼표·따옴표가 든 메모는 따옴표로 감쌈", [csv.length, csv[0].split(",").length, csv[1].endsWith('"지지선, ""확인"" 후"') ? 1 : 0], [2, 22, 1]);

  // 차트를 뒤로 밀어 받은 봉·옛날 구간 1분봉은 떨어진 덩어리 → "지금까지 이어진 부분"만 센다 (0.6.0)
  const HIS = await import("../trade/history.js");
  check("이어진 부분의 시작: 빈 곳 없으면 첫 봉 · 있으면 마지막 빈 곳 뒤 봉", [HIS.blockStart([], 100), HIS.blockStart([[200, 500], [700, 900]], 100)], [100, 900]);
  // 토스 1분봉 깊이 찾기 (0.6.3): 가짜 토스 = 400일 전부터 있음 → 1년 ○, 2년 × → 반씩 좁혀 400일 전 근처 (2일 안)
  const D = 86400;
  const now = 2_000_000_000;
  // 차트 봉 2년씩 받기 (0.9.0): 보름치 → 2년 · 거의 2년(1.95년) → 4년 · 3년 → 4년 · 4년 → 6년
  const Y = HIS.YEAR;
  check("2년씩 받기: 보름 → 2 · 1.95년 → 4 · 3년 → 4 · 4년 → 6 · 없음 → 2", [now - 15 * D, now - 1.95 * Y, now - 3 * Y, now - 4 * Y, now].map((f) => HIS.nextYears(f, now)), [2, 4, 4, 6, 2]);
  const dp = await HIS.findDepth(async (t) => t >= now - 400 * D, now);
  const none = await HIS.findDepth(async () => false, now);
  const all = await HIS.findDepth(async () => true, now);
  // 토스 1분봉 → 5분·1시간봉 (0.7.0): 한국 09:00 = UTC 00:00이라 정시 묶음이 야후 봉과 같은 자리
  const k0 = Date.UTC(2024, 0, 2, 0, 0) / 1000; // 2024-01-02 09:00 한국
  const ms = [0, 1, 2, 3, 4, 5, 59, 60].map((i) => ({ t: k0 + i * 60, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 10 }));
  const b5 = HIS.bucketRows(ms, 300);
  const b60 = HIS.bucketRows(ms, 3600);
  check("1분봉 묶기: 5분봉 4개(09:00 5개·09:05·09:55·10:00) · 첫 5분봉 시100 고105 저99 종104.5 거래량50 · 1시간봉 2개", [b5.length, b5[0].o, b5[0].h, b5[0].l, b5[0].c, b5[0].v, b60.length, b60[0].c], [4, 100, 105, 99, 104.5, 50, 2, 159.5]);
  check("정규장만 (한국 시각): 08:59 × · 09:00 ○ · 15:30 ○ · 15:31 × · 19:00(넥스트레이드) ×", [-1, 0, 390, 391, 600].map((m) => (HIS.krRegular({ t: k0 + m * 60 }) ? 1 : 0)), [0, 1, 1, 0, 0]);
  check("토스 깊이 찾기: 400일 전부터 → 2일 안으로 · 하나도 없음 → null · 10년 다 → beyond", [Math.abs(dp.oldest - (now - 400 * D)) <= 2 * D ? 1 : 0, none.oldest, all.beyond ? 1 : 0, dp.checked.length <= 20 ? 1 : 0], [1, null, 1, 1]);
}

// ── 모든 화면 파일이 문법 오류 없이 읽히는지 (하나라도 깨지면 EXE가 검은 화면에서 멈춘다) ──
section("파일 읽기 (문법 오류 없는지)");
{
  const MODULES = ["alerts/engine", "backtest/engine", "backtest/view", "config", "core/bars", "core/colors", "core/csv", "core/events", "core/daily", "core/data", "core/db", "core/estimate", "core/intraday", "core/limit", "core/series", "core/session", "core/stocklist", "core/symbols", "core/tz", "drawings/geom", "drawings/layer", "drawings/store", "indicators/calc", "indicators/explain", "indicators/index", "indicators/sentiment", "indicators/triangle", "platform", "sources/alpaca", "sources/binance", "sources/hyperliquid", "sources/reconnect", "sources/sentiment", "sources/status", "sources/toss", "sources/yahoo", "trade/engine", "trade/history", "trade/journal", "trade/orderlines", "trade/panel", "ui/alerts", "ui/cell", "ui/dialog", "ui/dom", "ui/drawbar", "ui/format", "ui/goto", "ui/grid", "ui/indpanel", "ui/measure", "ui/menu", "ui/picker", "ui/primitives", "ui/replay", "ui/search", "ui/settings", "ui/sidebar", "ui/statusbar", "ui/tip", "ui/toolbar", "ui/update", "ui/welcome"];
  const broken = [];
  for (const m of MODULES) {
    try {
      await import(`../${m}.js`);
    } catch (e) {
      broken.push(`${m}.js: ${e.message}`);
    }
  }
  broken.length ? fail++ : pass++;
  out.insertAdjacentHTML("beforeend", `<div class="row ${broken.length ? "bad" : "ok"}">화면 파일 ${MODULES.length}개 모두 읽힘${broken.length ? `<br><span class="muted">${broken.join("<br>")}</span>` : ""}</div>`);
}

document.getElementById("sum").textContent = fail ? `✘ ${fail}개 틀림 · ✔ ${pass}개 맞음` : `✔ 모두 맞음 (${pass}개)`;
document.getElementById("sum").style.color = fail ? "#ff5b5b" : "#3ccf6e";
window.testResult = { pass, fail };
