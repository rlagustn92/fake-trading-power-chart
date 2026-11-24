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
  {
    // 0.21.0 매매 방식 지표 (setups.js 계산 + guides.js 그리기)
    const S = await import("../indicators/setups.js");
    const { GUIDE_ORDER } = await import("../indicators/guides.js");
    const { EXPLAIN } = await import("../indicators/explain.js");
    const { ORDER } = await import("../indicators/index.js");
    const pl = S.tradePlan("long", 100, 98, 100);
    check("계획선 롱: 진입 100 · 손절 98 · 잃을 돈 100 → 수량 50, 금액 5000, 1R·2R·3R = 102·104·106", [pl.qty, pl.notional, pl.distPct, ...pl.targets.map((t) => t.price)], [50, 5000, 2, 102, 104, 106]);
    const ps = S.tradePlan("short", 100, 104, 200, [1, 2]);
    check("계획선 숏: 진입 100 · 손절 104 → 수량 50, 목표는 아래로 96·92 / 손절이 반대쪽이면 없음", [ps.qty, ...ps.targets.map((t) => t.price), yes(S.tradePlan("long", 100, 101, 100) === null)], [50, 96, 92, 1]);
    check("손익비: 롱 100→106 손절 98 = 3 · 숏 100→94 손절 102 = 3 · 반대로 가는 목표는 음수", [S.rrOf(100, 98, 106), S.rrOf(100, 102, 94), S.rrOf(100, 98, 96)], [3, 3, -2]);
    const sw = S.swingPoints([1, 2, 5, 2, 1, 2, 0.5, 2, 3].map((x) => ({ h: x, l: x })), 2);
    check("꼭짓점: 고점 2번(확정 4번 봉) · 저점 6번(확정 8번 봉)", sw.flatMap((x) => [x.i, x.at, yes(x.kind === "H")]), [2, 4, 1, 6, 8, 0]);
    const is = (a, b) => yes(a === b);
    check("6선 국면: 7>21>60 정배열 · 반대 역배열 · 뭉치면 박스 · 섞이면 전환", [is(S.sixState(30, 20, 10, 1), "up"), is(S.sixState(10, 20, 30, 1), "down"), is(S.sixState(10.2, 10, 10.5, 1), "box"), is(S.sixState(20, 30, 10, 1), "turn")], [1, 1, 1, 1]);
    check("20선 국면: 아래서 위로 기움 = 상승 · 위에서 아래로 = 하락 · 기울기 없으면 평평 · 엇갈리면 애매", [is(S.e20State(105, 100, 99, 1), "up"), is(S.e20State(95, 100, 101, 1), "down"), is(S.e20State(105, 100, 99.9, 1), "flat"), is(S.e20State(95, 100, 99, 1), "mixed")], [1, 1, 1, 1]);
    check("50·200 국면: 정배열+50선 위 = 롱 · 역배열+50선 아래 = 숏 · 정배열인데 50선 아래 = 기다림", [is(S.s50State(120, 110, 100), "up"), is(S.s50State(80, 90, 100), "down"), is(S.s50State(105, 110, 100), "wait")], [1, 1, 1]);
    check("4단계: 가격>50>200·50 오름 = 2 · 가격<50<200·50 내림 = 4 · 50>200인데 아님 = 3 · 50<200인데 아님 = 1", [S.stageOf(120, 110, 109, 100), S.stageOf(80, 90, 91, 100), S.stageOf(105, 110, 109, 100), S.stageOf(95, 90, 91, 100)], [2, 4, 3, 1]);
    {
      const bs = Array.from({ length: 16 }, (_, k) => ({ c: k < 12 ? 11 : 9 }));
      const st = S.alwaysIn(bs, bs.map(() => 10), 10, 3);
      check("올웨이즈 인: 위로 10봉째부터 추세(1) · 반대 종가 2봉까지는 유지 · 3봉째 레인지(0)", [st[8], st[9], st[13], st[14]], [0, 1, 1, 0]);
    }
    // 권총: 100에서 30봉 → 10봉 동안 120까지 급등 → 12봉 횡보(119.5~120.5) → 122로 마감. 느린 이평은 베이스 안(119.6)에 붙어 있다고 둔다
    const bar = (o, c, h = Math.max(o, c) + 0.5, l = Math.min(o, c) - 0.5) => ({ o, c, h, l, v: 1 });
    const flatAt = (p, n) => Array.from({ length: n }, () => bar(p, p));
    const rise = Array.from({ length: 10 }, (_, k) => bar(100 + 2 * k, 102 + 2 * k));
    const pb = [...flatAt(100, 30), ...rise, ...flatAt(120, 12), { o: 120, c: 122, h: 122.5, l: 119.8, v: 1 }].map((b, t) => ({ ...b, t }));
    const pe = S.findSetups(pb, pb.map(() => 119.6), C.atr(pb, 14));
    check("권총: 급등 뒤 12봉 횡보를 위로 마감 → 52번 봉 '권총 ▲', 베이스 119.5~120.5, 손절 = 베이스 아래", [pe.length, pe[0]?.i, is(pe[0]?.kind, "pistol"), is(pe[0]?.dir, "go"), pe[0]?.lo, pe[0]?.hi, pe[0]?.stop], [1, 52, 1, 1, 119.5, 120.5, 119.5]);
    const pend = S.pendingSetup(pb.slice(0, 52), pb.map(() => 119.6), C.atr(pb.slice(0, 52), 14));
    check("권총: 벗어나기 전에는 '만들어지는 중'으로 보인다", [is(pend?.kind, "pistol"), pend?.hi], [1, 120.5]);
    // ㄴ자: 120에서 30봉 → 10봉 동안 100까지 급락 → 12봉 횡보 → 이평(100.3)을 올라타며 102로 마감. 절반 익절 = 99.5 + (120.5 − 99.5)/2 = 110
    const drop = Array.from({ length: 10 }, (_, k) => bar(120 - 2 * k, 118 - 2 * k));
    const lb = [...flatAt(120, 30), ...drop, ...flatAt(100, 12), { o: 100, c: 102, h: 102.5, l: 99.8, v: 1 }].map((b, t) => ({ ...b, t }));
    const le = S.findSetups(lb, lb.map(() => 100.3), C.atr(lb, 14));
    check("ㄴ자: 급락 뒤 횡보를 이평 위로 마감 → 'ㄴ자 ▲', 절반 익절 110", [le.length, le[0]?.i, is(le[0]?.kind, "lshape"), is(le[0]?.dir, "go"), le[0]?.half], [1, 52, 1, 1, 110]);
    const lf = S.findSetups([...lb.slice(0, 52), { o: 100, c: 98, h: 100.2, l: 97.5, v: 1, t: 52 }], lb.map(() => 100.3), C.atr(lb, 14));
    check("ㄴ자: 아래로 마감하면 '이탈'(하락 지속)", [lf.length, is(lf[0]?.dir, "fail")], [1, 1]);
    {
      // 20선 눌림: 100 → 110 상승, 음봉 3개로 105.2까지(48% 되돌림), 좁은 봉. 진입 105.8 · 손절 105.2 · 목표 110 → 손익비 7
      const up = [102, 104, 106, 108, 110].map((c) => ({ o: c - 2, c, h: c, l: c - 2 }));
      const red = [[110, 108.5], [108.5, 107], [107, 105.5]].map(([o, c]) => ({ o, c, h: o, l: c }));
      const bs = [...Array.from({ length: 10 }, () => ({ o: 100, c: 100, h: 100.2, l: 100 })), ...up, ...red, { o: 105.5, c: 105.6, h: 105.8, l: 105.2 }];
      const ma = bs.map((_, i) => 105 - (18 - i) * 0.4);
      const ev = S.findPullbacks(bs, ma, bs.map(() => 1), { look: 10 });
      check("20선 눌림: 음봉 3개·48% 되돌림·좁은 봉 → 18번 봉, 진입 105.8 · 손절 105.2 · 목표 110 · 손익비 7", [ev.length, ev[0]?.i, ev[0]?.entry, ev[0]?.stop, ev[0]?.target, ev[0]?.rr, yes(ev[0]?.ok)], [1, 18, 105.8, 105.2, 110, 7, 1], 1e-6);
      check("20선 눌림: 음봉이 4개 이어져야 한다고 하면 없음 · 20선이 평평하면 없음", [S.findPullbacks(bs, ma, bs.map(() => 1), { look: 10, reds: 4 }).length, S.findPullbacks(bs, bs.map(() => 105), bs.map(() => 1), { look: 10 }).length], [0, 0]);
    }
    {
      // 매물대(자동): 12봉이 몸통 100에서 막히다가(꼬리 100.5) 몸통 큰 양봉이 103으로 뚫음 → 100이 지지. 4봉 뒤 100까지 내려와 닿음 = 리테스트
      const zb = [...flatAt(100, 30), { o: 100, c: 103, h: 103.2, l: 99.9, v: 5 }, ...flatAt(102.5, 3), { o: 102, c: 101, h: 102.2, l: 100, v: 1 }].map((b, t) => ({ ...b, t }));
      const zs = S.findZones(zb, C.atr(zb, 14));
      check("매물대(자동): 막히던 몸통 값 100을 큰 양봉이 뚫음 → 지지 100, 34번 봉에서 리테스트", [zs.length, zs[0]?.i, is(zs[0]?.kind, "sup"), zs[0]?.level, zs[0]?.test], [1, 30, 1, 100, 34]);
      check("매물대(자동): 다시 닿기 전에는 '아직 안 닿음'(−1) · 몸통이 작은 봉으로 넘으면 매물대 아님", [S.findZones(zb.slice(0, 34), C.atr(zb, 14))[0]?.test, S.findZones([...flatAt(100, 30), { o: 100, c: 100.9, h: 101, l: 99.9, v: 1 }], C.atr(zb, 14)).length], [-1, 0]);
      check("거래량 배수: 앞 20봉 평균 1인데 이 봉 5 → 5배 · 앞 봉이 모자라면 없음", [S.volRatio(zb, 30), S.volRatio(zb, 5)], [5, null]);
    }
    check("신호 봉: 고가 근처 마감 양봉 = 맞음 · 음봉 = 아님 · 가운데 마감 = 아님 · 너무 작은 봉 = 아님", [yes(S.isSignalBar({ o: 10, h: 11, l: 9.9, c: 10.95 }, 1)), yes(S.isSignalBar({ o: 11, h: 11, l: 10, c: 10.1 }, 1)), yes(S.isSignalBar({ o: 10, h: 11, l: 9.9, c: 10.4 }, 1)), yes(S.isSignalBar({ o: 10, h: 10.2, l: 9.98, c: 10.19 }, 1))], [1, 0, 0, 0]);
    {
      const bs = Array.from({ length: 30 }, (_, i) => ({ h: i === 25 ? 12 : 13, l: i === 25 ? 9.5 : 11, c: 12 }));
      const ft = S.firstTouches(bs, bs.map(() => 10));
      check("이평선 첫 닿음: 25번 봉에서 위에서 내려와 닿음", [ft.length, ft[0]?.i, is(ft[0]?.side, "sup")], [1, 25, 1]);
    }
    {
      // 미래 봉을 안 보는지: 400봉으로 찾은 신호 중 앞 300봉 안의 것 = 300봉만 주고 찾은 것 (리플레이에서 그때 보였을 그대로)
      let seed = 7;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
      let pz = 100;
      const rw = Array.from({ length: 400 }, (_, t) => {
        const o = pz;
        const tr = Math.sin(t / 25) * 0.25;
        const c = o + tr + (rnd() - 0.5) * 1.2;
        pz = c;
        return { t: t * 300, o, c, h: Math.max(o, c) + rnd() * 0.4, l: Math.min(o, c) - rnd() * 0.4, v: 100 + rnd() * 50 };
      });
      const run = (bs) => {
        const cl = bs.map((b) => b.c);
        const atr = C.atr(bs, 14);
        const m20 = C.sma(cl, 20);
        const m7 = C.sma(cl, 7);
        const e20 = C.ema(cl, 20);
        const lvl = [{ name: "x", vals: C.sma(cl, 60) }];
        return [
          S.findSetups(bs, C.sma(cl, 50), atr, { impK: 3 }),
          S.findPullbacks(bs, m20, atr, { lo: 0.2, hi: 0.8, reds: 2, minRR: 0.5 }),
          S.findFirstHH(bs, m20, atr),
          S.findBarSignals(bs, e20, atr, S.alwaysIn(bs, e20, 5)),
          S.findSixTriggers(bs, m7, m20, atr, lvl, { nearPct: 1, gapPct: 0.2 }),
          S.findZones(bs, atr, { bigK: 0.8 }),
        ];
      };
      const full = run(rw).map((evs) => evs.filter((e) => e.i < 299).map((e) => e.i));
      const cut = run(rw.slice(0, 300)).map((evs) => evs.filter((e) => e.i < 299).map((e) => e.i));
      check("매매 방식 신호 6종: 미래 봉을 안 본다 (400봉으로 본 과거 신호 = 300봉만 보고 찾은 신호)", full.map((a, k) => yes(a.join() === cut[k].join())), [1, 1, 1, 1, 1, 1]);
      check("매매 방식 신호: 시험 자료에서 실제로 신호가 나온다 (빈 것끼리 비교한 게 아님)", yes(full.flat().length >= 5), 1);
      // 숏은 봉을 뒤집어 같은 함수로: 뒤집은 봉에서 찾은 롱 신호 수 = 원래 봉을 위아래로 뒤집어 다시 뒤집은 것과 같다
      const f2 = S.flipBars(S.flipBars(rw));
      check("봉 뒤집기 두 번 = 원래 봉", [f2[5].h, f2[5].l, f2[5].o, f2[5].c], [rw[5].h, rw[5].l, rw[5].o, rw[5].c]);
      // 그리기: 지표 9개가 가짜 차트 칸에서 오류 없이 그려지고 범례가 나오는지 (분봉·일봉 둘 다)
      const mkCtx = (tf) => {
        const mk = () => ({ data: [], setData(d) { this.data = d; }, update(pt) { this.data.push(pt); }, createPriceLine() {} });
        return { tf, decimals: 2, replaying: false, replayEnd: null, info: { volume: true, rth: tf === "5m" ? [0, 86400] : null }, time: (t) => t, tfName: (t) => `${t}봉`, fmt: (v) => (v == null ? "—" : v.toFixed(2)), addLine: mk, addHist: mk, newPane: () => 1, attach() {}, setMarkers() {}, htf: () => null, htfKeyOf: () => (x) => x, dayKey: (t) => Math.floor(t / 86400), isRegular: () => true };
      };
      const bad = [];
      for (const tf of ["5m", "1D"]) {
        for (const id of GUIDE_ORDER) {
          try {
            const hd = IND[id].make(mkCtx(tf), wd({ id }));
            hd.render(rw, 0);
            hd.render(rw, rw.length - 1);
            const lg = hd.legend(rw.length - 1);
            if (!Array.isArray(lg) || !lg.length) bad.push(`${id} ${tf}: 범례 없음`);
            hd.legend(3);
          } catch (e) {
            bad.push(`${id} ${tf}: ${e.message}`);
          }
        }
      }
      if (bad.length) console.warn("[시험] 매매 방식 지표", bad);
      check(`매매 방식 지표 9개: 5분봉·일봉에서 오류 없이 그려지고 범례가 나온다${bad.length ? ` — ${bad.join(" / ")}` : ""}`, bad.length, 0);
      check("매매 방식 지표 11개 (0.28.0 나뇨띠 지표 포함): 설명서(쓰는 봉·보는 법)가 있고 지표 창 맨 위에 나온다", [GUIDE_ORDER.length, GUIDE_ORDER.filter((id) => EXPLAIN[id]?.one && /\[/.test(EXPLAIN[id].read)).length, yes(ORDER.slice(0, GUIDE_ORDER.length).join() === GUIDE_ORDER.join())], [11, 11, 1]);
      // 0.22.0 딱지: 신호를 내는 지표는 범례가 '롱 후보·숏 후보·쉼' 한 줄로 시작하고, 기본은 그 한 줄뿐 (자세한 글자는 설정에서)
      const SIG = ["regime", "sixma", "pull20", "setup50", "pistol", "lshape", "vwapswing", "barread"];
      const badgeOf = (id, detail) => {
        const hd = IND[id].make(mkCtx("5m"), wd({ id, params: { detail } }));
        hd.render(rw, 0);
        return hd.legend(rw.length - 1);
      };
      check("딱지: 신호 지표 8개의 범례 첫 칸이 롱·숏·쉼 딱지이고 이유가 적혀 있다", SIG.filter((id) => { const a = badgeOf(id, false)[0]; return ["long", "short", "rest"].includes(a?.badge) && a.value; }).length, 8);
      check("딱지: 기본은 딱지 한 줄만, '자세한 글자도 보기'를 켜면 더 나온다", [SIG.filter((id) => id === "regime" || badgeOf(id, false).length === 1).length, SIG.filter((id) => badgeOf(id, true).length > 1).length], [8, 8]);
      // 같은 자리 재실패: 근처에서 같은 방향 신호가 방금 손절선에 닿았으면 '조심' (막지는 않음)
      const { failedHere } = await import("../indicators/guides.js");
      const lb = [10, 9, 10, 10, 10].map((c, k) => ({ t: k * 60, o: c, h: c + 0.2, l: c - 0.2, c }));
      const sig = (i, entry = 10) => ({ i, entry, stop: entry - 0.5 });
      check("같은 자리 재실패: 앞 신호가 손절선에 닿았으면 참 · 멀리 떨어진 가격이면 아님 · 앞 신호가 안 닿았으면 아님", [yes(failedHere(lb, [sig(0)], sig(3))), yes(failedHere(lb, [sig(0)], sig(3, 12))), yes(failedHere(lb, [sig(2)], sig(4)))], [1, 0, 0]);
      // 신호 결과 (0.23.0): 익절선·손절선 중 먼저 닿은 쪽, 한 봉에서 둘 다면 손절, 아직이면 null
      const { outcomeOf } = await import("../indicators/guides.js");
      const ob = (rows) => rows.map(([h, l], k) => ({ t: k * 60, o: (h + l) / 2, h, l, c: (h + l) / 2 }));
      const ev = { i: 0, entry: 10, stop: 9, targets: [{ price: 12 }, { price: 11 }] };
      const oc = (r) => (r == null ? -1 : r.k * 10 + (r.win ? 1 : 0)); // 봉 번호×10 + (익절이면 1)
      check("신호 결과: 가장 가까운 익절선(11) 먼저 → ○ · 손절 먼저 → ✕ · 한 봉에서 둘 다 → ✕ · 아직 → 없음 · 숏도", [
        oc(outcomeOf(ob([[10, 10], [10.5, 9.5], [11.2, 10.4]]), ev)),
        oc(outcomeOf(ob([[10, 10], [10.2, 8.9]]), ev)),
        oc(outcomeOf(ob([[10, 10], [11.5, 8.5]]), ev)),
        oc(outcomeOf(ob([[10, 10], [10.5, 9.5]]), ev)),
        oc(outcomeOf(ob([[10, 10], [9.5, 8.8]]), { i: 0, entry: 10, stop: 11, targets: [{ price: 9 }] })),
      ], [21, 10, 10, -1, 11]);
      const SIGS = ["sixma", "pull20", "setup50", "pistol", "lshape", "vwapswing", "barread"];
      check("자동 멈춤: 신호 지표 7개가 이름표와 신호 목록을 준다", SIGS.filter((id) => { const hd = IND[id].make(mkCtx("5m"), wd({ id })); hd.render(rw, 0); return typeof hd.tag === "string" && Array.isArray(hd.signals()); }).length, 7);
      // 자동 피보: 저점이 먼저면 오른 움직임 → 0%는 고점, 100%는 저점, 50%는 한가운데
      const fb = [10, 11, 9, 12, 15, 14, 13].map((c, k) => ({ t: k * 60, o: c, h: c + 1, l: c - 1, c }));
      const af = S.autoFib(fb, 120);
      check("자동 피보: 오른 움직임이면 고점에서 아래로 잰다 (0% = 고점, 50% = 가운데, 100% = 저점)", [yes(af.up), af.price(0), af.price(0.5), af.price(1)], [1, 16, 12, 8]);
      const af2 = S.autoFib(S.flipBars(fb), 120);
      check("자동 피보: 내린 움직임이면 저점에서 위로 잰다", [yes(af2.up), af2.price(0), af2.price(1)], [0, -16, -8]);
      check("자동 피보: 그 봉까지만 본다 (뒤에 더 높은 고점이 있어도 안 씀)", S.autoFib(fb, 120, 3).H, 13);
      // 0.28.0 로그 피보 (양봉업자 강의 SOXX: 49.44 → 218.65를 로그로 나누면 0.5 = 103.97, 1.272 = 327.62, 2 = 966.99)
      const sx = [60, 49.44 + 1, 80, 120, 218.65 - 1, 200].map((c, k) => ({ t: k * 86400, o: c, h: c + 1, l: c - 1, c }));
      const lf = S.autoFib(sx, 120, sx.length - 1, true);
      check("자동 피보 로그: 0.5 = 103.97 · 1.272 = 327.62 · 2 = 966.99 · 지금(200) 되돌림 0.06", [lf.price(0.5), lf.price(-0.272), lf.price(-1), lf.back(200)], [103.97, 327.62, 966.99, 0.06], 0.01);
      const { fibPrice } = await import("../drawings/layer.js");
      check("그리기 피보: 일반 0.5 = 134.05 · 로그 0.5 = 103.97 · 로그 1.272 확장 = 327.62 (바닥 49.44 → 꼭대기 218.65)", [fibPrice(49.44, 218.65, 0.5, false), fibPrice(49.44, 218.65, 0.5, true), fibPrice(218.65, 49.44, 1.272, true)], [134.045, 103.97, 327.62], 0.01);
      // 0.28.0 나뇨띠 지표 (구름 상황판) — 2026-11-24 방송 캡처와 바이낸스 BTCUSDT 3분봉으로 맞춘 규칙
      const CB = await import("../indicators/cloudboard.js");
      const mk3 = (rows) => rows.map(([o, h, l, c], k) => ({ t: k * 180, o, h, l, c, v: 1 }));
      // 22:03 · 22:06 · 22:09 · 22:12 · 22:15 실제 봉 (60,000을 22:09에 아래로 뚫음 → 22:12 저가 59,711.6이 6-8 칸에 닿고 59,930.9로 말려 올라옴)
      const lb3 = mk3([[60435.5, 60557.7, 60404.0, 60538.9], [60538.8, 60538.9, 60074.4, 60182.7], [60182.8, 60324.4, 59824.4, 59888.0], [59888.1, 60014.7, 59711.6, 59930.9], [59930.8, 60063.0, 59758.8, 59976.9]]);
      check("2·4·6·8: 22:06 = 1K 조건 대기 · 22:09 = 구간 반응 대기 · 22:12 = 6-8 반응 발생 · 22:15 = 6-8 구간 관찰 (방송 표와 같음)", [1, 2, 3, 4].map((k) => ["1K 조건 대기", "구간 반응 대기", "6-8 반응 발생", "6-8 구간 관찰"].indexOf(CB.ladderAt(lb3, k).text)), [0, 1, 2, 3]);
      const back = mk3([[59900, 59950, 59850, 59900], [59900, 60100, 59890, 60050]]);
      check("2·4·6·8: 천 단위 위로 돌아오면 위로 뚫은 것으로 다시 셈 (구간 반응 대기) · 뚫은 지 20봉 넘으면 1K 조건 대기", [CB.ladderAt([...lb3, ...back], 6).text === "구간 반응 대기", CB.ladderAt([...lb3, ...mk3(Array(21).fill([59900, 59950, 59850, 59900]))], 25).text === "1K 조건 대기"].map(yes), [1, 1]);
      // 0.29.0 위로 뚫을 때 (실제 봉 22:54~23:18): 23:00 봉이 60,000을 위로 뚫음 → 23:03 저가 60,232.7이 2-4 칸에서 받쳐짐 = 반응 → 23:18 = 구간 반응 대기 (방송 표와 같음)
      const up3 = mk3([[60057.1, 60068.9, 59980.1, 60001.0], [60001.0, 60015.4, 59918.1, 59986.9], [59986.9, 60475.8, 59953.7, 60402.5], [60402.6, 60408.6, 60232.7, 60256.6], [60256.6, 60270.6, 60168.8, 60237.0], [60237.0, 60375.0, 60187.5, 60316.5], [60316.6, 60352.7, 60258.7, 60295.5], [60295.3, 60335.5, 60255.0, 60335.2], [60335.2, 60385.0, 60280.1, 60292.0], [60291.6, 60399.0, 60286.4, 60389.7], [60389.6, 60457.7, 60352.2, 60382.6], [60382.6, 60484.2, 60370.0, 60398.4]]);
      // 0.29.1: 칸의 위 끝(60,400)까지 닿은 봉만 — 처음 = 반응 발생, 두 번째부터 = 구간 관찰, 안 닿으면 = 구간 반응 대기 (23:31 캡처 "2-4 구간 관찰")
      check("2·4·6·8 위로: 23:03 = 2-4 반응 발생 · 23:06 = 구간 반응 대기 · 23:18 = 구간 반응 대기 · 23:27 = 2-4 구간 관찰 (방송 표와 같음)", [3, 4, 8, 11].map((k, n) => yes(CB.ladderAt(up3, k).text === ["2-4 반응 발생", "구간 반응 대기", "구간 반응 대기", "2-4 구간 관찰"][n])), [1, 1, 1, 1]);
      check("구름 이격 글자: 위 0.8 ATR · 아래 7.3 ATR · 이격 큼 · 구름 안 (이격 큼은 2 ATR부터)", [CB.gapText(0.8) === "위 0.8 ATR", CB.gapText(-7.3) === "아래 7.3 ATR · 이격 큼", CB.gapText(0) === "구름 안", CB.gapText(1.4) === "위 1.4 ATR", CB.gapText(-2.2) === "아래 2.2 ATR · 이격 큼"].map(yes), [1, 1, 1, 1, 1]);
      // 일목 구름 (트레이딩뷰 기본 9·26·52, 26칸 앞으로): 고가 = 종가+1, 저가 = 종가−1, 종가 = 봉 번호 → 25봉 전의 가운데 값
      const lin = Array.from({ length: 120 }, (_, k) => ({ t: k * 60, o: k, h: k + 1, l: k - 1, c: k }));
      const ic = CB.ichimokuCloud(lin);
      // 100번 봉: 75번 봉 기준 전환선(67~75 가운데 71) · 기준선(50~75 가운데 62.5) → A = 66.75, 선행스팬B(24~75 가운데) = 49.5
      check("일목 구름: 100번 봉 A = 66.75 · B = 49.5 · 그 전 봉은 비어 있음(구름이 아직 없음)", [ic.a[100], ic.b[100], ic.b[75]], [66.75, 49.5, null]);
      check("구름 위치·이격: 위 → 롱 우세 · (종가 − 구름 위 끝) ÷ ATR", [CB.trendText(CB.cloudPos(70, 66.75, 49.5)) === "롱 우세", CB.cloudGap(70, 66.75, 49.5, 2), CB.cloudGap(40, 66.75, 49.5, 2), CB.cloudGap(60, 66.75, 49.5, 2)].map((v) => (typeof v === "boolean" ? yes(v) : v)), [1, 1.625, -4.75, 0]);
      // 2번 봉 저가 8 = 프랙탈 저점 (양옆 2봉보다 낮음), 4번 봉 고가 12 = 프랙탈 고점 → 7번 봉 종가 7.2가 저점을 깸
      const fr = mk3([[11, 12, 10, 11], [10, 11, 9, 10], [9, 10, 8, 9], [10, 11, 9, 10], [11, 12, 10, 11], [10.5, 11.5, 9.5, 10.5], [10.6, 11.6, 9.6, 10.6], [9, 9, 7, 7.2]]);
      check("프랙탈: 1시간봉 롱인데 프랙탈 저점을 깨면 '반대 이탈 · 재검토' · 1시간봉 숏이면 '같은 방향 돌파' · 중립이면 '조건 대기'", [CB.fractalState(fr, 7, 1).text, CB.fractalState(fr, 7, -1).text, CB.fractalState(fr, 7, 0).text].map((t, k) => (t === ["반대 이탈 · 재검토", "같은 방향 돌파", "조건 대기"][k] ? 1 : 0)), [1, 1, 1]);
      check("관찰 기준: 셋 다 숏 = 일치 · 엇갈림 = 미일치 · 큰 시간봉 못 봄 = 데이터 대기", [CB.alignText("below", "below", "below") === "큰 방향 일치 · 숏", CB.alignText("below", "inside", "below") === "큰 방향 미일치", CB.alignText("below", null, "below") === "큰 방향 데이터 대기"].map(yes), [1, 1, 1]);
      check("비트코인 달러만 2·4·6·8: bn:BTCUSDT · ok:BTC-USDT-SWAP 예 · bn:ETHUSDT · KRW-BTC 아니오", ["bn:BTCUSDT", "ok:BTC-USDT-SWAP", "bn:ETHUSDT", "KRW-BTC"].map((id) => yes(CB.isBtcUsd(id))), [1, 1, 0, 0]);
      const nhd = IND.nanyotti.make(mkCtx("5m"), wd({ id: "nanyotti" }));
      nhd.render(rw, 0);
      const pn = nhd.panel(rw.length - 1);
      check("나뇨띠 지표: 표 9줄이 방송과 같은 순서 (현재 추세 … 가까운 영역) + 한 줄 요약", [pn?.rows.map((r) => r.label).join("|") === "현재 추세|큰 시간봉|프랙탈|구름 이격|2·4·6·8|시장 활동|관찰 기준|매물영역|가까운 영역", !!pn?.summary].map(yes), [1, 1]);
    }
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
  check("30분봉: 09:30~10:25 5분봉 12개 → 09:30·10:00 두 개 · 첫 봉 시100 고106 저99 종105.5 거래량60 · 버튼 순서 15분 다음", [m30.length, (m30[1].t - t0) / 60, m30[0].o, m30[0].h, m30[0].l, m30[0].c, m30[0].v, TIMEFRAMES.indexOf("30m") - TIMEFRAMES.indexOf("15m")], [2, 30, 100, 106, 99, 105.5, 60, 1]);
  // 3분봉 (0.29.0): 주식은 1분봉 3개를 묶는다 · 버튼은 1분 다음
  const r1 = Array.from({ length: 6 }, (_, i) => ({ t: t0 + i * 60, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 10 }));
  const m3 = aggregate(r1, TF_SEC["3m"], "America/New_York", 9.5 * 3600);
  const { BASE_TF } = await import("../core/intraday.js");
  check("3분봉: 1분봉 6개 → 09:30·09:33 두 개 · 첫 봉 시100 고103 저99 종102.5 · 주식은 1분봉에서 · 버튼 1분 다음", [m3.length, (m3[1].t - t0) / 60, m3[0].o, m3[0].h, m3[0].l, m3[0].c, BASE_TF.alpaca["3m"] === "1m" && BASE_TF.yahoo["3m"] === "1m" ? 1 : 0, TIMEFRAMES.indexOf("3m")], [2, 3, 100, 103, 99, 102.5, 1, 1]);
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

section("📋 이미지 복사 — 칸을 한 장으로 (0.18.0)");
{
  const { composeCells } = await import("../ui/snapshot.js");
  const mkCell = (left, k) => {
    const root = document.createElement("div");
    root.style.cssText = `position:fixed;left:${left}px;top:0;width:100px;height:60px`;
    root.innerHTML = `<div style="height:20px;color:rgb(255,0,0);font:700 16px sans-serif;overflow:hidden">■■■<button style="background:rgb(0,0,255);width:30px;height:20px;border:0"></button></div><div class="ch" style="position:absolute;left:0;top:20px;width:100px;height:40px"></div><div style="display:none;position:absolute;left:60px;top:0;width:40px;height:20px;background:rgb(255,255,0)"></div>`;
    document.body.append(root);
    const shot = document.createElement("canvas");
    shot.width = 100 * k;
    shot.height = 40 * k;
    const g = shot.getContext("2d");
    g.fillStyle = "rgb(0,128,0)";
    g.fillRect(0, 0, shot.width, shot.height);
    return { root, chart: root.querySelector(".ch"), shot };
  };
  const px = (cv, x, y) => [...cv.getContext("2d").getImageData(x, y, 1, 1).data];
  const count = (cv, x, y, w, want) => {
    const d = cv.getContext("2d").getImageData(x, y, w, 18).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (want(d[i], d[i + 1], d[i + 2])) n++;
    return n;
  };
  const a = mkCell(0, 1);
  const b = mkCell(104, 1);
  const two = composeCells([a, b]);
  check("분할 두 칸: 화면 배치 그대로 204×60", [two.width, two.height], [204, 60]);
  check("칸 사이는 불투명 어두운 바탕 (흰색이 비치지 않게)", px(two, 102, 30), [11, 13, 16, 255]);
  check("차트 그림이 두 칸 모두 제자리에", [px(two, 50, 40)[1], px(two, 150, 40)[1]], [128, 128]);
  check("머리줄 글자가 칸 색 그대로 들어감", count(two, 0, 0, 40, (r, gr, bl) => r > 200 && gr < 60 && bl < 60) > 10 ? 1 : 0, 1);
  check("버튼·숨긴 것은 그림에 없음 (파랑·노랑 0칸)", count(two, 0, 0, 100, (r, gr, bl) => (bl > 200 && r < 60) || (r > 200 && gr > 200 && bl < 60)), 0);
  a.root.remove();
  b.root.remove();
  const c = mkCell(0, 2);
  const one = composeCells([c]);
  check("윈도우 배율 200%: 한 칸 200×120, 차트도 2배로", [one.width, one.height, px(one, 100, 80)[1]], [200, 120, 128]);
  c.root.remove();
}

section("🧲 꼭지점 자석·평행선 복사 (0.20.0)");
{
  const { snapPeak, parallelOffset } = await import("../drawings/geom.js");
  const bars = [[10, 9], [12, 10], [15, 11], [13, 10], [11, 8], [12, 9]].map(([h, l]) => ({ h, l, c: (h + l) / 2 }));
  const yOf = (p) => 300 - p * 10; // 1원 = 화면 10칸
  const snap = (L, K, price, reach = 40, line = false) => {
    const r = snapPeak(bars, L, K, yOf(price), yOf, reach, line);
    return r ? [r.L, r.p] : [-1, -1];
  };
  check("옆 봉(3번)을 고점 높이로 눌러도 진짜 고점 2번 15에 붙음", snap(3, 2, 14), [2, 15]);
  check("같은 봉을 아래쪽으로 누르면 진짜 저점 4번 8에 붙음", snap(3, 2, 8.5), [4, 8]);
  check("고점·저점 둘 다 멀면 안 붙음", snap(3, 1, 11.5, 30), [-1, -1]);
  check("찾는 폭 밖의 고점은 안 봄 (0번 ±1봉 → 1번 12)", snap(0, 1, 12), [1, 12]);
  check("봉이 없는 먼 오른쪽은 안 붙음", snap(20, 2, 14), [-1, -1]);
  check("선 차트는 고가·저가 대신 종가로", snap(2, 1, 13, 40, true), [2, 13]);
  const flat = [{ h: 10, l: 9, c: 9.5 }, { h: 10, l: 9, c: 9.5 }, { h: 10, l: 9, c: 9.5 }];
  check("같은 고가가 여럿이면 누른 곳에 가까운 봉", snapPeak(flat, 2, 2, yOf(10), yOf, 40).L, 2);
  const id = (x) => x;
  check("고점끼리 이은 선 → 가장 낮은 저점으로 (사이 봉 기준 -5)", parallelOffset(bars, { L: 2, F: 15 }, { L: 5, F: 12 }, id), -5);
  check("저점끼리 이은 선 → 가장 높은 고점으로 (+5.667)", parallelOffset(bars, { L: 1, F: 10 }, { L: 4, F: 8 }, id), 5 + 2 / 3, 1e-9);
  check("로그 눈금: 수평선 15 → 저점 8 = 비율로 옮김", Math.exp(parallelOffset(bars, { L: 2, F: Math.log(15) }, { L: 4, F: Math.log(15) }, Math.log)), 8 / 15, 1e-9);
  check("두 점 사이에 봉이 없으면 안 만듦", parallelOffset(bars, { L: 20, F: 1 }, { L: 30, F: 2 }, id) ?? -1, -1);
}

section("📏 자 오른쪽 클릭 — 그리기 도구와 같은 규칙 (0.19.1)");
{
  const { createMeasure } = await import("../ui/measure.js");
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;left:0;top:0;width:400px;height:300px";
  box.setPointerCapture = () => {}; // 시험에서 만든 포인터는 잡을 수 없다
  document.body.append(box);
  const chart = { timeScale: () => ({ coordinateToLogical: (x) => x, logicalToCoordinate: (l) => l, subscribeVisibleLogicalRangeChange() {} }), applyOptions() {} };
  const series = { coordinateToPrice: (y) => 300 - y, priceToCoordinate: (p) => 300 - p };
  const m = createMeasure({ chart, getSeries: () => series, box, getBars: () => [], isDaily: () => false, getDecimals: () => 2 });
  const ptr = (type, x, y, extra) => box.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerType: "mouse", ...extra }));
  const click = (x, y) => (ptr("pointerdown", x, y), ptr("pointerup", x, y));
  const right = () => {
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    box.dispatchEvent(e);
    return e.defaultPrevented ? 1 : 0; // 1 = 자가 받음, 0 = 칸의 복사 메뉴로
  };
  const shown = () => (box.querySelector(".measure-label").style.display === "none" ? 0 : 1);
  m.toggle(true);
  click(100, 100);
  const first = [shown(), right(), shown(), m.on ? 1 : 0];
  check("첫 점 찍고 오른쪽 클릭: 첫 점만 취소, 자는 켜진 채", first, [1, 1, 0, 1]);
  click(100, 100);
  click(200, 50);
  const done = [shown(), right(), shown(), m.on ? 1 : 0];
  check("다 재고 오른쪽 클릭: 자 꺼짐, 잰 결과는 남음", done, [1, 1, 1, 0]);
  check("자가 꺼져 있으면 오른쪽 클릭은 칸의 복사 메뉴로", right(), 0);
  m.clear();
  m.toggle(true);
  check("자만 켜고 오른쪽 클릭: 자 꺼짐", [right(), m.on ? 1 : 0], [1, 0]);
  ptr("pointerdown", 100, 100, { shiftKey: true });
  ptr("pointermove", 150, 60, { shiftKey: true });
  check("자 없이 Shift+끌기 중 오른쪽 클릭: 재던 것 취소", [right(), shown()], [1, 0]);
  ptr("pointerup", 150, 60, { shiftKey: true });
  box.remove();
}

// ── 월봉·년봉 (0.25.0): 일봉을 묶어 만든다. 주봉·일봉은 예전과 똑같아야 한다 ──
section("월봉 · 년봉 · 주·월 VWAP (0.25.0)");
{
  const B = await import("../core/bars.js");
  const { mapHtf } = await import("../indicators/index.js");
  const D = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;
  check("봉 순서: Alt+9 = 월봉, Alt+0 = 년봉 (앞 8개는 그대로) · 3분봉은 단축키 없이 버튼만 (0.29.0, Alt+2는 그대로 5분)", [B.ALT_TFS.indexOf("1W"), B.ALT_TFS.indexOf("1M"), B.ALT_TFS.indexOf("1Y"), B.ALT_TFS.length, B.ALT_TFS.indexOf("5m"), !B.ALT_TFS.includes("3m") && B.TIMEFRAMES.includes("3m") ? 1 : 0], [7, 8, 9, 10, 1, 1]);
  check("일·주·월·년 = 날짜 봉, 월·년 = 일봉을 묶는 봉", [B.isDailyTf("1D"), B.isDailyTf("1W"), B.isDailyTf("1M"), B.isDailyTf("1Y"), B.isDailyTf("4h"), B.isLongTf("1W"), B.isLongTf("1M"), B.isLongTf("1Y")].map(Number), [1, 1, 1, 1, 0, 0, 1, 1]);
  const mon = D(2026, 11, 25); // 수요일
  check("periodOf: 2026-11-25 → 일 그대로 · 주 11/23(월) · 월 11/1 · 년 1/1", [B.periodOf("1D", mon), B.periodOf("1W", mon), B.periodOf("1M", mon), B.periodOf("1Y", mon)], [mon, D(2026, 11, 23), D(2026, 11, 1), D(2026, 1, 1)]);
  check("periodEnd: 2월(28일) → 3/1 · 12월 → 다음 해 1/1 · 년 → 다음 해 · 주 +7일 · 일 +1일", [B.periodEnd("1M", D(2026, 2, 1)), B.periodEnd("1M", D(2026, 12, 1)), B.periodEnd("1Y", D(2026, 1, 1)), B.periodEnd("1W", D(2026, 11, 23)), B.periodEnd("1D", mon)], [D(2026, 3, 1), D(2027, 1, 1), D(2027, 1, 1), D(2026, 11, 30), mon + 86400]);
  const days = [
    { t: D(2025, 12, 30), o: 10, h: 12, l: 9, c: 11, v: 100 },
    { t: D(2025, 12, 31), o: 11, h: 15, l: 10, c: 14, v: 200 },
    { t: D(2026, 1, 2), o: 14, h: 16, l: 13, c: 15, v: 300 },
    { t: D(2026, 1, 5), o: 15, h: 15, l: 8, c: 9, v: 400 },
  ];
  const mo = B.groupDaily(days, "1M");
  check("월봉: 12월 = 시10 고15 저9 종14 량300 · 1월 = 시14 고16 저8 종9 량700", mo.flatMap((b) => [b.t, b.o, b.h, b.l, b.c, b.v]), [D(2025, 12, 1), 10, 15, 9, 14, 300, D(2026, 1, 1), 14, 16, 8, 9, 700]);
  const yr = B.groupDaily(days, "1Y");
  check("년봉: 2025 · 2026 두 개 (해가 바뀌면 새 봉)", yr.map((b) => [b.t, b.c, b.v]).flat(), [D(2025, 1, 1), 14, 300, D(2026, 1, 1), 9, 700]);
  check("groupDaily 주봉 = 예전 weekly 그대로 · 일봉은 손대지 않음", [JSON.stringify(B.groupDaily(days, "1W")) === JSON.stringify(B.weekly(days)), B.groupDaily(days, "1D") === days].map(Number), [1, 1]);
  // 주·월 VWAP: 달이 바뀌면 처음부터 (가격 = (고+저+종)/3)
  const vb = [
    { t: D(2026, 1, 30), h: 10, l: 10, c: 10, v: 1 },
    { t: D(2026, 1, 31), h: 20, l: 20, c: 20, v: 1 },
    { t: D(2026, 2, 2), h: 30, l: 30, c: 30, v: 2 },
    { t: D(2026, 2, 3), h: 60, l: 60, c: 60, v: 1 },
  ];
  check("월 VWAP: 1월 10 → 15, 2월에 다시 시작 30 → 40", C.vwap(vb, (t) => B.periodOf("1M", t)).vwap, [10, 15, 30, 40]);
  check("주 VWAP: 1/30(금)·1/31(토) 같은 주, 2/2(월)부터 새 주", C.vwap(vb, (t) => B.periodOf("1W", t)).vwap, [10, 15, 30, 40]);
  // 리플레이 중 월봉 기준 지표: 그달이 끝났는지는 실제 달 길이로 (30일로 어림하면 31일 달은 하루 일찍, 2월은 이틀 늦게 바뀐다)
  const htf = [{ t: D(2026, 1, 1) }, { t: D(2026, 2, 1) }];
  const o = (endT) => ({ htfKey: (x) => x, replaying: true, endT, span: 30 * 86400, endOf: (t) => B.periodEnd("1M", t) });
  const jan = [{ t: D(2026, 1, 30) }];
  check("1월 31일에는 1월이 아직 안 끝남 → 직전 값 (미래 값 안 씀)", mapHtf(jan, htf, [100, 200], o(D(2026, 1, 31)))[0], null);
  const feb = [{ t: D(2026, 2, 27) }];
  check("3월 1일이 되면 2월(28일)이 끝남 → 2월 값 바로", mapHtf(feb, htf, [100, 200], o(D(2026, 3, 1)))[0], 200);
  check("주식 종목은 월봉·년봉 있음 · 풋/콜 같은 심리 지표는 그대로 일·주만", [describe("005930.KS").tfs.includes("1M"), describe("NVDA").tfs.includes("1Y"), describe("bn:BTCUSDT").tfs.includes("1M"), describe("cboe:PC_TOTAL").tfs.includes("1M")].map(Number), [1, 1, 1, 0]);
}

// ── VWAP 밴드 기본 2 · 범례 한마디 (0.26.0) ──
section("VWAP 1배·2배 (0.26.0)");
{
  const { INDICATORS, withDefaults, vwapZone } = await import("../indicators/index.js");
  check("VWAP 밴드 기본 = 2 (1배·2배)", withDefaults({ id: "vwap" }).params.bands, 2);
  // VWAP 100, 1배 ±10, 2배 ±20
  const z = (c) => vwapZone(c, 100, 110, 90, 120, 80);
  check("범례 한마디: 2배 넘음 · 1~2배 · 1배 안(위·아래) · 반대쪽", [z(125), z(115), z(105), z(95), z(85), z(75)].map((s) => ["+2배 넘음 · 따라 사지 말기", "+1~2배 · 강함", "위 · 보통 범위", "아래 · 보통 범위", "−1~2배 · 약함", "−2배 넘음 · 따라 팔지 말기"].indexOf(s)), [0, 1, 2, 3, 4, 5]);
  check("밴드 0이면 위·아래만", [vwapZone(101, 100) === "위 · 사는 쪽", vwapZone(99, 100) === "아래 · 파는 쪽"].map(Number), [1, 1]);
  void INDICATORS;
  const { obosZone } = await import("../indicators/index.js");
  const o = (v, v0) => obosZone(v, v0, 70, 30);
  check("RSI 한마디: 70 위·30 아래 · 막 들어온 봉 · 보통 (앞 봉과 이 봉만 봄)", [o(72, 60), o(25, 40), o(68, 71), o(33, 29), o(50, 55), o(50, null)].map((s) => ["과매수 · 따라 사지 말기", "과매도 · 따라 팔지 말기", "과매수에서 내려옴 · 힘 빠짐", "과매도에서 올라옴 · 반등 기미", "보통"].indexOf(s)), [0, 1, 2, 3, 4, 4]);

}

// ── OKX (0.25.0): 100개씩 주는 거래소를 바이낸스 klines와 같은 약속으로 감싼다 (가짜 거래소로, 인터넷 없이) ──
section("OKX 무기한선물 (0.25.0)");
{
  const OK = await import("../sources/okx.js");
  const { canBackfill } = await import("../trade/history.js");
  // 가짜 거래소: 1분봉이 listed부터 last까지 매분 (10:00~10:30은 거래 멈춤). OKX처럼 최신 것부터, 최대 100개, after(이전)·before(이후)
  const listed = 1_000_000 * 60;
  const last = listed + 1000 * 60;
  const all = [];
  for (let t = listed; t <= last; t += 60) if (!(t >= listed + 300 * 60 && t < listed + 600 * 60)) all.push({ t, o: 1, h: 1, l: 1, c: t / 60, v: 1 });
  let calls = 0;
  const page = async (id, tf, { after = null, before = null, limit = 100 }) => {
    calls++;
    const rows = all.filter((k) => (after == null || k.t * 1000 < after) && (before == null || k.t * 1000 > before));
    return rows.slice(-Math.min(limit, 100)); // 조건에 맞는 것 중 최신 100개 (시간순)
  };
  const kl = OK.makeKlines(page, async () => listed, () => last + 30);
  const fwd = await kl("X-USDT-SWAP", "1m", { startSec: listed + 50 * 60, limit: 150 });
  check("앞으로: 시작 시각부터 150개, 시간순, 빈틈 없음", [fwd.length, fwd[0].t, fwd[149].t, fwd.every((k, i) => !i || k.t - fwd[i - 1].t === 60) ? 1 : 0], [150, listed + 50 * 60, listed + 199 * 60, 1]);
  calls = 0;
  const first = await kl("X-USDT-SWAP", "1m", { startSec: 0, limit: 1 });
  check("첫 봉(startSec 0): 1970년부터 훑지 않고 상장 시각으로 바로 → 요청 1번", [first[0]?.t, calls], [listed, 1]);
  const gap = await kl("X-USDT-SWAP", "1m", { startSec: listed + 250 * 60, limit: 100 });
  check("거래가 멈췄던 구간(300~600분)을 건너뛰고 이어서", [gap.length, gap[49].t, gap[50].t], [100, listed + 299 * 60, listed + 600 * 60]);
  const back = await kl("X-USDT-SWAP", "1m", { endSec: listed + 800 * 60, limit: 250 });
  // 800~600분 = 201개 + 멈췄던 구간 앞 299~251분 = 49개
  check("뒤로: endSec까지(그 봉 포함) 마지막 250개, 멈춘 구간도 건너 시간순", [back.length, back[back.length - 1].t, back[0].t, back[48].t, back[49].t], [250, listed + 800 * 60, listed + 251 * 60, listed + 299 * 60, listed + 600 * 60]);
  const back2 = await kl("X-USDT-SWAP", "1m", { endSec: listed + 100 * 60, limit: 1500 });
  check("뒤로 상장일까지 가면 있는 만큼만 (101개 = 0~100분)", [back2.length, back2[0].t], [101, listed]);
  const latest = await kl("X-USDT-SWAP", "1m", { limit: 120 });
  check("아무것도 안 주면 가장 최근 120개", [latest.length, latest[latest.length - 1].t], [120, last]);
  check("OKX 봉 한 줄 → 거래량은 코인·주식 수(volCcy)", Object.values(OK.toRow(["1795392000000", "61240", "61439.7", "60887.6", "61197.7", "660679.89", "6606.7989", "403985964.8", "0"])), [1795392000, 61240, 61439.7, 60887.6, 61197.7, 6606.7989]);
  check("일·주봉은 UTC 기준(1Dutc·1Wutc) — 바이낸스·하이퍼리퀴드와 같은 날짜", [OK.TF["1D"] === "1Dutc", OK.TF["1W"] === "1Wutc", OK.TF["1h"] === "1H", OK.TF["1M"] === undefined].map(Number), [1, 1, 1, 1]);
  const d = describe("ok:NVDA-USDT-SWAP");
  const s = describe("ok:SAMSUNG-USDT-SWAP");
  check("ok:NVDA-USDT-SWAP → OKX 무기한선물 · 24시간 · 월봉도", [d.kind === "perp", d.daily === "okx", d.symbol === "NVDA-USDT-SWAP", d.label === "NVDA (OKX)", d.rth === null, d.tfs.includes("1M"), s.sub.startsWith("삼성전자")].map(Number), [1, 1, 1, 1, 1, 1, 1]);
  const { normalizeInput } = await import("../core/symbols.js");
  check("직접 입력: ok:samsung → ok:SAMSUNG-USDT-SWAP · 전체 이름은 그대로 · bn:은 예전과 같음", [normalizeInput("ok:samsung") === "ok:SAMSUNG-USDT-SWAP", normalizeInput("OK:nvda-usdt-swap") === "ok:NVDA-USDT-SWAP", normalizeInput("bn:HOODUSDT") === "bn:HOODUSDT"].map(Number), [1, 1, 1]);
  check("과거 1분봉 받기: 바이낸스·OKX는 됨 · 하이퍼리퀴드는 안 됨", [canBackfill(d), canBackfill(describe("bn:BTCUSDT")), canBackfill(describe("hl:BTC"))].map(Number), [1, 1, 0]);
}

// ── 모든 화면 파일이 문법 오류 없이 읽히는지 (하나라도 깨지면 EXE가 검은 화면에서 멈춘다) ──
section("파일 읽기 (문법 오류 없는지)");
{
  const MODULES = ["alerts/engine", "backtest/engine", "backtest/view", "config", "core/bars", "core/colors", "core/csv", "core/events", "core/daily", "core/data", "core/db", "core/estimate", "core/intraday", "core/limit", "core/series", "core/session", "core/stocklist", "core/symbols", "core/tz", "drawings/geom", "drawings/layer", "drawings/store", "indicators/calc", "indicators/cloudboard", "indicators/explain", "indicators/guides", "indicators/index", "indicators/setups", "indicators/sentiment", "indicators/triangle", "platform", "sources/alpaca", "sources/binance", "sources/hyperliquid", "sources/okx", "sources/reconnect", "sources/sentiment", "sources/status", "sources/toss", "sources/yahoo", "trade/engine", "trade/history", "trade/journal", "trade/orderlines", "trade/panel", "ui/alerts", "ui/cell", "ui/dialog", "ui/dom", "ui/drawbar", "ui/format", "ui/goto", "ui/grid", "ui/indpanel", "ui/measure", "ui/menu", "ui/picker", "ui/primitives", "ui/replay", "ui/search", "ui/settings", "ui/sidebar", "ui/snapshot", "ui/statusbar", "ui/tip", "ui/toolbar", "ui/update", "ui/welcome"];
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
