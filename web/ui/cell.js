// 차트 칸 하나 = lightweight-charts 인스턴스 1개 (SPEC §3.1, §3.3, §6)
// - 저장소에서 바로 그리고(빠르게), 뒤에서 이어 받은 것이 오면 다시 그린다
// - 칸마다 종목·봉·지표·가격 기준·눈금이 따로 있다 (cc = 이 칸의 설정, 레이아웃에 저장됨)
import { describe, sourcesOf } from "../core/symbols.js";
import { FOMC_DAYS, earnings } from "../core/events.js";
import { marketOpen } from "../core/session.js";
import { loadSeries, liveTail, dataGaps } from "../core/series.js";
import { TF_SEC, isDailyTf, heikinAshi, mergeRows, mondayOf, bucketOf, applyLiveQuote } from "../core/bars.js";
import { PC_TZ, DAY, tzOffset, localDay, parseYmd, ymd } from "../core/tz.js";
import { TF_NAME } from "../core/data.js";
import { INDICATORS, withDefaults } from "../indicators/index.js";
import { SENTIMENT, stageOf, sentimentTip } from "../indicators/sentiment.js";
import { sma } from "../indicators/calc.js";
import { Bands } from "./primitives.js";
import { createMeasure } from "./measure.js";
import { createDrawings } from "../drawings/layer.js";
import { createMapper } from "../drawings/geom.js";
import { drawingsOf, setDrawings, newId } from "../drawings/store.js";
import { h } from "./dom.js";
import { num, signed, dir, decimalsFor, compact, chartTime, setText, setClass } from "./format.js";
import { logInfo } from "../platform.js";
import { upColor, downColor } from "../core/colors.js";

const FIRST_LIMIT = 4000; // 분봉 처음 읽는 봉 수 (지표가 왼쪽 끝에서 끊기지 않게 넉넉히)
const MORE_LIMIT = 4000;
const WINDOW_BEFORE = 1500; // 날짜로 가기: 그 날짜 앞으로 읽는 봉 수
const WINDOW_AFTER = 3000; // 그 날짜부터 뒤로 읽는 봉 수 (더 가면 오른쪽 끝에서 이어 읽기)
const MAX_BARS = 30000; // 한 칸에 들고 있는 봉 수 상한 (넘으면 안 보는 쪽을 덜어 낸다 → 1초 갱신도 가볍게)
const M1_LIMIT = 20000; // 리플레이: 1분봉을 한 번에 읽는 수 (24시간 시장 약 2주). 끝에 가까워지면 더 읽는다

const BASIS_NAME = { split: "수정주가", total: "배당 포함", raw: "실제 거래가" };

export function createCell(env, cc) {
  const { cfg, data } = env;
  const LC = window.LightweightCharts;

  // ── DOM ──
  const nameEl = h("span.ch-name");
  const subEl = h("span.ch-sub");
  const priceEl = h("span.ch-price");
  const chgEl = h("span.ch-chg");
  const tfEl = h("span.ch-tf");
  const badgeEl = h("span.ch-badge");
  const bellEl = h("span.ch-bell", { "data-tip-text": "이 종목에 켜 둔 알림이 있어요 (🔔 목록에서 보기)" });
  const closeEl = h("button.ch-close", { onclick: (e) => (e.stopPropagation(), env.onClearCell?.(api)), "data-tip-text": "이 칸 차트 지우기 (빈 칸으로)" }, "✕");
  const head = h("div.cell-head", nameEl, subEl, priceEl, chgEl, tfEl, badgeEl, bellEl, closeEl);
  const legend = h("div.legend");
  const msg = h("div.cell-msg", { hidden: true });
  // 빈 칸: 종목을 고르면 채워진다 (분할 화면을 내 마음대로 꾸밀 때)
  const emptyEl = h(
    "div.cell-empty",
    { hidden: true },
    h("button.primary", { onclick: (e) => (e.stopPropagation(), env.onSelect?.(api, e), env.onPickFor?.(api)) }, "＋ 종목 넣기"),
    h("p.hint", "또는 이 칸을 누른 뒤 관심종목에서 종목을 누르세요")
  );
  const nowBtn = h("button.cell-now", { hidden: true, onclick: (e) => (e.stopPropagation(), load("fresh")), "data-tip-text": "과거 한 구간만 보고 있어요\n누르면 지금(최신)으로 돌아가요" }, "⏩ 지금으로");
  const body = h("div.cell-body", legend, msg, emptyEl, nowBtn);
  const root = h("div.cell", head, body);

  // ── 상태 ──
  let info = describe(cc.symbol ?? ""); // 빈 칸(종목 없음)으로 저장돼 있어도 켜질 때 멈추지 않게
  let tf = cc.timeframe ?? "1D";
  let bars = []; // 화면 봉 (분할 반영, 묶은 것)
  let events = [];
  let splits = [];
  let more = false;
  let windowed = false; // 과거 한 구간만 읽은 상태 (오른쪽이 지금까지 안 옴) → 실시간 멈춤, 오른쪽 끝에서 이어 읽기
  let loadingNewer = false;
  let lastRawT = null; // 저장소에서 읽은 마지막 원본 봉 시각 (실시간 꼬리 붙이기 기준)
  let storedLastT = null; // 저장소에서 온 마지막 화면 봉 시각
  let token = 0;
  let loadingMore = false;
  let atOldest = false; // 모의매매: 거래소에도 더 옛날 봉이 없다 (상장일까지 왔다) — 새로 읽으면 다시 false
  let olderWait = 0; // 옛날 봉 받기가 실패하면 잠깐 쉬었다 다시
  let insts = normalizeInds(cc.indicators ?? cfg.indicators);
  let handles = [];
  let indSeries = [];
  let indPrims = [];
  let paneCount = 0;
  const markerSets = new Map();
  let extraMarkers = null; // {sym, days}
  let gaps = null; // 데이터 빈 날 (일봉)
  // ▶ 리플레이 중이면 {full: 전체 봉, endT: 보이는 시각, m1: 그 뒤 1분봉(있으면 1분씩 흘러간다), m1More, newer: 저장소에 full 뒤가 더 있음}
  let replay = null;
  let resumeT = null; // 리플레이 중에 봉을 바꿨다 → 새 봉을 다 읽으면 이 시각부터 이어 간다
  let unsubLive = null;
  let crossIdx = null;
  let decimals = 2;
  const htfCache = new Map(); // 다른 봉 기준 지표의 상위 봉: "봉|가격 기준|프리·애프터" → {bars, from, to, live}
  const htfLoading = new Set();

  const daily = () => isDailyTf(tf);
  const basis = () => cc.basis ?? cfg.chart.price_basis ?? "split";
  const ext = () => !(cfg.chart.regular_hours_only ?? true);
  const chartType = () => (info.line ? "line" : cc.chart_type ?? cfg.chart.chart_type ?? "candle");
  // 비교 종목이 있으면 눈금은 % (보이는 첫 봉 = 0%). "가격 그대로"면 이 종목 눈금은 평소대로 (비교 종목은 왼쪽 눈금)
  const cmpMode = () => (cc.compare_mode === "price" ? "price" : "pct");
  const scaleMode = () => (compareIds().length && cmpMode() === "pct" ? "pct" : cc.scale ?? (daily() ? cfg.chart.scale_daily : cfg.chart.scale_intraday) ?? "normal");
  /** 저장 시각 → 차트 시각 (일·주봉은 날짜 그대로, 분봉은 PC 현지 시각으로 옮긴다) */
  const time = (t) => (daily() ? t : t + PC_TZ);
  const fromTime = (ct) => (daily() ? ct : ct - PC_TZ);

  // ── 차트 ──
  const chart = LC.createChart(body, {
    autoSize: true,
    layout: {
      background: { type: "solid", color: "#0b0d10" },
      textColor: "#a7adb5",
      fontSize: 14,
      fontFamily: '"Segoe UI", "Malgun Gothic", sans-serif',
      attributionLogo: false,
      panes: { separatorColor: "#22272e", separatorHoverColor: "#3a414b", enableResize: true },
    },
    grid: { vertLines: { color: "#161a20" }, horzLines: { color: "#161a20" } },
    rightPriceScale: { borderColor: "#2a2f36", scaleMargins: { top: 0.08, bottom: 0.06 } },
    timeScale: { borderColor: "#2a2f36", timeVisible: true, secondsVisible: false, rightOffset: 6, minBarSpacing: 0.01, tickMarkFormatter: tickFormat },
    crosshair: { mode: 0, vertLine: { color: "#4b5563", labelBackgroundColor: "#2c333d" }, horzLine: { color: "#4b5563", labelBackgroundColor: "#2c333d" } },
    localization: { locale: "ko-KR", timeFormatter: (t) => chartTime(t, !daily()) },
  });

  function tickFormat(t, type) {
    const d = new Date(t * 1000);
    const p = (n) => String(n).padStart(2, "0");
    if (type === 0) return String(d.getUTCFullYear());
    if (type === 1) return `${d.getUTCMonth() + 1}월`;
    if (type === 2) return `${d.getUTCDate()}일`;
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  let main = null;
  let markersApi = null;
  let estLine = null; // 24시간 추정가 점선
  const bands = new Bands(); // 세션 구분선·장 밖 시간 배경

  function createMain() {
    if (main) {
      main.detachPrimitive(bands);
      main.detachPrimitive(drawings.prim);
      chart.removeSeries(main);
    }
    const type = chartType();
    if (type === "line") {
      main = chart.addSeries(LC.LineSeries, { color: info.line ? "#ffb020" : "#e8eaed", lineWidth: 2, priceLineVisible: true });
    } else if (type === "area") {
      main = chart.addSeries(LC.AreaSeries, { lineColor: "#5ec8d8", topColor: "rgba(94,200,216,0.30)", bottomColor: "rgba(94,200,216,0.02)", lineWidth: 2 });
    } else {
      const [UP, DOWN] = [upColor(), downColor()]; // 한국식·미국식 (core/colors.js, ⚙ 설정)
      main = chart.addSeries(LC.CandlestickSeries, { upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN });
    }
    main.attachPrimitive(bands);
    main.attachPrimitive(drawings.prim);
    markersApi = LC.createSeriesMarkers(main, []);
    estLine = null;
    applyScale();
    env.onMain?.(api); // 모의매매 주문선이 새 시리즈에 다시 붙는다
  }

  function applyScale() {
    const m = scaleMode();
    const mode = m === "log" ? LC.PriceScaleMode.Logarithmic : m === "pct" ? LC.PriceScaleMode.Percentage : LC.PriceScaleMode.Normal;
    main.priceScale().applyOptions({ mode }); // 가격 창만 (보조 창 눈금은 그대로 일반)
    applyCmpScales();
    drawings.refresh(); // 로그 눈금이면 선을 log 가격에서 곧게
  }

  /** 비교 "가격 그대로": 첫 비교 종목 = 왼쪽 눈금(보임), 둘째·셋째 = 숨은 눈금. 이 종목과 같은 일반·로그, 같은 위아래 여백 */
  function applyCmpScales() {
    const price = cmpMode() === "price" && compareIds().length > 0;
    chart.applyOptions({ leftPriceScale: { visible: price, borderColor: "#2a2f36" } });
    if (!price) {
      cmpAlign = null;
      legend.style.left = "";
      return;
    }
    const m = scaleMode();
    const mode = m === "log" ? LC.PriceScaleMode.Logarithmic : m === "pct" ? LC.PriceScaleMode.Percentage : LC.PriceScaleMode.Normal;
    cmp.forEach((c, k) => {
      try {
        // 첫 비교 종목은 이 종목 눈금에 맞춘 범위를 그대로 쓴다 (alignLeft) → 여백 0
        c.series.priceScale().applyOptions({ mode, scaleMargins: k === 0 && cmpAlign ? { top: 0, bottom: 0 } : { top: 0.08, bottom: 0.06 } });
      } catch {}
    });
    scheduleAlign();
  }

  // 두 눈금 맞추기: 그냥 두면 두 눈금이 따로 꽉 차서, 같은 높이를 읽어도 실제 관계와 많이 다르다 (SOXL·SOXX 1년: 25% 어긋남).
  // 오른쪽 끝 봉을 기준점으로 "이 종목 % = 배수 × 비교 종목 %". 배수는 보이는 봉의 봉마다 움직임으로 잰다
  // (SOXL·SOXX 2026-10-31: 1달·3달·1년·3년 모두 3.0배. 가격 수준끼리 맞추면 3배 상품의 녹아내림 때문에 1.5~3.4배로 기간마다 달랐다).
  // 두 선이 오른쪽 끝에서 만나고, 가로줄 양 끝 값이 "지금부터 SOXX가 여기 가면 SOXL은 대략 여기"로 읽힌다. 옛날 쪽은 녹아내림만큼 벌어진다
  let cmpAlign = null; // {lo, hi, slope(1%당 몇 %)} 왼쪽 눈금 범위
  let alignRaf = 0;
  function scheduleAlign() {
    if (alignRaf || cmpMode() !== "price" || !cmp.length) return;
    alignRaf = requestAnimationFrame(() => {
      alignRaf = 0;
      alignLeft();
    });
  }
  function alignLeft() {
    const c = cmp[0];
    if (cmpMode() !== "price" || !c || !bars.length) return;
    legend.style.left = `${Math.round(chart.priceScale("left").width()) + 8}px`; // 범례가 왼쪽 눈금 글자를 가리지 않게
    const fit = fitCompare(c);
    const pane = chart.paneSize(0)?.height;
    const top = pane ? main.coordinateToPrice(0) : null;
    const bot = pane ? main.coordinateToPrice(pane) : null;
    let next = null;
    if (fit && top != null && bot != null && (!fit.log || (top > 0 && bot > 0))) next = { lo: fit.toLeft(bot), hi: fit.toLeft(top), slope: fit.slope };
    const same = (a, b) => a === b || (a && b && Math.abs(a.lo - b.lo) <= Math.abs(a.lo) * 1e-6 && Math.abs(a.hi - b.hi) <= Math.abs(a.hi) * 1e-6);
    if (same(next, cmpAlign)) return;
    const had = !!cmpAlign;
    cmpAlign = next;
    if (had !== !!next) applyCmpScales(); // 여백 0 ↔ 평소 여백
    else c.series.priceScale().applyOptions({ autoScale: true }); // 새 범위로 다시 그리기
    paintLegend();
  }
  // 마우스를 올린 시점의 그날 실제 가격을 두 눈금에 (사용자 요청 2026-10-31: "그 시점에 그날 거래가격으로 뜨는 게 맞다").
  // 가격 그대로일 때만: 오른쪽 눈금 = 그날 이 종목 종가(흰색), 왼쪽 눈금 = 그날 비교 종목(그 선 색). 회색 = 마우스 높이(가로선으로 읽기)
  let hoverMarks = []; // [{series, line}]
  function paintHoverPrices() {
    const want = [];
    if (crossIdx != null && cmpMode() === "price" && cmp.length && bars[crossIdx]) {
      want.push({ series: main, price: bars[crossIdx].c, color: "#e8eaed" });
      for (const c of cmp) if (c.vals[crossIdx] != null) want.push({ series: c.series, price: c.vals[crossIdx], color: c.color });
    }
    const next = [];
    for (const w of want) {
      const old = hoverMarks.find((m) => m.series === w.series);
      if (old) {
        old.line.applyOptions({ price: w.price });
        next.push(old);
      } else next.push({ series: w.series, line: w.series.createPriceLine({ price: w.price, color: w.color, lineVisible: false, axisLabelVisible: true, axisLabelColor: w.color, axisLabelTextColor: "#0b0d10", title: "" }) });
    }
    for (const m of hoverMarks) {
      if (next.includes(m)) continue;
      try {
        m.series.removePriceLine(m.line);
      } catch {} // 시리즈를 새로 만들었으면 이미 없다
    }
    hoverMarks = next;
  }

  /** 배수 재기 + 오른쪽 끝 기준점. 같은 방향으로 움직이지 않으면(반대 상품 등) null → 각자 꽉 찬 눈금 */
  function fitCompare(c) {
    const m = scaleMode();
    if (m === "pct") return null;
    const r = chart.timeScale().getVisibleLogicalRange();
    if (!r) return null;
    const i0 = Math.max(0, Math.ceil(r.from));
    let n = Math.min(bars.length - 1, Math.floor(r.to));
    const ok = (i) => c.fresh?.[i] && c.vals[i] > 0 && bars[i].c > 0; // 기준점 = 두 종목 봉이 다 있는 마지막 봉
    while (n >= i0 && !ok(n)) n--;
    const k = leverageOf(c, i0, n);
    if (!k) return null;
    const X = c.vals[n];
    const Y = bars[n].c;
    // 오른쪽 가격 y ↔ 왼쪽 가격 x. 로그 눈금: ln(y/Y) = k·ln(x/X) · 일반 눈금: 기준점에서의 기울기로 곧게 (y − Y) = k·(Y/X)·(x − X)
    const toLeft = m === "log" ? (y) => X * Math.exp(Math.log(y / Y) / k) : (y) => X + ((y - Y) * X) / (k * Y);
    return { log: m === "log", toLeft, slope: k };
  }
  /** 봉마다 움직임(로그 수익률)으로 "이 종목 % = k × 비교 종목 %"의 k (i0~n 봉, 5개 넘게 있어야). 앞 값을 끌어온 봉은 빼고 (움직임 0으로 세면 k가 작아진다) */
  function leverageOf(c, i0, n) {
    const vals = c.vals;
    let sxy = 0;
    let sxx = 0;
    let cnt = 0;
    for (let i = i0 + 1; i <= n; i++) {
      if (!(c.fresh?.[i] && c.fresh[i - 1] && vals[i] > 0 && vals[i - 1] > 0 && bars[i].c > 0 && bars[i - 1].c > 0)) continue;
      const dx = Math.log(vals[i] / vals[i - 1]);
      sxy += dx * Math.log(bars[i].c / bars[i - 1].c);
      sxx += dx * dx;
      cnt++;
    }
    return cnt > 5 && sxx > 0 && sxy > 0 ? sxy / sxx : null;
  }

  function applyPriceFormat() {
    const last = bars[bars.length - 1]?.c;
    decimals = decimalsFor(info, last);
    if (info.yieldLike) main.applyOptions({ priceFormat: { type: "custom", formatter: (v) => `${v.toFixed(3)}%`, minMove: 0.001 } });
    else main.applyOptions({ priceFormat: { type: "price", precision: decimals, minMove: 1 / 10 ** decimals } });
  }

  // ── 비교 겹쳐 보기 (SPEC §3.1 비교＋): 다른 종목을 같은 % 눈금에 선으로. 이 칸 봉 시각에 맞춰서(밤 시간 칸이 끼지 않게) ──
  // "가격 그대로"(cc.compare_mode = "price", 사용자 요청 2026-10-31 "SOXX가 얼마면 SOXL이 대략 얼마"):
  // 비교 종목은 제 가격 그대로 왼쪽 눈금에 → 십자선 가로줄 양 끝에 두 가격이 같이 나온다 (보이는 기간 안에서 맞춘 대략값)
  const CMP_COLORS = ["#ff8a3d", "#4cd5a0", "#b18cff"];
  let cmp = []; // [{id, info, color, series, raw, vals}]
  let cmpKey = "";
  function compareIds() {
    return (cc.compare ?? []).filter((x) => x && x !== cc.symbol).slice(0, 3);
  }

  async function syncCompare(force = false) {
    const ids = cc.symbol ? compareIds() : [];
    const key = `${ids.join(",")}|${tf}|${basis()}|${ext()}|${cmpMode()}`;
    const covered = cmp.every((c) => !c.raw.length || daily() || !bars.length || c.raw[0].t <= bars[0].t + 7 * DAY);
    if (!force && key === cmpKey && covered) return alignCompare();
    cmpKey = key;
    for (const c of cmp) {
      try {
        chart.removeSeries(c.series);
      } catch {}
    }
    const own = cmpMode() === "price"; // 가격 그대로 = 종목마다 제 눈금
    cmpAlign = null;
    // 첫 비교 종목(왼쪽 눈금)은 이 종목 눈금에 맞춘 범위로 (alignLeft)
    const aligned = (orig) => (cmpAlign ? { priceRange: { minValue: Math.min(cmpAlign.lo, cmpAlign.hi), maxValue: Math.max(cmpAlign.lo, cmpAlign.hi) } } : orig());
    cmp = ids.map((id, k) => {
      const ci = describe(id);
      const opts = { color: CMP_COLORS[k], lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: own, title: ci.label, ...(own ? { priceScaleId: k === 0 ? "left" : `cmp${k}`, ...(k === 0 ? { autoscaleInfoProvider: aligned } : {}) } : {}) };
      return { id, info: ci, color: CMP_COLORS[k], series: chart.addSeries(LC.LineSeries, opts), raw: [], vals: [] };
    });
    applyCmpScales();
    if (!cmp.length || !bars.length) return;
    const my = token;
    const want = daily() ? undefined : Math.min(200000, Math.ceil((bars[bars.length - 1].t - bars[0].t) / TF_SEC[tf]) + 600);
    for (const c of cmp) {
      if (!c.info.tfs.includes(tf)) continue; // 이 봉이 없는 종목 (예: 심리 지표는 일봉만)
      try {
        const s = await loadSeries(c.info, tf, daily() ? { basis: basis(), ext: ext() } : { basis: basis(), ext: ext(), after: bars[0].t - 7 * DAY, limit: want });
        if (my !== token) return;
        c.raw = s.bars;
        // 처음이면 받아 두기, 있으면 이어 받기 → 받으면 다시 그린다 (관심종목이 아닌 비교 종목은 켤 때 이어 받지 않아서
        // 며칠 늦어 있었다: 2026-10-31 SOXX가 10-28에 멈춰 SOXL 10-30과 짝이 틀림. 10분 안에 다시 부르면 data가 건너뛴다)
        data.ensure(c.info, tf).catch(() => {});
      } catch (e) {
        console.warn("[compare]", c.id, e);
      }
    }
    alignCompare();
    paintLegend();
  }

  /** 비교 종목 값을 이 칸 봉 시각에 맞추기 (그 시각까지의 마지막 값) */
  function alignCompare() {
    const span = TF_SEC[tf] ?? DAY;
    for (const c of cmp) {
      const vals = new Array(bars.length).fill(null);
      const fresh = new Uint8Array(bars.length); // 그 봉 시각에 비교 종목 봉이 진짜 있나 (앞 값을 끌어온 게 아니라) → 눈금 맞추기는 이것만
      let j = -1;
      for (let i = 0; i < bars.length; i++) {
        while (j + 1 < c.raw.length && c.raw[j + 1].t <= bars[i].t) j++;
        if (j >= 0) {
          vals[i] = c.raw[j].c;
          fresh[i] = bars[i].t - c.raw[j].t < span ? 1 : 0;
        }
      }
      c.vals = vals;
      c.fresh = fresh;
      c.series.setData(bars.flatMap((b, i) => (vals[i] == null ? [] : [{ time: time(b.t), value: vals[i] }])));
      // 왼쪽 눈금·범례 소수점은 그 종목 가격대에 맞게 (삼성전자 60,000 / SOXX 250.12)
      const last = c.raw[c.raw.length - 1]?.c;
      if (last != null) {
        c.decimals = decimalsFor(c.info, last);
        c.series.applyOptions({ priceFormat: { type: "price", precision: c.decimals, minMove: 1 / 10 ** c.decimals } });
      }
    }
    scheduleAlign();
  }

  /** 마지막 봉의 비교 종목 값: 실시간이면 현재가(그 봉 시각 안에 온 것만),
   *  리플레이·과거 구간이면 그 시각까지 저장된 값 — 현재가(미래 값)를 쓰지 않는다 (QA N3) */
  function updateCompareLast() {
    const i = bars.length - 1;
    if (i < 0) return;
    const live = !replay && !windowed;
    for (const c of cmp) {
      let v = null;
      let fresh = false;
      if (live) {
        const q = data.quote(c.id);
        if (q?.price != null && !(q.ts < bars[i].t)) (v = q.price), (fresh = true);
      }
      if (v == null) {
        const j = lowerBound(c.raw, (b) => b.t, bars[i].t + 1) - 1; // 이 봉 시각까지의 마지막 값
        v = j >= 0 ? c.raw[j].c : c.vals[i - 1] ?? null;
        fresh = j >= 0 && bars[i].t - c.raw[j].t < (TF_SEC[tf] ?? DAY);
      }
      if (v == null) continue;
      c.vals[i] = v;
      if (c.fresh?.length > i) c.fresh[i] = fresh ? 1 : 0;
      try {
        c.series.update({ time: time(bars[i].t), value: v });
      } catch {}
    }
    scheduleAlign();
  }

  // ── 지표 ──
  function normalizeInds(list) {
    const counts = {};
    return (list ?? []).map((x) => withDefaults(x, (counts[x.id] = (counts[x.id] ?? -1) + 1))).filter(Boolean);
  }

  const ctx = {
    LC,
    chart,
    get info() {
      return info;
    },
    get tf() {
      return tf;
    },
    get decimals() {
      return decimals;
    },
    get log() {
      return scaleMode() === "log";
    },
    time,
    tfName: (t) => TF_NAME[t] + "봉",
    fmt: (v) => (v == null ? "—" : num(v, decimals)),
    compact,
    addLine(pane, o) {
      return keep(chart.addSeries(LC.LineSeries, { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...o }, pane), pane);
    },
    addHist(pane, o) {
      return keep(chart.addSeries(LC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, ...o }, pane), pane);
    },
    addArea(pane, o) {
      return keep(chart.addSeries(LC.AreaSeries, { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...o }, pane), pane);
    },
    newPane: () => ++paneCount,
    attach(p) {
      main.attachPrimitive(p);
      indPrims.push(p);
    },
    setMarkers(key, list) {
      markerSets.set(key, list);
      applyMarkers();
    },
    /** 분봉의 세션(하루) 구분 값 */
    dayKey: (t) => Math.floor((t + tzOffset(info.tz, t)) / DAY),
    /** 하루 중 몇 초째 (거래소 현지 시각) */
    tod: (t) => localSecOf(t),
    isRegular: (t) => !info.rth || inRth(t),
    isPre: (t) => !!info.rth && localSecOf(t) < info.rth[0] && localSecOf(t) >= 4 * 3600,
    /** 다른 봉 기준 지표용 상위 봉 t. 저장소에서 읽은 것 + 맨 끝은 이 칸 봉을 직접 묶어서 실시간으로 (QA N2).
     *  과거 구간을 보면 그 구간을 다시 읽는다 (QA N7). 처음에는 null → 읽고 나서 다시 그린다 */
    htf(t) {
      const c = htfCache.get(htfCacheKey(t));
      if (!c || !htfCovers(c)) loadHtf(t);
      return c ? withHtfTail(c.bars, t) : null;
    },
    /** 지금 봉 시각 → 상위 봉 t의 시각과 비교할 값 (상위 봉마다 따로 — 일봉은 날짜, 15분은 시각. QA N1) */
    htfKeyOf: (t) => (isDailyTf(t) && !daily() ? (x) => (t === "1W" ? mondayOf(localDay(info.dayTz, x)) : localDay(info.dayTz, x)) : (x) => x),
    get replaying() {
      return !!replay;
    },
    /** 리플레이 시각 (그때까지 끝난 것만 보인다) → 기준 봉 지표가 "정각에 막 끝난 상위 봉"을 알아본다 (0.16.0) */
    get replayEnd() {
      return replay?.endT ?? null;
    },
    /** 자동 삼각수렴 → 직접 그린 Triangle Pattern으로 고정 */
    pinTriangle(tri) {
      const m = createMapper(drawView());
      const pts = [tri.up[0], tri.dn[0], tri.up[1], tri.dn[1]].map((x) => m.point(x.i, x.p));
      setDrawings(info.id, [...drawingsOf(info.id), { id: newId(), type: "triangle", pts, color: "#b18cff", width: 2, extL: false, extR: false, locked: false }]);
      env.toast?.("그림으로 고정했어요 · 이제 점을 끌어서 고칠 수 있어요");
    },
  };

  /** 지표 선 기억 + 보조 창 눈금은 항상 일반 (새 창은 가격 창의 로그 눈금을 물려받는다) */
  function keep(series, pane) {
    indSeries.push(series);
    if (pane > 0) series.priceScale().applyOptions({ mode: LC.PriceScaleMode.Normal, autoScale: true });
    return series;
  }

  const localSecOf = (t) => {
    const l = t + tzOffset(info.tz, t);
    return l - Math.floor(l / DAY) * DAY;
  };
  const inRth = (t) => {
    const s = localSecOf(t);
    return s >= info.rth[0] && s < info.rth[1];
  };

  const htfCacheKey = (t) => `${t}|${basis()}|${ext() ? 1 : 0}`;
  /** 읽어 둔 상위 봉이 지금 차트 범위를 덮는지 (읽은 "범위"로 본다 → 저장소에 더 옛 자료가 없어도 또 읽지 않는다) */
  function htfCovers(c) {
    if (!bars.length) return true;
    return c.from <= bars[0].t && (c.live || c.to >= bars[bars.length - 1].t);
  }

  async function loadHtf(t) {
    const key = htfCacheKey(t);
    if (htfLoading.has(key)) return;
    htfLoading.add(key);
    const my = token;
    const now = Date.now() / 1000;
    const first = bars[0]?.t ?? now;
    const last = bars[bars.length - 1]?.t ?? now;
    // 일·주봉은 늘 전부 읽는다. 분봉은 이 칸 봉 범위 + 앞쪽으로 상위 봉 약 250개(지표가 왼쪽에서 끊기지 않게, 달력 기준이라 넉넉히)
    const all = isDailyTf(t) && info.kind !== "perp";
    const after = all ? -Infinity : first - 1200 * TF_SEC[t];
    try {
      const s = await loadSeries(info, t, all ? { basis: basis(), ext: ext() } : { basis: basis(), ext: ext(), after, limit: Math.min(60000, Math.ceil((last - after) / TF_SEC[t]) + 50) });
      if (my !== token) return;
      // 읽은 범위의 끝 = 읽은 마지막 상위 봉이 끝나는 때. 리플레이 중에 읽은 것은 그 시각 근처까지만 있으니 "지금까지(live)"로 치지 않는다.
      // 0.16.0: 전에는 리플레이 중에도 live로 남겨서, 리플레이를 다시 시작하거나 끝낸 뒤 이 옛 자료를 계속 써 선이 옛 값에 멈췄다
      // (시험: BTC 5분봉 "15분 20" = 63,030 · 지금 가격 78,000. 예전 "기준 봉" SMA도 같았다)
      const lastHtf = s.bars.length ? s.bars[s.bars.length - 1].t + TF_SEC[t] : last;
      htfCache.set(key, { bars: s.bars, from: after, to: Math.max(last, lastHtf), live: all || (!replay && !windowed) });
      renderIndicators(0);
      paintLegend(); // 범례가 "—"로 남지 않게 (QA N10)
    } catch (e) {
      console.warn("[cell] 기준 봉 읽기 실패", e);
    } finally {
      htfLoading.delete(key);
    }
  }

  /** 상위 봉 맨 끝(지금 만들어지는 봉)부터는 이 칸 봉을 직접 묶어서 바꾼다 → 실시간으로 움직인다 */
  function withHtfTail(base, t) {
    if (!bars.length || !base.length) return base;
    const bucket = htfBucketOf(t);
    const lastT = base[base.length - 1].t;
    const i = lowerBound(bars, (b) => bucket(b.t), lastT);
    // 이 칸이 그보다 앞에서 끝났거나(과거 구간), 그 상위 봉의 앞부분이 이 칸에 없으면(잘림) 저장된 것 그대로
    if (i <= 0 || i >= bars.length) return base;
    const dayLike = isDailyTf(t) && !daily();
    const tail = [];
    let cur = null;
    for (let k = i; k < bars.length; k++) {
      const b = bars[k];
      if (dayLike && info.rth && !inRth(b.t)) continue; // 일봉은 정규장만 (저장된 일봉과 같게)
      const key = bucket(b.t);
      if (!cur || cur.t !== key) {
        cur = { t: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 };
        tail.push(cur);
      } else {
        if (b.h > cur.h) cur.h = b.h;
        if (b.l < cur.l) cur.l = b.l;
        cur.c = b.c;
        cur.v += b.v ?? 0;
      }
    }
    if (!tail.length) return base;
    let cut = base.length;
    while (cut > 0 && base[cut - 1].t >= tail[0].t) cut--;
    return base.slice(0, cut).concat(tail);
  }
  /** 이 칸 봉 시각 → 그 봉이 들어갈 상위 봉 t의 시작 (저장소가 묶는 규칙과 같게) */
  function htfBucketOf(t) {
    if (isDailyTf(t)) return daily() ? (x) => mondayOf(x) : ctx.htfKeyOf(t);
    const sec = TF_SEC[t];
    const anchor = ext() ? info.extAnchor : info.anchor;
    return (x) => bucketOf(x, sec, info.tz, anchor ?? 0);
  }

  /** 풋/콜 5일 평균선 (하루하루 출렁임이 커서) */
  function avgLine(n) {
    const s = ctx.addLine(0, { color: "#ff8a3d", lineWidth: 2 });
    let vals = [];
    return {
      inst: { id: "sma", uid: "avg" },
      series: [s],
      render(list, from) {
        vals = sma(list.map((b) => b.c), n);
        if (!from) s.setData(list.flatMap((b, i) => (vals[i] == null ? [] : [{ time: time(b.t), value: vals[i] }])));
        else for (let i = from; i < list.length; i++) if (vals[i] != null) s.update({ time: time(list[i].t), value: vals[i] });
      },
      legend: (i) => [{ label: `${n}일 평균`, value: vals[i] == null ? "—" : vals[i].toFixed(2), color: "#ff8a3d" }],
    };
  }

  /** FOMC 결정일·실적 발표일 표시 (미국 종목·지수). 분봉은 FOMC 발표 시각(14:00 뉴욕) 봉, 실적은 그날 첫 봉
   *  켜고 끄기: 보기 ▾ 또는 ⚙ 설정 → 차트 (FOMC는 기본 끔) */
  let earn = null;
  async function calendarMarkers() {
    const us = cc.symbol && info.tz === "America/New_York" && (info.kind === "us" || info.kind === "index");
    const showFomc = us && bars.length && (cfg.chart.show_fomc ?? false);
    const showEarn = us && bars.length && info.kind === "us" && (cfg.chart.show_earn ?? true);
    if (!showEarn) {
      markerSets.delete("earn");
      earn = null;
    }
    if (!showFomc) markerSets.delete("fomc");
    else {
      const mk = (i) => ({ time: time(bars[i].t), position: "belowBar", shape: "square", size: 0.6, color: "#b18cff", text: "FOMC" });
      const fomc = [];
      for (const d of FOMC_DAYS) {
        if (d < bars[0].t - 7 * DAY) continue;
        const i = daily() ? indexAtMoment({ t: d, daily: true }) : indexAtMoment({ t: d - tzOffset("America/New_York", d) + 14 * 3600, daily: false });
        if (i >= 0) fomc.push(mk(i));
      }
      markerSets.set("fomc", fomc);
    }
    applyMarkers();
    if (!showEarn) return;
    const mk = (i, text, color) => ({ time: time(bars[i].t), position: "belowBar", shape: "square", size: 0.6, color, text });
    const id = info.id;
    const e = await earnings(id.replace(/-/g, ".")).catch(() => null);
    if (!e || id !== info.id) return;
    earn = e;
    markerSets.set("earn", e.past.map((d) => indexAtMoment({ t: d, daily: true })).filter((i) => i >= 0).map((i) => mk(i, "실적", "#ffb020")));
    applyMarkers();
    paintLegend();
  }

  function eventMarkers() {
    const sent = SENTIMENT[info.id];
    if (!sent || !(cfg.chart.show_sentiment_events ?? true) || !daily() || !bars.length) return markerSets.delete("events");
    const m = [];
    for (const [d, name, v] of sent.events) {
      let t = parseYmd(d);
      if (tf === "1W") t = mondayOf(t);
      const i = lowerBound(bars, (b) => b.t, t);
      if (i >= bars.length || bars[i].t - t > 7 * DAY) continue;
      m.push({ time: time(bars[i].t), position: "aboveBar", shape: "circle", size: 0.5, color: "#ffb020", text: `${name} ${v}` });
    }
    markerSets.set("events", m);
  }

  function clearIndicators() {
    for (const s of indSeries) chart.removeSeries(s);
    for (const p of indPrims) main.detachPrimitive(p);
    while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);
    indSeries = [];
    indPrims = [];
    handles = [];
    paneCount = 0;
    for (const k of [...markerSets.keys()]) if (k !== "splits" && k !== "events" && k !== "drawings" && k !== "trade") markerSets.delete(k);
  }

  function buildIndicators() {
    clearIndicators();
    const sent = SENTIMENT[info.id];
    const showSent = sent && (cfg.chart.show_sentiment_events ?? true);
    bands.setPriceBands(showSent ? sent.stages.map((x) => ({ lo: x.lo, hi: x.hi, color: x.color })) : []);
    if (sent?.avg) handles.push(avgLine(sent.avg));
    // 심리 지표(풋/콜·공포탐욕)는 가격 지표 대신 단계 띠·사건·평균선만
    for (const inst of info.kind === "sentiment" ? [] : insts) {
      const def = INDICATORS[inst.id];
      if (!def || inst.hidden) continue;
      if (def.needsVolume && !info.volume) continue;
      if (def.intradayOnly && daily()) continue;
      if (def.dailyOnly && !daily()) continue;
      if (info.line && def.pane === "sub" && inst.id !== "rsi") continue; // 심리 지표에는 가격 보조지표가 의미 없다
      try {
        handles.push({ inst, def, ...def.make(ctx, inst) });
      } catch (e) {
        console.warn("[cell] 지표 만들기 실패", inst.id, e);
      }
    }
    // 창 높이: 가격 창 3, 보조 창 1씩
    const panes = chart.panes();
    panes[0]?.setStretchFactor(panes.length > 3 ? 2.2 : 3);
    for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);
    renderIndicators(0);
  }

  function renderIndicators(from) {
    for (const hd of handles) {
      try {
        hd.render(bars, from);
      } catch (e) {
        if (from) {
          try {
            hd.render(bars, 0);
          } catch {}
        } else console.warn("[cell] 지표 그리기 실패", hd.inst.id, e);
      }
    }
  }

  function applyMarkers() {
    const all = [];
    for (const list of markerSets.values()) all.push(...list);
    // 백테스트 "차트에서 보기": 매수한 날 점 (일봉에서만)
    if (extraMarkers?.sym === info.id && tf === "1D" && bars.length) {
      const have = new Set(bars.map((b) => b.t));
      for (const d of extraMarkers.days) if (have.has(d)) all.push({ time: d, position: "belowBar", shape: "circle", size: 0.4, color: "#4cd5a0" });
    }
    all.sort((a, b) => a.time - b.time);
    markersApi?.setMarkers(all);
  }

  /** 분할·병합 표시 */
  function splitMarkers() {
    if (!cfg.chart.show_split_markers || !splits.length || !bars.length) return markerSets.delete("splits");
    const m = [];
    for (const s of splits) {
      // 그날(또는 그 뒤 첫 봉)에 표시
      const target = tf === "1W" ? mondayOf(s.t) : s.t;
      const dayOf = (b) => (daily() ? b.t : localDay(info.dayTz, b.t));
      const i = lowerBound(bars, dayOf, target);
      if (i >= bars.length) continue;
      // 받아 둔 봉보다 한참 옛날 분할은 첫 봉에 붙이지 않는다 (삼성전자 2018년 50:1이 2024-11 4시간봉 첫 봉에 붙어 있었다)
      if (i === 0 && dayOf(bars[0]) - target > 7 * DAY) continue;
      const fwd = s.r >= 1;
      const ratio = fwd ? `${fmtR(s.r)}:1` : `1:${fmtR(1 / s.r)}`;
      m.push({ time: time(bars[i].t), position: "aboveBar", shape: "square", size: 0.5, color: fwd ? "#ffb020" : "#b18cff", text: `${fwd ? "분할" : "병합"} ${ratio}` });
    }
    markerSets.set("splits", m);
  }
  const fmtR = (r) => (Math.abs(r - Math.round(r)) < 1e-6 ? String(Math.round(r)) : r.toFixed(3));

  /** 세션 구분선(날짜가 바뀌는 곳)과 장 밖 시간 배경 */
  function paintSessions() {
    if (daily() || !(cfg.chart.session_breaks ?? true) || !bars.length) {
      bands.setTimeBands([]);
      return;
    }
    const out = [];
    let key = null;
    let off = null;
    for (let i = 0; i < bars.length; i++) {
      const k = ctx.dayKey(bars[i].t);
      if (key !== null && k !== key) out.push({ from: i, to: i, line: true, color: "rgba(160,166,174,0.18)" });
      key = k;
      if (info.rth && ext()) {
        const outside = !inRth(bars[i].t);
        if (outside && off == null) off = i;
        if (!outside && off != null) {
          out.push({ from: off, to: i - 1, color: "rgba(255,255,255,0.035)" });
          off = null;
        }
      }
    }
    if (off != null) out.push({ from: off, to: bars.length - 1, color: "rgba(255,255,255,0.035)" });
    bands.setTimeBands(out);
  }

  // ── 그리기 ──
  const toMain = (list) => {
    const type = chartType();
    if (type === "line" || type === "area") return list.map((b) => ({ time: time(b.t), value: b.c }));
    const src = type === "heikin" ? heikinAshi(list) : list;
    return src.map((b) => ({ time: time(b.t), open: b.o, high: b.h, low: b.l, close: b.c }));
  };

  /** view: "fresh"(기본 범위) | "keep"(보던 자리) | "follow"(새 봉: 보던 자리 그대로 따라가기) | {shift:n} */
  function setBars(next, view = "keep") {
    const ts = chart.timeScale();
    const atEnd = (ts.scrollPosition?.() ?? 0) >= -2;
    const range = ts.getVisibleLogicalRange();
    const prev = bars;
    bars = next;
    gaps = tf === "1D" && info.kind !== "sentiment" && info.kind !== "perp" ? dataGaps(bars) : null;
    applyPriceFormat();
    main.setData(toMain(bars));
    drawings.refresh();
    splitMarkers();
    eventMarkers();
    calendarMarkers();
    applyMarkers();
    paintSessions();
    renderIndicators(0);
    syncCompare();
    if (view === "fresh") applyDefaultRange();
    else if (view?.shift && range) ts.setVisibleLogicalRange({ from: range.from + view.shift, to: range.to + view.shift });
    else if (view === "follow") followView(prev, range, atEnd);
    else if (range && view !== "none") ts.setVisibleLogicalRange(range);
    msg.hidden = bars.length > 0;
    paintLegend();
    paintHead();
    paintEstimate();
  }

  /**
   * 새 봉이 들어와 다시 그렸을 때 보던 자리 지키기:
   * - 끝을 보고 있었으면: 라이브러리가 오른쪽 빈칸(끌어서 비워 둔 곳)까지 그대로 두고 새 봉을 따라간다.
   *   전에는 여기서 "맨 끝으로"를 불러서 비워 둔 빈칸이 사라지고 봉이 오른쪽으로 다시 붙었다 → 마지막 봉이 화면 밖으로 밀렸을 때만
   * - 과거를 보고 있었으면: 같은 시각의 봉이 같은 자리에 (가운데에 봉이 끼어도 밀리지 않게)
   */
  function followView(prev, range, atEnd) {
    const ts = chart.timeScale();
    if (!range || !prev.length || !bars.length) return;
    if (atEnd) {
      const r = ts.getVisibleLogicalRange();
      if (r && r.to < bars.length - 1) ts.scrollToRealTime();
      return;
    }
    const i0 = Math.min(prev.length - 1, Math.max(0, Math.round(range.from)));
    const d = lowerBound(bars, (b) => b.t, prev[i0].t) - i0;
    if (d) ts.setVisibleLogicalRange({ from: range.from + d, to: range.to + d });
  }

  /** 끝부분만 바뀐 경우 빠르게 (실시간) */
  function updateBars(next) {
    const n0 = bars.length;
    if (!n0 || next.length < n0 || next.length > n0 + 3) return setBars(next, "follow");
    // 마지막 봉 이전이 바뀌었으면 전체 다시
    for (let i = Math.max(0, n0 - 3); i < n0 - 1; i++) {
      const a = bars[i];
      const b = next[i];
      if (a.t !== b.t || a.c !== b.c || a.h !== b.h || a.l !== b.l) return setBars(next, "follow");
    }
    if (next[n0 - 1].t !== bars[n0 - 1].t) return setBars(next, "follow");
    bars = next;
    const from = n0 - 1;
    const pts = toMain(chartType() === "heikin" ? bars : bars.slice(from));
    const tail = chartType() === "heikin" ? pts.slice(from) : pts;
    try {
      for (const p of tail) main.update(p);
    } catch {
      return setBars(next, "follow");
    }
    renderIndicators(from);
    drawings.refresh();
    if (next.length !== n0) paintSessions();
    if (cmp.length) updateCompareLast();
    if (crossIdx == null) paintLegend();
    paintHead();
  }

  function applyDefaultRange() {
    // 차트 크기가 아직 안 잡혔으면(막 만든 칸) 한 프레임 뒤에 — 크기 0에서 맞추면 오른쪽 끝에 몰린다
    if (!body.clientWidth) return requestAnimationFrame(applyDefaultRange);
    requestAnimationFrame(() => {
      const ts = chart.timeScale();
      const n = bars.length;
      if (!n) return;
      if (daily()) {
        setRange(cc.range ?? "all");
      } else {
        const show = { "1m": 180, "5m": 160, "15m": 140, "30m": 140, "1h": 140, "4h": 140 }[tf] ?? 150;
        ts.setVisibleLogicalRange({ from: n - show, to: n + 5 });
      }
    });
  }

  /** 기간 버튼: 1M 3M 6M YTD 1Y 3Y 5Y 10Y all / 1D 5D (분봉) */
  function setRange(key) {
    cc.range = key;
    env.onChange?.();
    const ts = chart.timeScale();
    const n = bars.length;
    if (!n) return;
    if (key === "all") {
      ts.fitContent();
      return;
    }
    const last = bars[n - 1].t;
    let from;
    if (key === "YTD") {
      const d = new Date(last * 1000);
      from = Date.UTC(d.getUTCFullYear(), 0, 1) / 1000;
    } else {
      const m = /^(\d+)([DMY])$/.exec(key);
      if (!m) return;
      const k = +m[1];
      from = m[2] === "D" ? last - k * DAY : m[2] === "M" ? last - k * 30.44 * DAY : last - k * 365.25 * DAY;
      if (!daily() && m[2] === "D") {
        // 분봉 1일·5일 = 최근 거래일 k일
        const days = [];
        for (let i = n - 1; i >= 0 && days.length <= k; i--) {
          const dk = ctx.dayKey(bars[i].t);
          if (days[days.length - 1] !== dk) days.push(dk);
          if (days.length > k) {
            from = bars[i + 1].t;
            break;
          }
          from = bars[i].t;
        }
      }
    }
    const i = lowerBound(bars, (b) => b.t, from);
    ts.setVisibleLogicalRange({ from: Math.max(0, i) - 0.5, to: n + 3 });
  }

  // ── 범례·머리줄 ──
  function paintLegend() {
    if (!cc.symbol) return legend.replaceChildren();
    const i = crossIdx ?? bars.length - 1;
    const b = bars[i];
    const rows = [];
    const top = [h("b.lg-sym", info.label), h("span.lg-dim", ` ${TF_NAME[tf]}봉${info.line || !info.splits ? "" : ` · ${BASIS_NAME[basis()]}`}`)];
    if (b) {
      const prev = bars[i - 1]?.c;
      const ch = prev ? (b.c / prev - 1) * 100 : null;
      const cls = ch == null ? "flat" : dir(ch);
      const f = (v) => num(v, decimals);
      if (info.line) top.push(h(`span.lg-v.${cls}`, ` ${f(b.c)}`));
      else top.push(h("span.lg-ohlc", ` 시 ${f(b.o)} 고 ${f(b.h)} 저 ${f(b.l)} 종 `), h(`span.lg-v.${cls}`, f(b.c)));
      // 수정주가·배당 포함으로 볼 때: 그날 실제로 거래된 종가도 같이 (분할·병합 전 봉만 다르다)
      if (b.k && Math.abs(b.k - 1) > 1e-9 && !info.line) {
        top.push(h("span.lg-real", { "data-tip-text": `그날 실제로 거래된 종가예요\n차트는 그 뒤 분할·병합${basis() === "total" ? "·배당" : ""}을 지금 기준으로 맞춘 값이라 숫자가 달라요\n(모양과 % 변화는 차트가 정확해요)` }, ` 실제 ${f(b.c / b.k)}`));
      }
      if (ch != null) top.push(h(`span.lg-v.${cls}`, ` ${signed(ch, 2)}%`));
      if (info.volume && b.v) top.push(h("span.lg-dim", ` 거래량 ${compact(b.v)}`));
    }
    rows.push(h("div.lg-row", top));
    if (cmp.length && b) {
      const r = chart.timeScale().getVisibleLogicalRange();
      const i0 = r ? Math.max(0, Math.min(bars.length - 1, Math.ceil(r.from))) : 0;
      const pctOf = (vals, at) => {
        let k = i0;
        while (k < at && vals[k] == null) k++;
        return vals[k] != null && vals[at] != null && vals[k] ? (vals[at] / vals[k] - 1) * 100 : null;
      };
      const mainPct = pctOf(bars.map((x) => x.c), i);
      // 가격도 같이 (사용자 요청 2026-10-31): 지난 봉에 마우스를 올리면 "그때 SOXX가 얼마일 때 SOXL이 얼마"
      const pctText = (p) => (p == null ? "" : ` (${signed(p, 2)}%)`);
      const fitText = cmpAlign ? ` · 보이는 기간 ${cmp[0].info.label} 1% ≈ ${info.label} ${num(cmpAlign.slope, 1)}%` : "";
      const head = cmpMode() === "price" ? `비교 (왼쪽 눈금 = ${cmp[0].info.label}${fitText}) ` : "비교 (보이는 첫 봉 = 0%) ";
      const cells = [h("span.lg-dim", head), h("b", info.label), h(`span.lg-v.${mainPct == null ? "flat" : dir(mainPct)}`, ` ${num(b.c, decimals)}${pctText(mainPct)}`)];
      for (const c of cmp) {
        const p = pctOf(c.vals, i);
        const v = c.vals[i];
        cells.push(h("span", "  "), h("b", { style: `color:${c.color}` }, c.info.label), h(`span.lg-v.${p == null ? "flat" : dir(p)}`, v == null ? " —" : ` ${num(v, c.decimals ?? decimalsFor(c.info, v))}${pctText(p)}`));
      }
      rows.push(h("div.lg-row", cells));
    }
    if (earn?.next && earn.next * 1000 > Date.now() - DAY * 1000 && earn.next * 1000 - Date.now() < 60 * DAY * 1000) {
      const d = new Date(earn.next * 1000);
      rows.push(h("div.lg-row.lg-earn", { "data-tip-text": "Nasdaq(Zacks) 실적 발표 예정일이에요\n'예상'은 회사가 날짜를 아직 안 밝혀서 과거 일정으로 짐작한 날" }, `📅 다음 실적 ${d.getUTCMonth() + 1}-${String(d.getUTCDate()).padStart(2, "0")}${earn.estimated ? " (예상)" : ""}`));
    }
    if (gaps?.days >= 10) {
      const L = gaps.longest;
      rows.push(h("div.lg-row.lg-gap", { "data-tip-text": "Yahoo에 기록이 없는 평일이에요 (명절 연휴는 빼고 셌어요)\n없는 값은 지어내지 않고 비워 둬요" }, `⚠ 데이터 빈 날 ${gaps.days.toLocaleString()}일 · 가장 긴 곳 ${ymd(L.from)} ~ ${ymd(L.to)}`));
    }
    const sent = SENTIMENT[info.id];
    if (sent && b) {
      const st = stageOf(info.id, b.c);
      rows.push(h("div.lg-row.lg-sent", { "data-tip-text": sentimentTip(info.id) }, h(`b.${st?.cls ?? "flat"}`, `${st?.name ?? ""} `), h("span.lg-dim", sent.one)));
    }
    for (const hd of handles) {
      let items = [];
      try {
        items = hd.legend(i) ?? [];
      } catch {}
      const newRow = () =>
        h("div.lg-row.lg-ind", {
          "data-tip": hd.inst.id,
          onclick: () => env.onIndicatorClick?.(api, hd.inst),
          oncontextmenu: (e) => {
            e.preventDefault();
            env.onIndicatorMenu?.(api, hd.inst, e);
          },
        });
      let row = newRow();
      for (const it of items) {
        if (!it) continue;
        // 멀티 이평 (0.16.0): br = 다음 줄로, more = 값 뒤에 색 글자 (거리 %)
        if (it.br) {
          rows.push(row);
          row = newRow();
          continue;
        }
        if (it.action) {
          row.append(h("button.lg-act", { "data-tip-text": it.action.tip, onclick: (e) => (e.stopPropagation(), it.action.onclick()) }, it.action.text));
          continue;
        }
        row.append(h("span.lg-name", { style: `color:${it.color}` }, it.label), it.value ? h("span.lg-val", ` ${it.value}${it.more ? " " : "  "}`) : " ");
        if (it.more) row.append(h(`span.lg-v.${it.more.cls}`, `${it.more.text}  `));
      }
      rows.push(row);
    }
    legend.replaceChildren(...rows);
  }

  /** 장이 닫힌 시간: 무기한선물로 본 24시간 추정가를 주황 점선으로 (SPEC §2.6) */
  function paintEstimate() {
    const e = replay ? null : env.estimator?.get(info.id);
    if (!main) return;
    if (!e) {
      if (estLine) main.removePriceLine(estLine);
      estLine = null;
      return;
    }
    const o = { price: e.price, color: "#ffb020", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: `24h 추정 ${signed(e.pct, 2)}%` };
    if (estLine) estLine.applyOptions(o);
    else estLine = main.createPriceLine(o);
  }
  const offEst = env.estimator?.on(({ id }) => id === info.id && paintEstimate());

  function paintHead() {
    if (!cc.symbol) {
      setText(nameEl, "빈 칸");
      for (const el of [subEl, priceEl, chgEl, tfEl, badgeEl, bellEl]) setText(el, "");
      return;
    }
    setText(nameEl, info.label);
    setText(subEl, info.sub);
    setText(tfEl, TF_NAME[tf]);
    const q = replay ? null : data.quote(info.id); // 리플레이 중에는 그때 봉 값으로
    const last = bars[bars.length - 1];
    const price = q?.price ?? last?.c;
    const prev = q?.prevClose ?? (daily() ? bars[bars.length - 2]?.c : null);
    setText(priceEl, price == null ? "—" : info.yieldLike ? `${num(price, 3)}%` : num(price, decimalsFor(info, price)));
    const st = stageOf(info.id, price);
    if (st) {
      chgEl.className = `ch-chg ${st.cls}`;
      setText(chgEl, st.name);
    } else if (price != null && prev) {
      const ch = info.yieldLike ? (price - prev) * 100 : (price / prev - 1) * 100;
      chgEl.className = `ch-chg ${dir(ch)}`;
      setText(chgEl, info.yieldLike ? `${signed(ch, 1)}bp` : `${signed(ch, 2)}%`);
    } else setText(chgEl, "");
    nameEl.dataset.tipText = sentimentTip(info.id) ?? "";
    // 출처 + 얼마나 새 값인지: "Yahoo 실시간", "Yahoo 15분 늦음", "Alpaca 실시간", "Hyperliquid 24h"
    const src = sourcesOf(info, env.hasAlpaca(), env.hasToss?.());
    if (q?.src) src.quote = q.src; // 지금 값을 실제로 준 곳 (예: 국내 장중 Toss)
    let fresh = "";
    if (info.kind === "perp") fresh = "24h";
    else if (info.kind === "sentiment") fresh = "하루 1번";
    else if (q?.ts) {
      const age = Date.now() / 1000 - q.ts;
      fresh = age < 150 ? "실시간" : !marketOpen(info) || age > 3600 ? "장 마감" : `${Math.round(age / 60)}분 늦음`;
    }
    setText(badgeEl, replay ? "▶ 리플레이" : `${src.quote}${fresh ? ` ${fresh}` : ""}`);
    setClass(badgeEl, "live", !replay && (fresh === "실시간" || fresh === "24h"));
    const why = fresh.endsWith("늦음") ? `마지막 값이 ${fresh.replace(" 늦음", "")} 전 거예요\n${src.quote}가 이 거래소 값을 늦게 주거나, 그동안 거래가 없었어요` : fresh === "실시간" && q?.live ? "최근 15분 봉은 IEX 거래소 것(거래량 일부)이고, 15분이 지나면 전체 거래소 값으로 바뀌어요" : fresh === "장 마감" ? "지금은 장이 닫혀 있어요" : "";
    badgeEl.dataset.tipText = `어디서 받나요?\n${src.text}${why ? `\n\n${why}` : ""}`;
    setText(bellEl, env.alertCount?.(info.id) ? "🔔" : "");
  }

  chart.subscribeCrosshairMove((p) => {
    if (p?.logical != null && bars.length) {
      crossIdx = Math.max(0, Math.min(bars.length - 1, Math.round(p.logical)));
    } else crossIdx = null;
    scheduleAlign(); // 오른쪽 눈금을 손으로 늘였다 줄였으면 왼쪽 눈금도 따라
    paintHoverPrices();
    paintLegend();
    if (!syncing) env.onCrosshair?.(api, p?.time != null ? { t: fromTime(p.time), daily: daily() } : null);
  });

  // ── 시점·십자선 맞추기 (분할 화면, SPEC §3.3) ──
  // 칸끼리는 차트 숫자가 아니라 "실제 시각"을 주고받는다: 분봉 = UTC 초, 일·주봉 = 거래소 날짜 (QA #3)
  let syncing = false;
  chart.timeScale().subscribeVisibleTimeRangeChange((r) => {
    if (!syncing && r) env.onRange?.(api, visibleMoments());
  });

  /** 지금 보이는 범위 (실제 시각) */
  function visibleMoments() {
    const r = chart.timeScale().getVisibleRange();
    return r ? { from: fromTime(r.from), to: fromTime(r.to), daily: daily(), tf } : null;
  }

  /** 다른 칸의 시각 {t, daily} → 이 칸의 봉 번호. 그 시각에 이 칸 봉이 없으면(휴장·밤 시간) -1 (QA #15) */
  function indexAtMoment(src) {
    if (!bars.length || src?.t == null) return -1;
    if (daily()) {
      let key = src.daily ? src.t : localDay(info.dayTz, src.t);
      if (tf === "1W") key = mondayOf(key);
      const i = lowerBound(bars, (b) => b.t, key + 1) - 1;
      return i >= 0 && bars[i].t === key ? i : -1;
    }
    if (src.daily) {
      // 일봉 날짜 → 이 칸에서 그 날짜(거래소 기준) 세션의 첫 봉
      let i = lowerBound(bars, (b) => b.t, src.t - 14 * 3600);
      for (let n = 0; i < bars.length && n < 3000; i++, n++) {
        const d = localDay(info.dayTz, bars[i].t);
        if (d === src.t) return i;
        if (d > src.t) break;
      }
      return -1;
    }
    const i = lowerBound(bars, (b) => b.t, src.t + 1) - 1;
    return i >= 0 && src.t - bars[i].t < 2 * TF_SEC[tf] + 60 ? i : -1;
  }
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    // 저장된 게 끝나도(more=false) 거래소에서 더 받을 수 있으면 왼쪽 끝에서 한 번 더 (모의매매, main.js fetchOlder)
    if (r && r.from < 30 && !loadingMore && (more || (env.fetchOlder && !atOldest && Date.now() > olderWait))) loadMore();
    if (cmp.length && crossIdx == null) paintLegend();
    scheduleAlign(); // 비교 "가격 그대로": 보이는 기간이 바뀌면 두 눈금을 다시 맞춘다
    if (r && windowed && r.to > bars.length - 30 && !loadingNewer) loadNewer();
  });

  // ── 데이터 ──
  // 처음 그림이 저장소 데이터로 그려지면 풀리는 약속 (날짜로 가기: 봉을 바꾼 뒤 기다렸다가 이동)
  let ready = Promise.resolve();
  let readyDone = () => {};
  let goTimer = 0;

  /** keepReplay: 리플레이 중이면 같은 시각부터 이어 간다 (봉·보기를 바꿀 때. 종목을 바꾸면 끝낸다) */
  async function load(view = "fresh", { keepReplay = false } = {}) {
    ready = new Promise((r) => (readyDone = r));
    // 보기만 바꿀 때(하이킨아시·가격 기준): 보던 곳을 "시간"으로 기억해 뒀다가 그대로 (봉 번호는 바뀔 수 있어서)
    const keep = view === "keep" && bars.length && info?.id === cc.symbol ? visibleMoments() : null;
    crossIdx = null;
    setWindowed(false);
    const my = ++token;
    unsubLive?.();
    unsubLive = null;
    // 분할 화면에서 리플레이를 같이 가는 칸(매매하는 칸 말고)은 종목을 바꿔도 같은 시각부터 (모의매매 0.8.1: 옆에 관련 종목)
    const follow = !keepReplay && !!cc.symbol && !!replay && !!env.followReplay?.(api);
    const resume = (keepReplay || follow) && cc.symbol ? replay?.endT ?? resumeT : null;
    const wasReplay = !!replay || resumeT != null;
    replay = null;
    resumeT = resume;
    if (wasReplay && resume == null) env.onReplayReset?.(api);
    emptyEl.hidden = !!cc.symbol;
    if (!cc.symbol) {
      // 빈 칸
      info = describe("");
      msg.hidden = true;
      createMain();
      bars = [];
      main.setData([]);
      measure.clear();
      drawings.setTool(null);
      paintHead();
      legend.replaceChildren();
      readyDone();
      return;
    }
    info = describe(cc.symbol);
    tf = info.tfs.includes(tf) ? tf : "1D";
    cc.timeframe = tf;
    chart.applyOptions({ timeScale: { timeVisible: !daily() } });
    createMain();
    buildIndicators();
    measure.clear();
    drawings.setTool(null);
    paintHead();
    const t0 = performance.now();
    // 1) 저장소에 있는 것부터 바로 (보던 곳이 더 과거면 거기부터)
    let s = await read();
    if (my !== token) return;
    // 모의매매: 리플레이 중에 봉을 바꿨는데 그 봉이 아직 없거나 그 시각까지 안 닿으면 먼저 받는다 (main.js, 0.8.1)
    // (전에는 처음 보는 4시간봉 등으로 바꾸면 "처음 받는 중"이 뜨고 리플레이가 끊겼다)
    if (resume != null && !daily() && env.beforeReplayLoad) {
      const wait = setTimeout(() => showMsg(`그때 ${TF_NAME[tf]}봉을 받는 중…`), 400);
      await env.beforeReplayLoad(info, tf, resume).catch(() => {});
      clearTimeout(wait);
      if (my !== token) return;
      msg.hidden = true;
      s = await read();
      if (my !== token) return;
    }
    const at = resume ?? (keep && !daily() && s.bars.length && keep.from < s.bars[0].t ? keep.from : null);
    // 리플레이를 이어 갈 시각이 읽은 범위 밖(또는 왼쪽 끝 가까이)이면 그 시각 앞뒤를 읽는다
    if (at != null && !daily() && (!s.bars.length || at < s.bars[0].t + (resume != null ? 300 * TF_SEC[tf] : 0) || at > s.bars[s.bars.length - 1].t + TF_SEC[tf])) {
      const w = await readWindow(at);
      if (my !== token) return;
      if (w.bars.length) {
        s = w;
        setWindowed(w.moreNewer);
      }
    }
    if (s.bars.length) {
      apply(s, keep || resume != null ? "none" : view);
      if (resume != null) {
        resumeT = null;
        startReplay(resume);
      } else if (keep) {
        try {
          chart.timeScale().setVisibleRange({ from: time(keep.from), to: time(keep.to) });
        } catch {}
      }
      logInfo(`[cell] ${info.id} ${tf}: store ${Math.round(performance.now() - t0)}ms, ${s.bars.length} bars`);
    } else {
      bars = [];
      main.setData([]);
      renderIndicators(0);
      showMsg(isDailyTf(tf) || info.intraday !== "alpaca" || env.hasAlpaca() ? `처음 받는 중… (${info.label} ${TF_NAME[tf]}봉)` : "미국 주식 분봉은 알파카 키가 있어야 받을 수 있어요\n⚙ 설정 → 데이터에서 키를 넣어 주세요");
      paintLegend();
      if (resume != null) {
        resumeT = null;
        env.onReplayReset?.(api); // 이 봉은 저장된 게 없다 → 리플레이를 이어 갈 수 없다
      }
    }
    readyDone();
    // 2) 실시간
    unsubLive = data.subscribeLive(info, tf, onLive);
    // 3) 이어 받기 (받은 게 있으면 "bars" 이벤트로 다시 읽음)
    const n = await data.ensure(info, tf, { front: true });
    if (my !== token) return;
    if (!bars.length) {
      s = await read();
      if (my !== token) return;
      if (s.bars.length) apply(s, "fresh");
      else showMsg(n === 0 && !isDailyTf(tf) && info.intraday === "alpaca" && !env.hasAlpaca() ? msg.textContent : "데이터가 없어요 · 인터넷 연결이나 종목 코드를 확인해 주세요");
    }
  }

  /** 그 시각 앞뒤만 읽기: 그날(거래소 기준) 0시를 경계로 앞 WINDOW_BEFORE봉 + 뒤 WINDOW_AFTER봉 (봉 묶음이 경계에서 안 잘리게) */
  async function readWindow(t) {
    const day = localDay(info.dayTz, t);
    const seam = day - tzOffset(info.tz, day);
    const [a, b] = await Promise.all([read({ before: seam, limit: WINDOW_BEFORE }), read({ after: seam, limit: WINDOW_AFTER })]);
    return { ...b, bars: [...a.bars.filter((x) => x.t < seam), ...b.bars], more: a.more, moreNewer: b.moreNewer };
  }

  function setWindowed(on) {
    windowed = !!on;
    nowBtn.hidden = !windowed || !!replay; // 리플레이 중엔 숨김: 오른쪽 아래 익절·손절 이름표를 가렸다 (0.11.1). 끝내기는 리플레이 줄의 ✕
  }

  /** 과거 구간을 볼 때 오른쪽 끝에 가까워지면 그 뒤를 이어 읽는다 */
  async function loadNewer() {
    if (!windowed || loadingNewer || !bars.length || replay) return;
    loadingNewer = true;
    const my = token;
    try {
      const last = bars[bars.length - 1].t;
      const s = await read({ after: last, limit: MORE_LIMIT });
      if (my !== token || replay) return; // 읽는 사이에 리플레이가 시작됐으면(봉을 바꿔 이어 가기) 미래 봉을 붙이지 않는다
      const next = mergeRows(bars, s.bars);
      if (!s.moreNewer) setWindowed(false); // 지금까지 왔다 → 실시간 다시
      setBars(next, "keep");
      trimBars("left");
    } finally {
      loadingNewer = false;
    }
  }

  /** 봉이 너무 많으면 안 보는 쪽을 덜어 낸다 (메모리·속도) */
  function trimBars(side) {
    if (bars.length <= MAX_BARS) return;
    const r = chart.timeScale().getVisibleLogicalRange();
    const cut = bars.length - MAX_BARS;
    if (side === "left") {
      // 오른쪽으로 이어 읽는 중: 왼쪽(오래된 쪽)을 덜어 낸다
      if (r && r.from - cut < 50) return;
      measure.shift(-cut);
      if (crossIdx != null) crossIdx = Math.max(0, crossIdx - cut);
      setBars(bars.slice(cut), { shift: -cut });
      more = true;
    } else {
      // 왼쪽으로 과거를 불러오는 중: 안 보는 오른쪽(최신 쪽)을 덜어 내고 "과거 구간 보기"로
      if (r && r.to > bars.length - cut - 50) return;
      setBars(bars.slice(0, bars.length - cut), "none");
      setWindowed(true);
    }
  }

  function read(o = {}) {
    return loadSeries(info, tf, { basis: basis(), ext: ext(), limit: daily() ? undefined : FIRST_LIMIT, ...o });
  }

  function apply(s, view) {
    events = s.events;
    splits = s.splits;
    more = s.more;
    atOldest = false;
    lastRawT = s.lastRawT ?? null;
    storedLastT = s.bars.length ? s.bars[s.bars.length - 1].t : null;
    setBars(s.bars, view);
  }

  function showMsg(text) {
    msg.textContent = text;
    msg.hidden = false;
  }

  /** 저장소가 새로 채워졌다 → 다시 읽기 (분봉은 끝부분만 읽어 붙인다) */
  async function refresh() {
    if (replay || windowed) return; // 리플레이 중·과거 구간을 볼 때는 실시간 갱신을 멈춘다
    const my = token;
    if (daily() || !bars.length) {
      const s = await read();
      if (my !== token) return;
      if (!s.bars.length) return;
      if (!bars.length) return apply(s, "fresh");
      events = s.events;
      splits = s.splits;
      storedLastT = s.bars[s.bars.length - 1].t;
      updateBars(withLiveDaily(s.bars));
      return;
    }
    const s = await read({ limit: 60 });
    if (my !== token || !s.bars.length) return;
    lastRawT = s.lastRawT;
    storedLastT = s.bars[s.bars.length - 1].t;
    updateBars(mergeRows(bars, s.bars));
  }

  async function loadMore() {
    if (!bars.length || replay) return;
    loadingMore = true;
    const my = token;
    try {
      let s = await read({ before: bars[0].t, limit: MORE_LIMIT });
      if (my !== token || replay) return;
      // 모의매매: 저장된 봉이 끝났으면 거래소에서 그 앞을 더 받아 와 다시 읽는다 (Binance 무기한선물만, main.js)
      // 0개 = 상장일까지 왔다 → "여기부터가 전부"라고 알린다 (받아지지 않는 줄 알고 헷갈리지 않게)
      if (!s.more && env.fetchOlder && !atOldest) {
        let n = 0;
        try {
          n = await env.fetchOlder(info, tf);
        } catch (e) {
          olderWait = Date.now() + 10000;
          n = null;
          env.toast?.("더 옛날 봉을 받지 못했어요 · 인터넷 연결을 확인해 주세요", 4000);
        }
        if (my !== token || replay) return;
        if (n) s = await read({ before: bars[0].t, limit: MORE_LIMIT });
        else if (n === 0) {
          atOldest = true;
          env.onOldest?.(api, s.bars.length ? s.bars[0].t : bars[0].t);
        }
        if (my !== token || replay) return;
      }
      more = s.more;
      const older = s.bars.filter((b) => b.t < bars[0].t);
      if (!older.length) return;
      measure.shift(older.length);
      if (crossIdx != null) crossIdx += older.length;
      setBars([...older, ...bars], { shift: older.length });
      trimBars("right");
    } finally {
      loadingMore = false;
    }
  }

  // 실시간: 무기한선물 봉 / 알파카 IEX 꼬리
  async function onLive(ev) {
    if (!bars.length || replay || windowed) return;
    if (ev.type === "bar") {
      updateBars(mergeRows(bars, [ev.row]));
    } else if (ev.type === "tail" && ev.rows?.length && storedLastT != null) {
      const my = token;
      const tail = await liveTail(info, tf, ev.rows, { basis: basis(), ext: ext(), splits, fromT: storedLastT });
      if (my !== token || !tail.length) return;
      updateBars(withLiveIntraday(mergeRows(bars, tail.filter((b) => b.t >= storedLastT))));
    }
  }

  /** 날짜로 가기: "2024-08-05" (+ "10:30" PC 시각) → 그 봉을 가운데로, 주황 화살표 "여기" (10초) */
  async function goToDate(dateStr, timeStr, newTf, zone = "local") {
    if (!cc.symbol || !dateStr) return { ok: false };
    if (newTf && newTf !== tf && info.tfs.includes(newTf)) {
      tf = newTf;
      cc.timeframe = newTf;
      env.onChange?.();
      load("fresh");
    }
    await ready;
    const my = token;
    const day = parseYmd(dateStr);
    let t;
    if (daily()) t = tf === "1W" ? mondayOf(day) : day;
    else if (timeStr && zone === "ny") {
      // 뉴욕 시각 → UTC (그날의 서머타임 반영)
      const [hh, mm] = timeStr.split(":").map(Number);
      const asUtc = day + hh * 3600 + mm * 60;
      t = asUtc - tzOffset("America/New_York", asUtc);
    } else if (timeStr) t = new Date(`${dateStr}T${timeStr}`).getTime() / 1000; // PC 시각으로 친 시각
    else t = day - tzOffset(info.tz, day) + (info.rth ? info.rth[0] : info.anchor ?? 0); // 그날 장 시작
    // 분봉인데 그날이 아직 안 읽혔으면: 그날 조금 앞부터 지금까지 저장소에서 읽는다 (지표가 끊기지 않게 넉넉히)
    if (!daily() && bars.length && t < bars[0].t + 50 * TF_SEC[tf]) {
      const s = await readWindow(t);
      if (my !== token) return { ok: false };
      if (s.bars.length) {
        apply(s, "none");
        setWindowed(s.moreNewer);
      }
    }
    if (!bars.length) return { ok: false };
    const i = Math.min(bars.length - 1, lowerBound(bars, (b) => b.t, t));
    const r = chart.timeScale().getVisibleLogicalRange();
    const span = r ? Math.max(40, r.to - r.from) : 150;
    chart.timeScale().setVisibleLogicalRange({ from: i - span / 2, to: i + span / 2 });
    markerSets.set("goto", [{ time: time(bars[i].t), position: "aboveBar", shape: "arrowDown", color: "#ffb020", text: "여기" }]);
    applyMarkers();
    clearTimeout(goTimer);
    goTimer = setTimeout(() => (markerSets.delete("goto"), applyMarkers()), 10000);
    return { ok: true, early: t < bars[0].t - 3 * DAY };
  }

  /** 분봉: 실시간 현재가(토스·알파카, 1초마다)로 지금 만들어지는 봉 고치기 — 다음 칸이면 새 봉을 연다 */
  function withLiveIntraday(list) {
    const q = data.quote(info.id);
    if (!q?.live || !q.ts || !list.length) return list;
    if (!ext() && !marketOpen(info, q.ts)) return list; // 정규장만 볼 때 프리·애프터 체결은 빼고
    // 무기한선물은 거래소 봉이 실시간으로 오니 마지막 봉만 고친다
    if (info.kind === "perp" && q.ts >= list[list.length - 1].t + TF_SEC[tf]) return list;
    return applyLiveQuote(list, q, TF_SEC[tf], info.tz, (ext() ? info.extAnchor : info.anchor) ?? 0);
  }

  /** 일·주봉: 현재가로 마지막 봉 고치기 (장중) */
  function withLiveDaily(list) {
    const q = data.quote(info.id);
    if (!q || !list.length || info.kind === "sentiment" || !q.ts) return list;
    let day = localDay(info.dayTz, q.ts);
    if (tf === "1W") day = mondayOf(day);
    const last = list[list.length - 1];
    if (day < last.t) return list;
    const p = q.price; // 오늘 가격은 분할 반영 전후가 같다
    if (day === last.t) {
      if (last.c === p && last.h >= p && last.l <= p) return list;
      const nb = { ...last, c: p, h: Math.max(last.h, p), l: Math.min(last.l, p) };
      return [...list.slice(0, -1), nb];
    }
    if (day - last.t > 10 * DAY) return list;
    return [...list, { t: day, o: p, h: p, l: p, c: p, v: 0 }];
  }

  const offQuote = data.on("quote", ({ id }) => {
    if (id !== info.id || replay) return;
    if (windowed) return paintHead();
    if (daily() && bars.length) updateBars(withLiveDaily(bars));
    else if (bars.length && withLiveIntraday(bars) !== bars) updateBars(withLiveIntraday(bars));
    else paintHead();
  });
  const offBars = data.on("bars", ({ id, tf: storedTf, partial }) => {
    if (!info) return;
    // 비교 종목을 처음 받아 왔거나, 이 칸 봉 종류(일봉·분봉)의 새 봉이 들어왔으면 다시 읽는다
    const cmpTf = (c) => (daily() ? storedTf === "1D" || c.info.kind === "perp" : storedTf !== "1D");
    if (cmp.some((c) => c.id === id && (!c.raw.length || (!partial && cmpTf(c))))) syncCompare(true);
    const ids = info.kind === "ratio" ? info.parts : [info.id];
    if (!ids.includes(id)) return;
    if (daily() ? storedTf === "1D" || info.kind === "perp" : storedTf !== "1D") refresh();
  });

  // ── ✏️ 그리기 (📏보다 먼저: 도구를 쓰는 중이면 이쪽이 먼저 받는다) ──
  const drawView = () => ({ sym: info.id, bars, tf, info, ext: ext(), log: scaleMode() === "log", decimals, time, lineOnly: chartType() === "line" || chartType() === "area" });
  const drawings = createDrawings({
    chart,
    box: body,
    cfg,
    main: () => main,
    view: drawView,
    measureOn: () => measure.on,
    onTool: (t) => env.onDrawTool?.(api, t),
    onAlert: (dw) => env.onDrawingAlert?.(api, dw),
    setMarkers: (list) => {
      markerSets.set("drawings", list);
      applyMarkers();
    },
  });

  // ── 📏 ──
  const measure = createMeasure({
    chart,
    getSeries: () => main,
    box: body,
    getBars: () => bars,
    isDaily: daily,
    getDecimals: () => decimals,
    onToggle: (on) => env.onMeasure?.(api, on),
  });

  root.addEventListener("pointerdown", (e) => env.onSelect?.(api, e), true);
  // 오른쪽 클릭 = 📋 이미지 복사 메뉴 (0.18.0). 익절·손절선·그린 것·범례 줄이 먼저 가져간 클릭은 그쪽 것 그대로
  root.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    env.onCellMenu?.(api, e);
  });
  // 크게 보기는 두 번 모두 이 칸 차트를 눌렀을 때만: 종목 찾기·메뉴 줄을 두 번 누르면 첫 번에 창이 닫히고 두 번째가 차트에 떨어진다
  let downs = [-1e9, -1e9];
  body.addEventListener("pointerdown", (e) => e.button === 0 && (downs = [downs[1], e.timeStamp]), true);
  body.addEventListener("dblclick", (e) => !drawings.tool && e.timeStamp - downs[0] < 1000 && env.onMaximize?.(api)); // 그리는 중 빠른 두 번 찍기는 크게 보기가 아니다

  // ── 리플레이 도우미 ──
  /** 봉이 끝나는 시각 (일·주봉은 그 날짜·주가 끝나는 현지 자정) */
  function barEnd(b) {
    if (!daily()) return b.t + TF_SEC[tf];
    const local = b.t + (tf === "1W" ? 7 : 1) * DAY;
    return local - tzOffset(info.dayTz, local);
  }
  /** endT까지 끝난 봉 수 */
  function countEnded(list, endT) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (barEnd(list[mid]) <= endT) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  function cutTo(endT, first) {
    replay.endT = endT;
    const n = countEnded(replay.full, endT);
    const next = replay.full.slice(0, n);
    const part = partialBar(n, endT);
    if (part) next.push(part);
    if (!next.length) {
      // 이 칸에는 그 시각까지의 봉이 없다 (예: 야후 5분봉은 최근 60일뿐, 분할 화면에서 같이 가는 칸) → 비워 둔다.
      // 0.16.0: 전에는 "최소 1개"를 보여 주느라 그 뒤의 첫 봉(미래)이 보였다 (8/17 리플레이에 삼성전자 8/26 09:00 봉)
      bars = [];
      main.setData([]);
      renderIndicators(0);
      showMsg(`리플레이 시각에는 ${info.label} ${TF_NAME[tf]}봉 자료가 없어요\n자료가 있는 때에 닿으면 나타나요`);
      paintLegend();
      paintHead();
      extendReplay(0);
      return;
    }
    if (first || !bars.length) {
      const ts = chart.timeScale();
      const was = ts.getVisibleLogicalRange();
      setBars(next, "keep");
      // 같이 가는 칸(분할 화면)은 보던 곳이 "지금" 쪽이라 잘린 봉 밖 → 끝 봉 하나만 왼쪽에 보였다 (0.13.0) → 끝 150봉쯤.
      // 시작할 봉을 눌러 고른 칸은 그 봉이 화면 안이라 보던 확대 그대로
      if (!was || was.from > next.length || was.to < next.length - 5) ts.setVisibleLogicalRange({ from: next.length - 150, to: next.length + 6 });
      else ts.scrollToRealTime();
    } else if (next.length === bars.length || next.length === bars.length + 1) updateBars(next);
    else setBars(next, "follow");
    paintHead();
    extendReplay(n);
  }

  function startReplay(endT) {
    replay = { full: bars, endT, m1: null, m1More: false, newer: windowed, loading: false };
    nowBtn.hidden = true;
    cutTo(endT, true);
    loadReplayMinutes();
    env.onReplayStart?.(api); // 모의매매: 봉을 바꿔 이어 갈 때도 표시를 다시 그린다
  }

  /** 아직 안 끝난 봉(full[n])을 그 시각까지의 1분봉으로 만든다 → 진행 중인 봉이 실제처럼 자란다 (기획서 §12) */
  function partialBar(n, endT) {
    const m1 = replay.m1;
    const b = replay.full[n];
    if (!m1 || !b || b.t >= endT) return null;
    const end = Math.min(endT, barEnd(b));
    let cur = null;
    for (let i = lowerBound(m1, (x) => x.t, b.t); i < m1.length && m1[i].t + 60 <= end; i++) {
      const k = m1[i];
      if (!cur) cur = { t: b.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v ?? 0 };
      else {
        if (k.h > cur.h) cur.h = k.h;
        if (k.l < cur.l) cur.l = k.l;
        cur.c = k.c;
        cur.v += k.v ?? 0;
      }
    }
    return cur;
  }

  /** 리플레이를 1분씩: 저장된 1분봉이 있으면 읽어 둔다 (1분봉 차트·일봉은 원래대로 봉 단위) */
  async function loadReplayMinutes() {
    const r = replay;
    if (!r || daily() || tf === "1m" || !info.tfs.includes("1m")) return;
    const n = countEnded(r.full, r.endT);
    const from = Math.min(r.full[n]?.t ?? r.endT, r.endT);
    const my = token;
    r.m1Loading = true; // 읽는 동안은 제자리 (봉을 바꾼 직후 한 칸이 4시간봉 하나만큼 건너뛰지 않게, 0.8.2)
    try {
      const s = await loadSeries(info, "1m", { basis: basis(), ext: ext(), after: from, limit: M1_LIMIT });
      if (my !== token || replay !== r || !s.bars.length) return;
      if (s.bars[0].t > from + TF_SEC[tf]) return; // 그때 1분봉이 없다 (미국 주식 1분봉은 최근 12개월뿐) → 봉 단위로
      r.m1 = s.bars;
      r.m1More = !!s.moreNewer;
      cutTo(r.endT, false);
      env.onReplayStart?.(api); // 속도 글자 "분/초"로
    } catch (e) {
      console.warn("[cell] 리플레이 1분봉 읽기 실패", e);
    } finally {
      r.m1Loading = false;
    }
  }

  /** 1분봉 빈 곳(from ~ to)을 거래소에서 받아(main.js fillMinutes, Binance만) 다시 읽는다. 받아도 비어 있으면 그 빈 곳은 봉 단위로 지나간다 */
  async function fillReplayHole(from, to) {
    const r = replay;
    if (!r || r.holeFilling) return;
    r.holeFilling = true;
    const my = token;
    try {
      await env.fillMinutes?.(info, from, Math.min(to, from + 3 * DAY));
      if (my !== token || replay !== r) return;
      const s = await loadSeries(info, "1m", { basis: basis(), ext: ext(), after: from, limit: M1_LIMIT });
      if (my !== token || replay !== r) return;
      const k = lowerBound(r.m1, (x) => x.t, from + 1);
      r.m1 = r.m1.slice(0, k).concat(s.bars.filter((b) => b.t > from));
      r.m1More = !!s.moreNewer;
      const next = r.m1[k];
      if (!next || next.t - from > 30 * 60) r.holeDone = next?.t ?? Infinity; // 거래소에도 없다 (점검·받을 수 없는 종목)
    } catch (e) {
      console.warn("[cell] 리플레이 1분봉 빈 곳 받기 실패", e);
      if (replay === r) r.holeDone = to;
    } finally {
      r.holeFilling = false;
    }
  }

  /** 읽어 둔 끝에 가까워지면 그 뒤를 더 읽어 둔다 (과거 한 구간에서 시작했을 때) */
  async function extendReplay(n) {
    const r = replay;
    if (!r || r.loading) return;
    const needFull = r.newer && r.full.length - n < 200;
    // 모의매매가 그 뒤 1분봉을 거래소에서 더 받아 저장할 수 있다 → 끝에 닿으면 몇 초마다 저장소를 다시 본다
    const needM1 = r.m1 && (r.m1More || Date.now() > (r.m1Retry ?? 0)) && r.m1.length - lowerBound(r.m1, (x) => x.t, r.endT) < 600;
    // 24시간 종목: 리플레이 시각이 읽어 둔 1분봉의 빈 곳에 들어왔다 (옛날 구간 앞뒤 며칠만 받아 두고 바로 지금 근처 1분봉이 이어짐)
    // → 모의매매가 그 사이를 받아 저장하면 다시 읽는다. 전에는 그 뒤로 진행 중인 봉이 자라지 않았다 (0.11.1)
    const k = r.m1 ? lowerBound(r.m1, (x) => x.t, r.endT) : 0;
    const hole = !!r.m1 && info.kind === "perp" && k > 0 && r.endT - (r.m1[k - 1].t + 60) > 30 * 60 && Date.now() > (r.m1Retry ?? 0);
    if (!needFull && !needM1 && !hole) return;
    r.loading = true;
    const my = token;
    try {
      if (needFull) {
        const last = r.full[r.full.length - 1].t;
        const s = await read({ after: last + 1, limit: MORE_LIMIT });
        if (my !== token || replay !== r) return;
        const more = s.bars.filter((b) => b.t > last); // 첫 봉은 앞부분이 잘렸을 수 있다 (last 봉과 같은 시각)
        r.full = r.full.concat(more);
        r.newer = !!s.moreNewer && more.length > 0;
      }
      if (hole) {
        const lastT = r.m1[k - 1].t;
        const s = await loadSeries(info, "1m", { basis: basis(), ext: ext(), after: lastT + 1, limit: M1_LIMIT });
        if (my !== token || replay !== r) return;
        const more = s.bars.filter((b) => b.t > lastT);
        r.m1 = r.m1.slice(0, k).concat(more);
        r.m1More = !!s.moreNewer;
        if (!more.length || more[0].t > r.endT) r.m1Retry = Date.now() + 3000; // 아직 안 받아졌다 → 몇 초 뒤 다시
      } else if (needM1) {
        const last = r.m1[r.m1.length - 1].t;
        const s = await loadSeries(info, "1m", { basis: basis(), ext: ext(), after: last + 1, limit: M1_LIMIT });
        if (my !== token || replay !== r) return;
        const more = s.bars.filter((b) => b.t > last);
        r.m1 = r.m1.concat(more);
        r.m1More = !!s.moreNewer && more.length > 0;
        if (!r.m1More) r.m1Retry = Date.now() + 3000;
      }
    } catch (e) {
      console.warn("[cell] 리플레이 뒤 봉 읽기 실패", e);
    } finally {
      r.loading = false;
    }
  }

  // ── 밖에서 쓰는 것 ──
  const api = {
    root,
    chart,
    get cc() {
      return cc;
    },
    get info() {
      return info;
    },
    get tf() {
      return tf;
    },
    get bars() {
      return bars;
    },
    get main() {
      return main;
    },
    get insts() {
      return insts;
    },
    get decimals() {
      return decimals;
    },
    measure,
    drawings,
    drawView,
    time,
    fromTime,
    paintHead: () => paintHead(),
    load,
    setRange,
    head,
    goToDate,
    /** 비교 종목 정하기 (최대 3개) */
    setCompare(list) {
      cc.compare = [...new Set(list.filter(Boolean))].slice(0, 3);
      env.onChange?.();
      applyScale();
      syncCompare(true);
      paintLegend();
    },
    /** 비교 방식: "pct" = 보이는 첫 봉 0% (누가 더 올랐나) · "price" = 가격 그대로, 첫 비교 종목은 왼쪽 눈금 */
    setCompareMode(mode) {
      cc.compare_mode = mode;
      env.onChange?.();
      applyScale();
      syncCompare(true);
      paintLegend();
    },
    /** 📏 켜기/끄기 (켜면 그리기 도구는 내려놓는다) */
    toggleMeasure(on) {
      if (on ?? !measure.on) drawings.setTool(null);
      measure.toggle(on);
    },
    /** 이 칸 설정 통째로 (끌어서 자리 바꾸기) */
    exportConfig: () => structuredClone(cc),
    applyConfig(conf) {
      for (const k of Object.keys(cc)) delete cc[k];
      Object.assign(cc, structuredClone(conf));
      tf = cc.timeframe ?? "1D";
      insts = normalizeInds(cc.indicators ?? []);
      htfCache.clear();
      env.onChange?.();
      load("fresh");
    },
    setSymbol(id) {
      cc.symbol = id;
      htfCache.clear();
      env.onChange?.();
      load("fresh");
    },
    setTimeframe(t) {
      if (t === tf) return;
      tf = t;
      cc.timeframe = t;
      env.onChange?.();
      load("fresh", { keepReplay: true }); // 리플레이 중이면 같은 시각부터 새 봉으로 이어서
    },
    setIndicators(list) {
      insts = normalizeInds(list);
      cc.indicators = insts.map(({ uid, ...x }) => x);
      env.onChange?.();
      buildIndicators();
      paintLegend();
    },
    /** 가격 기준·눈금·차트 종류 같은 보기 설정 */
    setView(patch) {
      Object.assign(cc, patch);
      env.onChange?.();
      if ("scale" in patch) applyScale();
      if ("basis" in patch || "chart_type" in patch) load("keep", { keepReplay: true });
    },
    reload: () => load("keep", { keepReplay: true }),
    redraw() {
      createMain();
      buildIndicators();
      setBars(bars, "keep");
    },
    setSelected: (on) => setClass(root, "selected", on),
    setPicked: (on) => setClass(root, "picked", on), // Ctrl+클릭으로 고른 칸 (맞추기 대상)
    // ── ▶ 바 리플레이 (SPEC §3.8): 시각 endT(그때까지 끝난 봉만 보임)로 자르기. 저장소 데이터만, 요청 없음 ──
    get replaying() {
      return !!replay;
    },
    /** 화면 x 위치의 봉이 끝나는 시각 (시작점 고르기) */
    replayEndAt(x) {
      const ts = chart.timeScale();
      const i = Math.max(0, Math.min(bars.length - 1, Math.round(ts.coordinateToLogical(x) ?? bars.length - 1)));
      return bars.length ? barEnd(bars[i]) : null;
    },
    replayStart(endT) {
      if (!bars.length) return;
      startReplay(endT);
    },
    /** 그 시각에서 리플레이 시작. 그 앞뒤가 아직 안 읽혀 있으면 저장소에서 읽는다 (🎲 아무 때나) → 시작했으면 true */
    async replayStartAt(endT) {
      if (replay) {
        bars = replay.full;
        replay = null;
      }
      const my = token;
      if (!daily() && (!bars.length || endT < bars[0].t + 300 * TF_SEC[tf] || endT > barEnd(bars[bars.length - 1]))) {
        const w = await readWindow(endT);
        if (my !== token) return false;
        if (w.bars.length) {
          apply(w, "none");
          setWindowed(w.moreNewer);
        }
      }
      if (!bars.length) return false;
      startReplay(endT);
      return true;
    },
    replayTo: (endT) => replay && cutTo(endT, false),
    /** 분할 칸을 늘려 새로 생긴 칸: 진행 중인 리플레이 시각부터 (봉을 바꿀 때와 같은 길 — 없는 봉은 먼저 받는다, 0.13.0) */
    joinReplay(endT) {
      resumeT = endT;
      return load("fresh", { keepReplay: true });
    },
    /** 지금 만들어지는 봉(endT가 경계면 다음 봉)이 끝나는 시각 → ⏭ 한 칸 = 보는 봉 하나 (0.14.1). null = 끝 */
    replayBarEnd(endT) {
      const full = replay?.full ?? bars;
      const i = countEnded(full, endT);
      return i < full.length ? barEnd(full[i]) : null;
    },
    /** endT 다음에 보일 시각: 1분봉이 있으면 다음 1분, 없으면 다음 봉이 끝나는 시각 (null = 끝, endT 그대로 = 읽는 중) */
    replayNextEnd(endT) {
      if (resumeT != null) return resumeT; // 봉을 바꾸는 중: 다 읽을 때까지 제자리
      if (replay?.m1Loading) return endT; // 1분봉을 읽는 중: 제자리 (읽고 나면 1분씩)
      const full = replay?.full ?? bars;
      const i = countEnded(full, endT);
      const fullEnd = i < full.length ? barEnd(full[i]) : null;
      if (fullEnd == null) return replay?.newer || replay?.loading ? endT : null;
      const m1 = replay?.m1;
      if (m1) {
        const j = lowerBound(m1, (x) => x.t + 60, endT + 1);
        if (j < m1.length) {
          // 24시간 종목인데 다음 1분봉이 30분 넘게 뒤 = 받아 둔 1분봉의 빈 곳 (옛날 구간은 시작 앞뒤 며칠만 받아 둔다).
          // 받는 동안 제자리 → 받으면 1분씩. 전에는 봉 하나씩 건너뛰어 30분/초면 며칠이 순식간에 지나갔다 (0.11.1)
          if (info.kind === "perp" && m1[j].t - endT > 30 * 60 && !(replay.holeDone >= m1[j].t)) {
            fillReplayHole(endT, m1[j].t);
            return endT;
          }
          return Math.min(m1[j].t + 60, fullEnd);
        }
      }
      return fullEnd;
    },
    /** 리플레이가 1분씩 흘러가나 (속도 글자: "분/초" · "봉/초") */
    get replayMinutes() {
      return !!replay && (tf === "1m" || !!replay.m1);
    },
    /** 모의매매 📡 실시간: 과거 구간을 보고 있으면(실시간 갱신이 멈춰 있음) 지금으로 */
    get windowed() {
      return windowed;
    },
    goNow: () => windowed && load("fresh"),
    /** 모의매매 표시 (진입·청산 화살표) */
    setTradeMarkers(list) {
      markerSets.set("trade", list);
      applyMarkers();
    },
    replayStop() {
      resumeT = null;
      if (!replay) return;
      const full = replay.full;
      replay = null;
      nowBtn.hidden = !windowed;
      setBars(full, "keep");
      chart.timeScale().scrollToRealTime();
      refresh();
    },
    setExtraMarkers(sym, days) {
      extraMarkers = sym ? { sym, days } : null;
      applyMarkers();
    },
    visibleMoments,
    /** 다른 칸에서 온 시간 범위 맞추기. 봉이 다르면 가운데 시각만 맞추고 확대 정도는 그대로 (QA #7) */
    applyRange(src) {
      if (!src || !bars.length) return;
      syncing = true;
      try {
        const ts = chart.timeScale();
        if (src.tf === tf) ts.setVisibleRange({ from: time(src.from), to: time(src.to) });
        else {
          const mid = src.daily ? Math.round((src.from + src.to) / 2 / DAY) * DAY : (src.from + src.to) / 2;
          let i = indexAtMoment({ t: mid, daily: src.daily });
          if (i < 0) i = Math.min(bars.length - 1, lowerBound(bars, (b) => b.t, daily() && !src.daily ? localDay(info.dayTz, mid) : mid));
          const r = ts.getVisibleLogicalRange();
          const span = r ? r.to - r.from : 120;
          ts.setVisibleLogicalRange({ from: i - span / 2, to: i + span / 2 });
        }
      } catch {}
      syncing = false;
    },
    /** 다른 칸 십자선 따라가기 + 범례도 그 봉 값으로 (QA #4) */
    applyCrosshair(src) {
      syncing = true;
      try {
        const i = src == null ? -1 : indexAtMoment(src);
        if (i < 0) {
          chart.clearCrosshairPosition();
          crossIdx = null;
        } else {
          chart.setCrosshairPosition(bars[i].c, time(bars[i].t), main);
          crossIdx = i;
        }
        paintLegend();
      } catch {}
      syncing = false;
    },
    async screenshot() {
      return chart.takeScreenshot(true);
    },
    /** 📋 복사용 (ui/snapshot.js): 마우스가 있던 봉 값 말고 마지막 봉 기준으로. 십자선은 takeScreenshot이 뺀다 */
    snapshot() {
      chart.clearCrosshairPosition();
      crossIdx = null;
      paintHoverPrices();
      paintLegend();
      return { root, chart: chart.chartElement(), shot: chart.takeScreenshot(true) };
    },
    destroy() {
      token++;
      unsubLive?.();
      offQuote();
      offBars();
      offEst?.();
      drawings.destroy();
      chart.remove();
      root.remove();
    },
  };
  return api;
}

/** 정렬된 배열에서 key(x) >= target인 첫 위치 */
function lowerBound(arr, key, target) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

