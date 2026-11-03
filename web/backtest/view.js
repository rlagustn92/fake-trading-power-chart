// 적립식 백테스트 화면 (SPEC §4.2, §4.3)
// 왼쪽 = 입력(바꾸면 0.3초 뒤 바로 다시 계산, 계산 버튼 없음), 오른쪽 = 종목별 카드 · 평가금 차트 · 연도별/월별 표
import { h, segment, toggle } from "../ui/dom.js";
import { describe } from "../core/symbols.js";
import { loadSeries } from "../core/series.js";
import { ymd, parseYmd } from "../core/tz.js";
import { runDca, firstFullMonth, fxLookup, parseYm, ymOf } from "./engine.js";
import { num, signed, won } from "../ui/format.js";
import { invoke } from "../platform.js";
import { ask, toast, confirmBox } from "../ui/dialog.js";

const COLORS = ["#5ec8d8", "#f5c542", "#ff6fae", "#4cd5a0"];
const NOT_FOR_BT = { perp: "무기한선물", sentiment: "심리 지표", ratio: "비율 차트", yield: "금리", fx: "환율" };
const DISCLAIMER = "과거 데이터로 계산한 결과이며 미래 수익을 뜻하지 않습니다. 팔 때 내는 세금(양도세)은 빼지 않았어요.";
const PERIODS = [["max", "최대"], ["10y", "10년"], ["5y", "5년"], ["3y", "3년"], ["1y", "1년"], ["custom", "직접"]];
const QUICK = { KRW: [100000, 300000, 500000, 1000000], USD: [100, 300, 500, 1000] };
const QUICK_LUMP = { KRW: [10000000, 20000000, 50000000, 100000000], USD: [10000, 20000, 50000, 100000] };
const MODES = [["monthly", "꾸준히 모으기"], ["once", "한 번에 넣고 두기"], ["both", "목돈 + 꾸준히"]];
const FREQS = [["monthly", "매달"], ["weekly", "매주"], ["days", "요일마다"]];
const WD = ["일", "월", "화", "수", "목", "금", "토"];
const WD_PRESET = [[[1, 2, 3, 4, 5], "월~금 매일"], [[1, 3, 5], "월·수·금"], [[1, 3], "월·수"], [[1, 5], "월·금"]];
const DIV_TAX = [[0, "안 뺌"], [0.15, "15% (미국)"], [0.154, "15.4% (국내)"]];
const ymStr = ({ y, m }) => `${y}-${String(m).padStart(2, "0")}`;
const ymNum = (s) => {
  const { y, m } = parseYm(s);
  return y * 12 + m;
};

export function createBacktest(root, { cfg, data, openPicker, showOnChart }) {
  const B = cfg.backtest;
  B.saved ??= [];
  B.period ??= B.start || B.end ? "custom" : "max";
  // 투자 방법: 매달 모으기 / 한 번에 넣고 두기 / 목돈 + 매달 (예전 '처음 한 번에'를 쓰던 조건은 목돈 + 매달로)
  if (!B.mode) {
    B.mode = (+B.initial || 0) > 0 ? "both" : "monthly";
    if (B.initial > 0) B[B.currency === "KRW" ? "lump_krw" : "lump_usd"] = B.initial;
  }
  B.freq ??= "monthly";
  B.weekday ??= 1;
  B.weekdays ??= [1, 2, 3, 4, 5];
  B.lump_krw ??= 20000000;
  B.lump_usd ??= 10000;
  B.once_date ??= `${new Date().getFullYear() - 10}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`;
  B.fee ??= 0;
  B.div_tax ??= 0;
  B.fx_fee ??= 0;
  const nativeOf = (id) => (describe(id).currency === "KRW" ? "KRW" : "USD");
  let series = new Map(); // id → loadSeries 결과
  let fxBars = null;
  let results = [];
  let tab = "years";
  let tableSym = null;
  let logScale = true;
  let timer = null;
  let token = 0;
  let loadedKey = null; // 이 종목·통화로 읽어 둔 것
  const keyNow = () => `${B.symbols.join(",")}|${ccy()}`;

  // ── 틀 ──
  const side = h("aside.bt-side");
  const cards = h("div.bt-cards");
  const legend = h("div.bt-legend");
  const chartBox = h("div.bt-chart");
  const scaleBtn = segment([[true, "로그"], [false, "일반"]], () => logScale, (v) => ((logScale = v), chart.priceScale("right").applyOptions({ mode: v ? 1 : 0 })));
  const tabs = h("div.bt-tabs");
  const table = h("div.bt-table");
  const notes = h("div.bt-notes");
  const status = h("div.bt-status");
  root.replaceChildren(
    h(
      "div.bt",
      side,
      h(
        "div.bt-main",
        status,
        cards,
        h("div.bt-chart-wrap", h("div.bt-chart-head", h("b", "평가금 (종목별 선) · 넣은 돈 (계단선)"), h("div.grow"), scaleBtn), h("div.bt-chart-area", chartBox, legend)),
        tabs,
        table,
        notes
      )
    )
  );

  // ── 차트 (lightweight-charts) ──
  const LC = window.LightweightCharts;
  const chart = LC.createChart(chartBox, {
    autoSize: true,
    layout: { background: { type: "solid", color: "#0b0d10" }, textColor: "#a7adb5", fontSize: 14, fontFamily: '"Segoe UI", "Malgun Gothic", sans-serif', attributionLogo: false },
    grid: { vertLines: { color: "#161a20" }, horzLines: { color: "#161a20" } },
    rightPriceScale: { borderColor: "#2a2f36", mode: 1 },
    // 20년치 일봉(약 5,000개)도 한 화면에 다 들어오게 (기본 최소 간격 0.5px이면 6년치만 보인다)
    timeScale: { borderColor: "#2a2f36", rightOffset: 4, minBarSpacing: 0.01 },
    crosshair: { mode: 0 },
    localization: { locale: "ko-KR", priceFormatter: (v) => money(v), timeFormatter: (t) => ymd(t) },
  });
  let lines = [];

  // ── 입력 ──
  function ccy() {
    return B.currency === "KRW" ? "KRW" : "USD";
  }
  const monthlyKey = () => (ccy() === "KRW" ? "monthly_krw" : "monthly_usd");
  const lumpKey = () => (ccy() === "KRW" ? "lump_krw" : "lump_usd");
  function money(v, c = ccy()) {
    if (v == null || !Number.isFinite(v)) return "—";
    return c === "KRW" ? `${won(v)}원` : `$${num(v, Math.abs(v) >= 100000 ? 0 : 2)}`;
  }
  /** 1주 가격: 원화는 줄이지 않고 정확히 (20,153원) */
  const price = (v, c) => (v == null || !Number.isFinite(v) ? "—" : c === "KRW" ? `${num(v, 0)}원` : `$${num(v, v < 1 ? 4 : 2)}`);
  const smoney = (v, c) => (v > 0 ? "+" : v < 0 ? "-" : "") + money(Math.abs(v), c);
  const pct = (v, d = 2) => (v == null ? "—" : `${signed(v * 100, d)}%`);

  function changed(reload = false) {
    cfg.save();
    paintSide();
    clearTimeout(timer);
    timer = setTimeout(() => (reload ? load() : compute()), 300);
  }

  /** 돈 입력: 세 자리마다 쉼표 (500,000). 고치면 바로 다시 계산 */
  function moneyInput(get, set, { width = 170 } = {}) {
    const fmt = (v) => (v ? num(v, ccy() === "KRW" ? 0 : 2).replace(/\.00$/, "") : "0");
    const el = h("input.bt-num", { type: "text", inputMode: "decimal", value: fmt(get()), style: `width:${width}px`, spellcheck: false });
    el.addEventListener("input", () => {
      const raw = el.value.replace(/[^\d.]/g, "");
      const [a, b] = raw.split(".");
      el.value = (a ? Number(a).toLocaleString("en-US") : "") + (b != null && ccy() !== "KRW" ? `.${b.slice(0, 2)}` : "");
    });
    el.addEventListener("change", () => {
      set(Math.max(0, parseFloat(el.value.replace(/,/g, "")) || 0));
      changed();
    });
    el.addEventListener("focus", () => el.select());
    el.addEventListener("keydown", (e) => e.key === "Enter" && el.blur());
    return el;
  }

  /** % 입력 (0.25 → 0.25%) */
  function pctInput(get, set) {
    const el = h("input.bt-num", { type: "text", inputMode: "decimal", value: String(+(get() * 100).toFixed(4)), style: "width:90px", spellcheck: false });
    el.addEventListener("change", () => {
      set(Math.min(0.2, Math.max(0, (parseFloat(el.value) || 0) / 100)));
      el.value = String(+(get() * 100).toFixed(4));
      changed();
    });
    el.addEventListener("focus", () => el.select());
    el.addEventListener("keydown", (e) => e.key === "Enter" && el.blur());
    return el;
  }

  /** 지금 조건을 한 문장으로 (계산이 끝나면 실제로 시작한 달로 고친다) */
  const sumBox = h("div.bt-sum");
  function paintSum() {
    const names = B.symbols.map((id) => describe(id).label).join(" · ") || "종목을 넣어 주세요";
    const { start, end } = periodNow();
    const starts = [...new Set(results.filter((x) => x.r).map((x) => ymStr(x.start)))];
    const from = starts.length === 1 ? starts[0] : starts.length > 1 ? "종목마다 상장 다음 달" : start ?? "상장 다음 달";
    const day = freqText();
    const lump = money(+B[lumpKey()] || 0);
    const onceDays = [...new Set(results.filter((x) => x.r).map((x) => ymd(x.r.summary.first)))];
    const text =
      B.mode === "once"
        ? `${onceDays.length === 1 ? onceDays[0] : B.once_date}에 ${lump}을 한 번에 사서 지금까지 그대로 뒀다면?`
        : B.mode === "both"
          ? `${from}에 목돈 ${lump}을 넣고, ${end}까지 ${day} ${money(+B[monthlyKey()] || 0)}씩 더 샀다면? (종가)`
          : `${from} ~ ${end} 동안 ${day} ${money(+B[monthlyKey()] || 0)}씩 종가로 샀다면?`;
    sumBox.replaceChildren(h("p.bt-sum-names", names), h("p", text), h("p.bt-cost", costText()));
  }

  /** "매월 첫 거래일" · "매주 월요일" · "월·수·금마다" · "매 영업일" */
  function freqText() {
    if (B.freq === "weekly") return `매주 ${WD[B.weekday]}요일`;
    if (B.freq === "days") {
      const d = [...B.weekdays].sort();
      return d.length === 5 ? "매 영업일(월~금)" : `${d.map((x) => WD[x]).join("·")}요일마다`;
    }
    return B.buy_day === "first" ? "매월 첫 거래일" : B.buy_day === "last" ? "매월 마지막 거래일" : `매월 ${B.buy_day_n}일`;
  }

  function costText() {
    const parts = [];
    if (B.fee > 0) parts.push(`매매 수수료 ${+(B.fee * 100).toFixed(4)}%`);
    if (B.div_tax > 0) parts.push(`배당세 ${+(B.div_tax * 100).toFixed(1)}%`);
    if (B.fx_fee > 0) parts.push(`환전 수수료 ${+(B.fx_fee * 100).toFixed(4)}%`);
    return parts.length ? `빼는 것: ${parts.join(" · ")}` : "빼는 것: 없음 (수수료·세금 빼기 전)";
  }

  function paintSide() {
    paintSum();
    const chips = B.symbols.map((id, i) =>
      h(
        "span.bt-chip",
        { style: `border-color:${COLORS[i]}` },
        h("b", { style: `color:${COLORS[i]}` }, describe(id).label),
        h("button", { onclick: () => removeSym(id), "aria-label": "빼기", "data-tip-text": "이 종목 빼기" }, "✕")
      )
    );
    const sel = (opts, get, set) => {
      const s = h("select.set-sel", { onchange: () => set(s.value) });
      for (const [v, l] of opts) s.append(h("option", { value: v, selected: String(get()) === String(v) }, l));
      return s;
    };
    const row = (label, ...c) => h("div.bt-row", h("span.bt-label", label), h("div.bt-ctrl", ...c));
    const saved = B.saved.map((x) => [x.name, x.name]);
    const unit = ccy() === "KRW" ? "원" : "달러";
    const monthly = +B[monthlyKey()] || 0;
    const quick = QUICK[ccy()].map((v) =>
      h(`button.bt-small${monthly === v ? ".on" : ""}`, { onclick: () => ((B[monthlyKey()] = v), changed()) }, ccy() === "KRW" ? `${won(v)}원` : `$${num(v, 0)}`)
    );
    const more = !!B.show_more;
    const lumpQuick = QUICK_LUMP[ccy()].map((v) =>
      h(`button.bt-small${+B[lumpKey()] === v ? ".on" : ""}`, { onclick: () => ((B[lumpKey()] = v), changed()) }, ccy() === "KRW" ? `${won(v)}원` : `$${num(v, 0)}`)
    );
    const now = new Date();
    const agoDate = (n) => `${now.getFullYear() - n}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const onceRows = [
      row("한 번에 넣는 돈", moneyInput(() => B[lumpKey()], (v) => (B[lumpKey()] = v)), h("span.bt-unit", unit), h("div.bt-quick", lumpQuick)),
      row(
        "넣는 날 (그날 종가로 사요, 쉬는 날이면 다음 거래일)",
        h("input.bt-date", { type: "date", value: B.once_date, max: agoDate(0), onchange: (e) => e.target.value && ((B.once_date = e.target.value), changed()) }),
        h("div.bt-quick", [10, 5, 3, 1].map((n) => h(`button.bt-small${B.once_date === agoDate(n) ? ".on" : ""}`, { onclick: () => ((B.once_date = agoDate(n)), changed()) }, `${n}년 전`)))
      ),
      h("p.hint", "그 뒤로는 더 사지 않고 지금까지 그대로 들고 있어요"),
    ];
    const monthlyRows = [
      B.mode === "both" ? row("처음에 넣는 목돈", moneyInput(() => B[lumpKey()], (v) => (B[lumpKey()] = v)), h("span.bt-unit", `${unit} (첫 달에 한 번)`), h("div.bt-quick", lumpQuick)) : null,
      row("얼마나 자주", segment(FREQS, () => B.freq, (v) => ((B.freq = v), changed()))),
      B.freq === "weekly"
        ? row("무슨 요일에", segment([1, 2, 3, 4, 5].map((d) => [d, WD[d]]), () => B.weekday, (v) => ((B.weekday = v), changed())), h("span.hint", "쉬는 날이면 그 주 다음 거래일"))
        : null,
      B.freq === "days"
        ? row(
            "어느 요일마다",
            h(
              "div.bt-ctrl",
              [1, 2, 3, 4, 5].map((d) =>
                h(`button.bt-small${B.weekdays.includes(d) ? ".on" : ""}`, {
                  onclick: () => {
                    const has = B.weekdays.includes(d);
                    if (has && B.weekdays.length === 1) return; // 하나는 남긴다
                    B.weekdays = has ? B.weekdays.filter((x) => x !== d) : [...B.weekdays, d].sort();
                    changed();
                  },
                }, WD[d])
              )
            ),
            h("div.bt-quick", WD_PRESET.map(([days, label]) => h(`button.bt-small${String(B.weekdays) === String(days) ? ".on" : ""}`, { onclick: () => ((B.weekdays = days), changed()) }, label)))
          )
        : null,
      row(
        `${B.mode === "both" ? "그다음 " : ""}${B.freq === "monthly" ? "매달" : B.freq === "weekly" ? "매주" : "살 때마다"} 넣는 돈`,
        moneyInput(() => B[monthlyKey()], (v) => (B[monthlyKey()] = v)),
        h("span.bt-unit", unit),
        B.freq === "monthly" ? h("div.bt-quick", quick) : h("span.hint", perMonthHint())
      ),
      row(
        "기간",
        segment(PERIODS, () => B.period, (v) => {
          B.period = v;
          if (v === "custom" && !B.start) {
            const { end } = periodNow();
            B.start = ymStr({ y: +end.slice(0, 4) - 5, m: +end.slice(5, 7) });
            B.end = end;
          }
          changed();
        }),
        B.period === "custom"
          ? h(
              "div.bt-ctrl",
              h("input.bt-month", { type: "month", value: B.start ?? "", onchange: (e) => ((B.start = e.target.value || null), changed()) }),
              h("span", "~"),
              h("input.bt-month", { type: "month", value: B.end ?? "", onchange: (e) => ((B.end = e.target.value || null), changed()) })
            )
          : null
      ),
    ];
    const extras = [
      B.mode === "once" || B.freq !== "monthly" ? null : row(
        "매수일",
        sel([["first", "매월 첫 거래일"], ["n", "매월 N일"], ["last", "매월 마지막 거래일"]], () => B.buy_day, (v) => ((B.buy_day = v), changed())),
        B.buy_day === "n"
          ? h("span.bt-n", h("input.bt-num", { type: "text", inputMode: "numeric", value: B.buy_day_n, style: "width:70px", onchange: (e) => ((B.buy_day_n = Math.min(31, Math.max(1, Math.round(+e.target.value || 1)))), changed()) }), "일 (쉬는 날이면 다음 거래일)")
          : null
      ),
      row("배당", segment([["accumulate", "현금으로 쌓기"], ["reinvest", "다시 사기"]], () => B.dividends, (v) => ((B.dividends = v), changed()))),
      row("소수점 주식", toggle(() => B.fractional, (v) => ((B.fractional = v), changed())), h("span.hint", "끄면 1주 단위, 남은 돈은 다음 달로")),
      row("공통 기간", toggle(() => B.common_period, (v) => ((B.common_period = v), changed())), h("span.hint", "켜면 모든 종목을 같은 날부터 (늦게 상장한 종목에 맞춤, 공평한 비교)")),
      B.mode === "monthly" ? row("한 번에 넣었다면?", toggle(() => B.compare_lump_sum, (v) => ((B.compare_lump_sum = v), changed())), h("span.hint", "같은 총액을 첫날 한 번에 넣었을 때를 점선으로 같이")) : null,
      h("h3", "수수료·세금 빼기"),
      row("매매 수수료", pctInput(() => B.fee, (v) => (B.fee = v)), h("span.bt-unit", "%  살 때마다 (0 = 안 뺌, 예: 0.25)")),
      row("배당세", segment(DIV_TAX, () => B.div_tax, (v) => ((B.div_tax = v), changed()))),
      row("환전 수수료", pctInput(() => B.fx_fee, (v) => (B.fx_fee = v)), h("span.bt-unit", "%  원화로 미국 종목을 살 때 (예: 0.25)")),
    ];
    side.replaceChildren(
      h("h2", "백테스트"),
      sumBox,
      row("종목 (최대 4개)", h("div.bt-chips", chips, B.symbols.length < 4 ? h("button.bt-add", { onclick: addSym, "data-tip-text": "종목 넣기 (최대 4개)\n같은 조건으로 나란히 비교해요" }, "＋ 넣기") : null)),
      row("투자 방법", segment(MODES, () => B.mode, (v) => ((B.mode = v), changed()))),
      ...(B.mode === "once" ? onceRows : monthlyRows).filter(Boolean),
      row("통화", segment([["USD", "달러 $"], ["KRW", "원화 ₩"]], () => ccy(), (v) => ((B.currency = v), changed()))),
      h("button.bt-more", { onclick: () => ((B.show_more = !more), cfg.save(), paintSide()) }, `${more ? "▾" : "▸"} 더 많은 조건 · 수수료·세금`),
      h("div.bt-extra", { hidden: !more }, extras),
      h("h3", "저장한 조건"),
      h(
        "div.bt-saved",
        saved.length ? sel([["", "불러오기…"], ...saved], () => "", (name) => loadSaved(name)) : h("span.hint", "아직 없어요"),
        h("button", { onclick: saveCurrent }, "지금 조건 저장"),
        saved.length ? h("button", { onclick: deleteSaved }, "지우기") : null
      )
    );
  }

  /** 매주·요일마다일 때: 한 달에 대략 얼마가 들어가는지 */
  function perMonthHint() {
    const per = +B[monthlyKey()] || 0;
    const n = B.freq === "weekly" ? 4.35 : B.weekdays.length * 4.35;
    return `한 달에 약 ${Math.round(n)}번 → 약 ${money(per * n)}`;
  }

  /** 기간 버튼 → {start: "YYYY-MM" | null(상장 다음 달), end: "YYYY-MM"} */
  function periodNow() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const end = ymStr({ y, m });
    const n = { "10y": 10, "5y": 5, "3y": 3, "1y": 1 }[B.period];
    if (n) return { start: ymStr({ y: y - n, m }), end };
    if (B.period === "custom") return { start: B.start, end: B.end ?? end };
    return { start: null, end };
  }

  function addSym() {
    openPicker((id) => {
      const info = describe(id);
      const no = NOT_FOR_BT[info.kind];
      if (no) return toast(`${no}는 백테스트에 쓰지 않아요 (사서 들고 있는 상품이 아니라서)`);
      if (B.symbols.includes(id)) return;
      B.symbols = [...B.symbols, id].slice(0, 4);
      // 한국 종목만이거나 섞이면 원화로 맞춘다
      if (B.symbols.some((x) => nativeOf(x) === "KRW")) B.currency = "KRW";
      changed(true);
    });
  }

  function removeSym(id) {
    B.symbols = B.symbols.filter((x) => x !== id);
    changed(true);
  }

  const COND_KEYS = ["mode", "freq", "weekday", "weekdays", "once_date", "lump_krw", "lump_usd", "symbols", "period", "start", "end", "common_period", "currency", "monthly_usd", "monthly_krw", "buy_day", "buy_day_n", "initial", "dividends", "fractional", "compare_lump_sum", "fee", "div_tax", "fx_fee"];
  async function saveCurrent() {
    const name = await ask("조건 이름", { placeholder: "예: 나스닥 3형제 10년" });
    if (!name) return;
    const cond = Object.fromEntries(COND_KEYS.map((k) => [k, structuredClone(B[k])]));
    B.saved = [...B.saved.filter((x) => x.name !== name), { name, ...cond }];
    changed();
    toast(`"${name}" 저장했어요`);
  }
  function loadSaved(name) {
    const x = B.saved.find((s) => s.name === name);
    if (!x) return;
    for (const k of COND_KEYS) if (k in x) B[k] = structuredClone(x[k]);
    changed(true);
  }
  async function deleteSaved() {
    const names = B.saved.map((x) => x.name);
    const name = names.length === 1 ? names[0] : await ask(`지울 조건 이름 (${names.join(", ")})`, { value: names[names.length - 1], ok: "지우기" });
    if (!name || !names.includes(name)) return;
    if (!(await confirmBox(`"${name}" 조건을 지울까요?`, null, { ok: "지우기", danger: true }))) return;
    B.saved = B.saved.filter((x) => x.name !== name);
    changed();
  }

  // ── 데이터 ──
  async function load() {
    const my = ++token;
    status.textContent = "데이터 읽는 중…";
    const ids = [...B.symbols];
    const key = keyNow();
    const need = true; // 배당을 원·달러로 같이 보여 주려고 환율은 늘 읽는다
    const read = async (id, basis = "split") => {
      const info = describe(id);
      let s = await loadSeries(info, "1D", { basis });
      if (!s.bars.length) {
        status.textContent = `${info.label} 일봉 받는 중… (처음 한 번)`;
        await data.ensure(info, "1D", { front: true });
        s = await loadSeries(info, "1D", { basis });
      }
      return s;
    };
    const next = new Map();
    for (const id of ids) next.set(id, await read(id));
    const fx = need ? await read("KRW=X", "raw") : null;
    if (my !== token) return;
    series = next;
    fxBars = fx?.bars?.length ? fx.bars : null;
    loadedKey = key;
    compute();
  }

  function compute() {
    try {
      computeInner();
    } catch (e) {
      console.warn("[backtest]", e);
      status.textContent = `계산하지 못했어요 (${e?.message ?? e}) · 종목·기간을 바꿔 보세요`;
    }
  }

  function computeInner() {
    const ids = B.symbols.filter((id) => series.get(id)?.bars.length);
    const missing = B.symbols.filter((id) => !series.get(id)?.bars.length);
    if (loadedKey !== keyNow()) return load();
    const now = new Date();
    const thisMonth = { y: now.getFullYear(), m: now.getMonth() + 1 };
    const per = periodNow();
    const end = per.end ? parseYm(per.end) : thisMonth;
    const userStart = per.start ? parseYm(per.start) : null;
    const warn = [];
    const fxStart = fxBars?.length ? parseYm(ymOf(fxBars[0].t)) : null;
    const starts = ids.map((id) => firstFullMonth(series.get(id).bars));
    const latest = starts.reduce((a, b) => (!a || ymNum(ymStr(b)) > ymNum(ymStr(a)) ? b : a), null);
    const needFx = (id) => nativeOf(id) !== ccy();
    const later = (a, b) => (!a ? b : b && ymNum(ymStr(b)) > ymNum(ymStr(a)) ? b : a);
    // 공통 기간: 모두 같은 달부터 (환율이 필요한 종목이 있으면 환율 기록 시작도 맞춘다)
    let common = later(latest, userStart);
    if (B.common_period && B.mode !== "once") {
      if (per.start && ymNum(per.start) < ymNum(ymStr(latest))) warn.push(`가장 늦게 상장한 종목에 맞춰 ${ymStr(latest)}부터 계산했어요 (공통 기간)`);
      if (ids.some(needFx) && fxStart && ymNum(ymStr(common)) < ymNum(ymStr(fxStart))) {
        warn.push(`원/달러 환율 기록이 ${ymStr(fxStart)}부터라 모두 ${ymStr(fxStart)}부터 계산했어요 (공통 기간)`);
        common = fxStart;
      }
    }
    // 한 번에 넣기: 고른 날(상장 전이면 상장일, 환율이 필요하면 환율 기록 시작일 이후)
    const once = B.mode === "once";
    const wantDay = parseYmd(B.once_date);
    const fxDay = fxBars?.length ? fxBars[0].t : null;
    const dayOf = (id) => Math.max(wantDay, series.get(id).bars[0].t, needFx(id) && fxDay ? fxDay : -Infinity);
    const commonDay = once ? Math.max(...ids.map(dayOf)) : null;
    if (once && ids.length) {
      for (const id of ids) {
        const d = B.common_period ? commonDay : dayOf(id);
        if (d <= wantDay + 6 * 86400) continue; // 주말·연휴로 며칠 밀린 것은 말하지 않는다
        const why = fxDay && d === fxDay && needFx(id) ? "원/달러 환율 기록이 없어서" : d === series.get(id).bars[0].t ? "아직 상장 전이라" : "늦게 상장한 종목에 맞추느라 (공통 기간)";
        warn.push(`${describe(id).label}: ${B.once_date}에는 ${why} ${ymd(d)}부터 계산했어요`);
      }
    }
    results = ids.map((id, i) => {
      const s = series.get(id);
      const native = nativeOf(id);
      if (once) {
        const at = B.common_period ? commonDay : dayOf(id);
        const r = runDca(s, { start: parseYm(ymOf(at)), end: thisMonth, onceAt: at, monthly: 0, initial: +B[lumpKey()] || 0, buyDay: "first", dividends: B.dividends, fractional: B.fractional, ccy: ccy(), native, fx: fxBars ? fxLookup(fxBars) : null, lump: false, fee: B.fee, divTax: B.div_tax, fxFee: B.fx_fee });
        return { id, info: describe(id), color: COLORS[B.symbols.indexOf(id)], native, start: parseYm(ymOf(at)), r };
      }
      let start = B.common_period ? common : later(starts[i], userStart);
      if (!B.common_period && needFx(id) && fxStart && ymNum(ymStr(start)) < ymNum(ymStr(fxStart))) {
        warn.push(`${describe(id).label}: 원/달러 환율 기록이 ${ymStr(fxStart)}부터라 그때부터 계산했어요`);
        start = fxStart;
      }
      const r = runDca(s, {
        start,
        end,
        monthly: +B[monthlyKey()] || 0,
        initial: B.mode === "both" ? +B[lumpKey()] || 0 : 0,
        buyDay: B.buy_day,
        buyDayN: B.buy_day_n,
        freq: B.freq,
        weekday: B.weekday,
        weekdays: B.weekdays,
        dividends: B.dividends,
        fractional: B.fractional,
        ccy: ccy(),
        native,
        fx: fxBars ? fxLookup(fxBars) : null,
        lump: B.mode === "monthly" && B.compare_lump_sum,
        fee: B.fee,
        divTax: B.div_tax,
        fxFee: B.fx_fee,
      });
      return { id, info: describe(id), color: COLORS[B.symbols.indexOf(id)], native, start, r };
    });
    if (missing.length) warn.push(`데이터가 없어요: ${missing.map((x) => describe(x).label).join(", ")}`);
    if (!fxBars && ids.some((id) => nativeOf(id) !== ccy())) warn.push("원/달러 환율(KRW=X) 데이터가 없어서 다른 통화로 바꿔 계산하지 못했어요 · 🔄으로 받아 주세요");
    status.textContent = "";
    if (!tableSym || !ids.includes(tableSym)) tableSym = ids[0] ?? null;
    paintSum();
    paintCards(warn);
    paintChart();
    paintTable();
  }

  // ── 결과 ──
  function paintCards(warn) {
    const ok = results.filter((x) => x.r);
    const best = (f, low = false) => {
      const vals = ok.map((x) => f(x.r.summary)).filter((v) => v != null);
      return vals.length > 1 ? (low ? Math.min(...vals) : Math.max(...vals)) : null;
    };
    const bValue = best((s) => s.value / (s.principal || 1));
    const bXirr = best((s) => s.xirr);
    const bMdd = best((s) => s.mdd, true);
    const bWorst = best((s) => s.worst);
    const star = (v, b) => (b != null && v === b ? h("span.bt-star", { "data-tip-text": "비교한 종목 중 가장 좋아요" }, "★") : null);
    const d = (t) => (t ? ymd(t) : "—");
    cards.replaceChildren(
      ...results.map(({ id, info, color, native, r }) => {
        if (!r) return h("div.bt-card", { style: `border-top-color:${color}` }, h("div.bt-card-head", h("b", info.label)), h("p.hint", "이 기간에는 계산할 수 있는 날이 없어요"));
        const s = r.summary;
        const line = (label, value, cls = "", extra = null, tip = null) => h("div.bt-line", { "data-tip-text": tip }, h("span.bt-k", label), h(`span.bt-v${cls ? "." + cls : ""}`, value), extra);
        const cl = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
        return h(
          "div.bt-card",
          { style: `border-top-color:${color}` },
          h("div.bt-card-head", h("b", { style: `color:${color}` }, info.label), h("span.muted", info.sub), h("div.grow"), h("button.bt-small", { onclick: () => showOnChart?.(id, r.buys.map((b) => b.t)), "data-tip-text": "차트로 가서 매수한 날을 점으로 표시해요" }, "차트에서 보기")),
          line("총 투자금", money(s.principal), "", null, `${ymd(s.first)} ~ ${ymd(s.last)} · ${s.buys}번 샀어요`),
          line("평가금", money(s.value), "big", star(s.value / (s.principal || 1), bValue)),
          line("수익금", smoney(s.profit), cl(s.profit)),
          line("수익률", pct(s.ret, 1), cl(s.ret)),
          line("연환산 (XIRR)", pct(s.xirr, 2), cl(s.xirr), star(s.xirr, bXirr), "XIRR: 돈을 넣은 날짜까지 따져서 1년에 몇 %씩 불어난 셈인지 (엑셀 XIRR과 같은 계산)"),
          line("보유 수량", `${num(s.shares, B.fractional ? 4 : 0)}주`, "", null, "지금 기준 수량 (분할 반영)"),
          line("평균 매수가", s.avgCost == null ? "—" : price(s.avgCost, native), "", null, "주식 사는 데 쓴 돈 ÷ 산 수량 (재투자한 배당 빼고, 지금 기준 가격)"),
          line("최대 낙폭", `-${num(s.mdd * 100, 1)}%`, "down", star(s.mdd, bMdd), `평가금이 가장 높았던 때(${d(s.mddPeak)})보다 가장 많이 줄었던 때(${d(s.mddTrough)})\n적립식은 돈이 계속 들어와서 실제보다 작아 보일 수 있어요 → 아래 '원금 대비 최악'도 같이 봐요`),
          line("원금 대비 최악", `${pct(s.worst, 1)} (${d(s.worstT)})`, cl(s.worst), star(s.worst, bWorst), "가장 힘들었던 순간: 넣은 돈보다 평가금이 가장 적었던 날"),
          line("매수 횟수", `${s.buys}번`, "", null, `${ymd(s.first)} ~ ${ymd(s.last)}`),
          s.splits?.length
            ? line(
                "분할·병합",
                s.splits.map((x) => `${ymd(x.t).slice(2)} ${x.r >= 1 ? `${+x.r.toFixed(3)}:1` : `1:${+(1 / x.r).toFixed(3)}`}`).join(" · "),
                "",
                null,
                "기간 중에 있었던 분할(주식 수 늘어남)·병합(줄어듦)을 모두 반영했어요\n보유 수량·평균 매수가는 지금 기준이에요 (예: 2:1 분할 전에 100주 샀으면 200주로)\n실제로 그때 산 수량은 아래 '월별 매수 내역'의 '산 수량(실제)'"
              )
            : null,
          s.fee + s.tax + s.fxFee > 0 ? line("뺀 수수료·세금", money(s.fee + s.tax + s.fxFee), "down", null, `매매 수수료 ${money(s.fee)}\n배당세 ${money(s.tax)}\n환전 수수료 ${money(s.fxFee)}`) : null,
          ...splitBlock(r, native, cl),
          s.lumpValue != null ? line("거치식이었다면", `${money(s.lumpValue)} · 연 ${pct(s.lumpXirr, 1)}`, "", null, `같은 총액 ${money(s.lumpPrincipal)}을 첫 매수일에 한 번에 넣었다면`) : null
        );
      })
    );
    const fxNote = results.filter((x) => x.r?.summary.fxMiss).map((x) => `${x.info.label}: 환율 대체 사용 ${x.r.summary.fxMiss}일 (가장 길게 ${x.r.summary.fxMaxGap}일 전 환율)`);
    const krNote = results.some((x) => x.native === "KRW") ? [h("p.hint", "국내 종목 배당·분배금은 Yahoo 기록을 써요. 빠진 것이 있을 수 있어요.")] : [];
    notes.replaceChildren(...warn.map((w) => h("p.bt-warn", `⚠ ${w}`)), ...fxNote.map((t) => h("p.hint", t)), ...krNote, h("p.hint", `${costText()} · ${DISCLAIMER}`));
  }

  /** 평가금 나눠 보기: 주식만(내 돈으로 산 것) · 받은 배당(원·달러 함께) · 배당 몫 · 잔돈 */
  function splitBlock(r, native, cl) {
    const s = r.summary;
    const fx = fxBars ? fxLookup(fxBars) : null;
    // 배당을 원·달러 둘 다: 배당락일 환율로 바꿔 더한다
    let krw = 0;
    let usd = 0;
    let ok = !!fx || native === ccy();
    for (const d of r.divs) {
      const rate = fx?.(d.t)?.rate;
      if (native === "USD") (usd += d.amount), (krw += rate ? d.amount * rate : NaN);
      else (krw += d.amount), (usd += rate ? d.amount / rate : NaN);
    }
    if (!Number.isFinite(krw) || !Number.isFinite(usd)) ok = false;
    const both = s.div > 0 ? (ok ? `${money(krw, "KRW")} · ${money(usd, "USD")}` : money(s.div)) : "없음";
    const stockRet = s.principal ? s.stockValue / s.principal - 1 : 0;
    const row = (label, value, cls = "", tip = null) => h("div.bt-line.bt-sub", { "data-tip-text": tip }, h("span.bt-k", label), h(`span.bt-v${cls ? "." + cls : ""}`, value));
    return [
      h("div.bt-split-head", "나눠 보기 · 주식 / 배당"),
      row("주식만 평가금", `${money(s.stockValue)}  ${pct(stockRet, 1)}`, cl(stockRet), "내 돈으로 산 주식만 지금 가격으로 (배당은 빼고)\n오른 % = 주가로만 번 수익률"),
      row("받은 배당 (세금 뺀 뒤)", both, "", "기간 동안 받은 배당 합계. 원·달러는 배당락일 환율로 바꿨어요"),
      row(B.dividends === "reinvest" ? "배당으로 산 주식" : native !== ccy() ? "쌓인 배당 현금 (지금 환율)" : "쌓인 배당 현금", B.dividends === "reinvest" ? `${num(s.divShares, 4)}주 · 지금 ${money(s.divValue)}` : money(s.divValue), "", B.dividends === "reinvest" ? "배당을 그날 종가로 다시 산 주식의 지금 가치" : "받은 배당을 쓰지 않고 모아 둔 돈 (평가금에 들어 있어요)"),
      s.leftValue >= 0.5 ? row("남은 잔돈", money(s.leftValue), "", "1주 단위로 사고 남은 돈") : null,
      row("합계 = 평가금", money(s.value), "", "주식만 평가금 + 배당 몫 + 잔돈"),
    ];
  }

  function paintChart() {
    for (const s of lines) chart.removeSeries(s);
    lines = [];
    const ok = results.filter((x) => x.r);
    const sameStart = B.common_period || ok.length <= 1;
    ok.forEach(({ color, r }, i) => {
      if (i === 0 || !sameStart) {
        const p = chart.addSeries(LC.LineSeries, { color: sameStart ? "#a0a6ae" : color, lineWidth: 1, lineType: 1, lineStyle: sameStart ? 0 : 3, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        p.setData(r.days.map((d) => ({ time: d.t, value: d.principal })));
        lines.push(p);
      }
      const v = chart.addSeries(LC.LineSeries, { color, lineWidth: 2, priceLineVisible: false });
      v.setData(r.days.map((d) => ({ time: d.t, value: d.value })));
      lines.push(v);
      if (r.lump) {
        const l = chart.addSeries(LC.LineSeries, { color, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
        l.setData(r.lump.map((d) => ({ time: d.t, value: d.value })));
        lines.push(l);
      }
    });
    chart.priceScale("right").applyOptions({ mode: logScale ? 1 : 0 });
    fit();
    paintLegend(null);
  }

  /** 처음부터 끝까지 보이게 — 화면이 막 보이기 시작해서 크기가 0이면 잡힐 때까지 기다린다 */
  function fit() {
    if (!chartBox.clientWidth) return requestAnimationFrame(fit);
    requestAnimationFrame(() => chart.timeScale().fitContent());
  }

  chart.subscribeCrosshairMove((p) => paintLegend(p?.time ?? null));

  function paintLegend(t) {
    const ok = results.filter((x) => x.r);
    const rows = ok.map(({ info, color, r }) => {
      const d = t == null ? r.days[r.days.length - 1] : nearest(r.days, t);
      if (!d) return null;
      const ret = d.principal ? d.value / d.principal - 1 : 0;
      return h("div", h("b", { style: `color:${color}` }, info.label), ` ${money(d.value)} `, h(`span.${ret >= 0 ? "up" : "down"}`, pct(ret, 1)), h("span.muted", ` · 넣은 돈 ${money(d.principal)}`));
    });
    const first = ok[0]?.r.days;
    const day = t ?? first?.[first.length - 1]?.t;
    legend.replaceChildren(day ? h("div.muted", ymd(day)) : "", ...rows.filter(Boolean));
  }

  function nearest(days, t) {
    let lo = 0;
    let hi = days.length - 1;
    if (!days.length || t < days[0].t) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (days[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return days[lo];
  }

  function paintTable() {
    const ok = results.filter((x) => x.r);
    const bar = [
      segment([["years", "연도별"], ["months", "매수 내역"]], () => tab, (v) => ((tab = v), paintTable())),
      tab === "months" && ok.length > 1 ? segment(ok.map((x) => [x.id, x.info.label]), () => tableSym, (v) => ((tableSym = v), paintTable())) : null,
      h("div.grow"),
      h("button", { onclick: saveCsv, "data-tip-text": "월별 매수 내역을 CSV로 저장 (엑셀에서 바로 열려요)\n문서\\FAKE TRADING POWER CHART 폴더" }, "CSV 저장"),
    ];
    tabs.replaceChildren(...bar.filter(Boolean));
    if (!ok.length) return table.replaceChildren();
    if (tab === "years") {
      const years = [...new Set(ok.flatMap((x) => x.r.years.map((y) => y.year)))].sort((a, b) => b - a);
      const head = h("tr", h("th", "연도"), ...ok.map((x) => h("th", { colSpan: 5, style: `color:${x.color}` }, x.info.label)));
      const sub = h("tr", h("th", ""), ...ok.flatMap(() => [h("th", "넣은 돈"), h("th", "평가금"), h("th", "그해 배당"), h("th", { "data-tip-text": "그해에 넣은 돈은 빼고 계산한 수익률" }, "그해 수익률"), h("th", "누적")]));
      const body = years.map((y) =>
        h(
          "tr",
          h("td", String(y)),
          ...ok.flatMap((x) => {
            const r = x.r.years.find((z) => z.year === y);
            if (!r) return [h("td", ""), h("td", ""), h("td", ""), h("td", ""), h("td", "")];
            return [h("td", money(r.principal)), h("td", money(r.value)), h("td", r.div ? money(r.div) : ""), h(`td.${r.ret >= 0 ? "up" : "down"}`, pct(r.ret, 1)), h(`td.${r.cumRet >= 0 ? "up" : "down"}`, pct(r.cumRet, 1))];
          })
        )
      );
      table.replaceChildren(h("table.bt-tbl", h("thead", head, sub), h("tbody", body)));
      return;
    }
    const x = ok.find((o) => o.id === tableSym) ?? ok[0];
    const fxOn = x.native !== ccy();
    const head = h("tr", ...["매수일", "종가(수정)", "실제 가격", "산 수량(지금 기준)", "산 수량(실제)", "누적 수량", "누적 원금", "평가금", fxOn ? "환율" : null, "메모"].filter(Boolean).map((t) => h("th", t)));
    const rows = [...x.r.buys].reverse().map((b) =>
      h(
        "tr",
        h("td", ymd(b.t)),
        h("td", price(b.price, x.native)),
        h("td", price(b.raw, x.native)),
        h("td", num(b.shares, 4)),
        h("td", num(b.rawShares, 4)),
        h("td", num(b.cum, 4)),
        h("td", money(b.principal)),
        h("td", money(b.value)),
        fxOn ? h("td", num(b.fx, 2)) : null,
        h("td.bt-memo", noteText(b, x.native))
      )
    );
    table.replaceChildren(h("table.bt-tbl", h("thead", head), h("tbody", rows)));
  }

  function noteText(b, native) {
    return (b.notes ?? []).map((n) => (typeof n === "string" ? n : `배당 ${price(n.div.perShare, native)}/주 · ${money(n.div.amount, native)}`)).join(" · ");
  }

  async function saveCsv() {
    const ok = results.filter((x) => x.r);
    if (!ok.length) return;
    const x = ok.find((o) => o.id === tableSym) ?? ok[0];
    const fxOn = x.native !== ccy();
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const head = ["매수일", `종가(수정, ${x.native})`, `실제 가격(${x.native})`, "산 수량(지금 기준)", "산 수량(실제)", "누적 수량", `누적 원금(${ccy()})`, `평가금(${ccy()})`, ...(fxOn ? ["환율"] : []), "메모"];
    const lines = [head.map(esc).join(",")];
    for (const b of x.r.buys) {
      lines.push([ymd(b.t), b.price.toFixed(4), b.raw.toFixed(4), b.shares.toFixed(6), b.rawShares.toFixed(6), b.cum.toFixed(6), b.principal.toFixed(2), b.value.toFixed(2), ...(fxOn ? [b.fx.toFixed(4)] : []), noteText(b, x.native)].map(esc).join(","));
    }
    const name = `backtest_${x.id.replace(/[^A-Za-z0-9_.-]/g, "_")}_${ymd(Math.floor(Date.now() / 1000))}.csv`;
    try {
      const where = await invoke("save_export", { name, text: lines.join("\r\n") });
      toast(`CSV 저장했어요\n${where}`, 6000);
      invoke("open_folder", { which: "exports" }).catch(() => {});
    } catch (e) {
      toast(`CSV 저장 실패 (${e.message ?? e})`);
    }
  }

  data.on("bars", ({ id, tf }) => {
    if (tf === "1D" && (B.symbols.includes(id) || id === "KRW=X") && !root.hidden) {
      clearTimeout(timer);
      loadedKey = null;
      timer = setTimeout(load, 1500);
    }
  });

  paintSide();
  return {
    show() {
      paintSide();
      loadedKey = null;
      load();
    },
  };
}
