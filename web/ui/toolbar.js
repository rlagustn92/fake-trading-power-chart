// 툴바 (SPEC §3.1, §0.2 짧게): [차트][백테스트] │ 종목 ▾ │ 봉 7개 │ 💰 모의매매 │ 지표 │ ✏️ │ 📏 │ ▦ 분할 │ ⇄ │ 보기 ▾ │ 🔔 │ ⛶ ⚙
import { h } from "./dom.js";
import { TIMEFRAMES } from "../core/bars.js";
import { TF_NAME } from "../core/data.js";
import { openMenu } from "./menu.js";
import { SPLIT_ORDER, SPLIT_NAME } from "./grid.js";
import { ask, confirmBox } from "./dialog.js";
import { openGoto } from "./goto.js";
import { describe } from "../core/symbols.js";

/** 버튼 글자: 넓으면 full, 좁으면 short (툴바가 화면 밖으로 넘치지 않게, QA #22) */
const lbl = (full, short) => [h("span.lbl-full", full), h("span.lbl-short", short)];

export function createToolbar(root, app) {
  const { cfg } = app;
  const wlBtn = h("button.icon.tb-wl", { onclick: () => app.setSidebar(!cfg.layout.sidebar_visible), "data-tip-text": "관심종목 접기 / 펴기 (Tab)\n접으면 차트를 넓게 써요" }, "☰");
  const modeChart = h("button.mode.on", { onclick: () => app.setMode("chart") }, "차트");
  const modeBt = h("button.mode", { onclick: () => app.setMode("backtest"), "data-tip-text": "백테스트 (Ctrl+B)\n매달 모으기 · 한 번에 넣고 두기 · 장마감가 기준" }, "백테스트");
  const symName = h("span.tb-sym-name");
  const symSub = h("span.tb-sym-sub");
  const symBtn = h("button.tb-sym", { onclick: () => app.openPicker(), "data-tip-text": "종목 바꾸기\n차트 위에서 그냥 글자를 쳐도 돼요 (예: SOXL, 삼성)" }, symName, symSub, h("span.tb-caret", "▾"));
  const tfBtns = TIMEFRAMES.map((tf, i) => h("button.tf", { onclick: () => app.grid.setTimeframe(tf), "data-tip-text": `${TF_NAME[tf]}봉 (Alt+${i + 1})` }, TF_NAME[tf]));
  const tradeBtn = h("button.tb-trade", { onclick: () => app.toggleTrade(), "data-tip-text": "💰 모의매매 창 열기·닫기\n과거 차트를 리플레이하며 가상 돈으로 롱·숏 연습 (진짜 주문 없음)" }, lbl("💰 모의매매", "💰"));
  const indBtn = h("button", { onclick: () => app.openIndicators(), "data-tip-text": "지표 넣기·빼기 (Ctrl+I)\nSMA·볼린저 밴드·VWMA·RSI·MACD…" }, lbl("지표 ＋", "지표＋"));
  const indClear = h("button", { onclick: () => clearMenu(), "data-tip-text": "지표 모두 지우기\n분할 화면이면 '이 칸만' 또는 '보이는 칸 모두'를 고르세요\n잘못 눌렀으면 오른쪽 아래 '되돌리기'" }, lbl("지표 지우기", "🧹"));
  const drawBtn = h("button.icon", { onclick: () => app.toggleDrawBar(), "data-tip-text": "그리기 도구\n추세선·인포선·수평선·삼각수렴·피보나치·Anchored VWAP" }, "✏️");
  const measureBtn = h("button.icon", { onclick: () => (app.grid.current?.toggleMeasure(), app.drawbarPaint?.()), "data-tip": "measure" }, "📏");
  const gotoBtn = h("button.icon", { onclick: () => openGoto({ grid: app.grid, toast: app.toast }), "data-tip-text": "📅 날짜로 가기 (Ctrl+G)\n몇 년 몇 월 며칠로 한 번에 (봉도 같이 바꿀 수 있어요)\n분할 화면: 이 칸만 · 보이는 칸 모두 · Ctrl+클릭으로 고른 칸" }, "📅");
  const splitBtn = h("button", { onclick: () => splitMenu(), "data-tip-text": "분할 화면\n여러 차트를 한 번에 (1~16칸)" }, lbl("▦ 분할", "▦"));
  const matchBtn = h("button", { onclick: () => app.grid.matchAll(), "data-tip-text": "⇄ 모두 맞추기\n선택한 칸의 봉·지표·보이는 기간을 다른 칸 모두에 똑같이\nCtrl+클릭으로 칸을 고르면 그 칸들에만" }, ...lbl("⇄ 모두 맞추기", "⇄"));
  const indMatch = h("button", { onclick: () => matchIndicators(), "data-tip-text": "지표 맞추기\n선택한 칸(파란 테두리)의 지표를 다른 칸 모두에 똑같이\nCtrl+클릭으로 칸을 몇 개 고르면(주황 테두리) 그 칸들에만" }, ...lbl("지표 맞추기", "≡지표"));
  const viewBtn = h("button", { onclick: () => viewMenu() }, lbl("보기 ▾", "보기"));
  const alertBtn = h("button.icon", { onclick: () => app.openAlerts(), "data-tip-text": "🔔 알림\n가격이 선·지표를 넘으면 알려줘요" }, "🔔");
  const fsBtn = h("button.icon", { onclick: () => app.toggleFullscreen(), "data-tip-text": "전체화면 (F11)" }, "⛶");
  const gearBtn = h("button.icon", { onclick: () => app.openSettings(), "data-tip-text": "설정 (Ctrl+,)" }, "⚙");

  root.replaceChildren(
    wlBtn,
    h("div.tb-group", modeChart, modeBt),
    h("div.tb-sep"),
    h("div.tb-chart", symBtn, h("div.tb-group.tfs", tfBtns), tradeBtn, indBtn, indClear, drawBtn, measureBtn, gotoBtn, splitBtn, indMatch, matchBtn, viewBtn, alertBtn),
    h("div.grow"),
    fsBtn,
    gearBtn
  );

  function paint() {
    wlBtn.classList.toggle("on", !!cfg.layout.sidebar_visible);
    const c = app.grid.current;
    if (!c) return;
    symName.textContent = c.cc.symbol ? c.info.label : "종목 고르기";
    symSub.textContent = c.info.kind === "kr" ? c.info.sub : c.info.sub;
    tfBtns.forEach((b, i) => {
      const tf = TIMEFRAMES[i];
      b.classList.toggle("on", tf === c.tf);
      b.disabled = !c.info.tfs.includes(tf);
    });
    matchBtn.hidden = app.grid.cells.length < 2;
    indMatch.hidden = app.grid.cells.length < 2;
    const np = app.grid.picked;
    indMatch.firstChild.textContent = np ? `지표 맞추기 (${np}칸)` : "지표 맞추기";
    indMatch.lastChild.textContent = np ? `≡${np}칸` : "≡지표";
    matchBtn.firstChild.textContent = np ? `⇄ 맞추기 (${np}칸)` : "⇄ 모두 맞추기";
    matchBtn.lastChild.textContent = np ? `⇄${np}` : "⇄";
    setTimeout(fit, 0);
    measureBtn.classList.toggle("on", c.measure.on);
  }

  function matchIndicators() {
    const c = app.grid.current;
    const r = app.grid.matchIndicators();
    app.grid.clearPicks();
    paint();
    if (r.count) app.toast(`${c.info.label} 칸의 지표 ${c.insts.length}개를 ${r.count}칸에 맞췄어요`, 6000, { label: "되돌리기", onclick: () => (r.undo(), paint()) });
  }

  function clearMenu() {
    const n = app.grid.cells.length;
    if (n < 2) return clearIndicators("one");
    const c = app.grid.current;
    openMenu(indClear, [
      { header: "지표 지우기" },
      { label: "이 칸만", sub: `${c.info.label} ${TF_NAME[c.tf]}`, onclick: () => clearIndicators("one") },
      { label: `보이는 칸 모두 (${n}칸)`, sub: "지금 화면에 보이는 칸만", onclick: () => clearIndicators("all") },
    ]);
  }

  function clearIndicators(scope) {
    const r = app.grid.clearIndicators(scope);
    paint();
    if (r.count) app.toast(`지표 ${r.count}개를 모두 뺐어요`, 6000, { label: "되돌리기", onclick: () => (r.undo(), paint()) });
    else app.toast("지울 지표가 없어요");
  }

  /** 넘치면 짧은 글자 → 그래도 넘치면 더 작게 */
  function fit() {
    root.classList.remove("compact", "tiny");
    if (root.scrollWidth > root.clientWidth + 1) {
      root.classList.add("compact");
      if (root.scrollWidth > root.clientWidth + 1) root.classList.add("tiny");
    }
  }
  // 폭이 바뀔 때만 (글자를 바꾸면 높이가 바뀌어 다시 불리므로 그때는 무시 → 무한 반복 방지)
  let lastW = 0;
  new ResizeObserver(() => {
    if (root.clientWidth === lastW) return;
    lastW = root.clientWidth;
    setTimeout(fit, 0);
  }).observe(root);

  function setMode(m) {
    modeChart.classList.toggle("on", m === "chart");
    modeBt.classList.toggle("on", m === "backtest");
    root.querySelector(".tb-chart").hidden = m !== "chart";
  }

  function splitMenu() {
    const L = cfg.grid.layouts;
    const cur = L[cfg.grid.current];
    openMenu(splitBtn, [
      { header: "칸 나누기" },
      ...SPLIT_ORDER.map((k) => ({ label: `${SPLIT_NAME[k]}칸`, on: String(cur.split === "2" ? "2h" : cur.split) === k, onclick: () => app.grid.setSplit(k) })),
      {
        label: "🧹 이 화면 모두 비우기",
        sub: "칸을 빈 칸으로 → 원하는 종목만 넣기",
        disabled: app.grid.cells.length < 2,
        onclick: async () => {
          if (!(await confirmBox("지금 보이는 칸을 모두 비울까요?", "빈 칸의 '＋ 종목 넣기'로 원하는 종목을 넣으면 돼요. 오른쪽 아래 '되돌리기'로 되돌릴 수 있어요.", { ok: "모두 비우기", danger: true }))) return;
          const undo = app.grid.clearAll(); // 모의매매 중이면 먼저 묻고 그 뒤에 비운다 (null)
          if (undo) app.toast("모든 칸을 비웠어요", 8000, { label: "되돌리기", onclick: undo });
        },
      },
      { label: "칸 옮기기: 칸 위쪽 이름 줄을 꾹 눌러 다른 칸으로 끌기", disabled: true },
      { sep: true },
      { header: "저장한 화면" },
      ...Object.keys(L).map((name) => ({ label: name, sub: `${L[name].cells?.length ?? 1}칸`, on: name === cfg.grid.current, onclick: () => app.grid.setLayout(name) })),
      {
        label: "＋ 지금 화면을 이름 붙여 저장",
        onclick: async () => {
          const name = await ask("지금 화면 이름", { placeholder: "예: 아침 체크, SOXL 단타" });
          if (name) app.grid.saveLayoutAs(name);
        },
      },
      {
        label: `"${cfg.grid.current}" 지우기`,
        disabled: Object.keys(L).length <= 1,
        onclick: async () => {
          if (await confirmBox(`"${cfg.grid.current}" 화면을 지울까요?`, null, { ok: "지우기", danger: true })) app.grid.deleteLayout(cfg.grid.current);
        },
      },
    ]);
  }

  function viewMenu() {
    const c = app.grid.current;
    if (!c) return;
    const cc = c.cc;
    const basis = () => cc.basis ?? cfg.chart.price_basis;
    const daily = ["1D", "1W"].includes(c.tf);
    const scale = () => cc.scale ?? (daily ? cfg.chart.scale_daily : cfg.chart.scale_intraday);
    const type = () => cc.chart_type ?? cfg.chart.chart_type ?? "candle";
    // 레이아웃에 동기화 설정이 따로 있으면 그것이 실제로 쓰이니 그것을 보여 주고 바꾼다 (QA #8)
    const lay = cfg.grid.layouts[cfg.grid.current];
    const sync = new Proxy({}, { get: (_, k) => (lay?.sync && k in lay.sync ? lay.sync[k] : cfg.grid.sync[k]) });
    const toggleSync = (k) => () => {
      const target = lay?.sync && k in lay.sync ? lay.sync : cfg.grid.sync;
      target[k] = !target[k];
      cfg.save();
    };
    openMenu(viewBtn, [
      { header: "가격 기준" },
      { label: "수정주가", sub: "Split-adjusted", tip: "basis_split", on: () => basis() === "split", onclick: () => c.setView({ basis: "split" }) },
      { label: "배당 포함", sub: "Total Return", tip: "basis_total", on: () => basis() === "total", onclick: () => c.setView({ basis: "total" }), disabled: !daily },
      { label: "실제 거래가", sub: "Unadjusted", tip: "basis_raw", on: () => basis() === "raw", onclick: () => c.setView({ basis: "raw" }) },
      { header: "눈금" },
      { label: "일반", on: () => scale() === "normal", onclick: () => c.setView({ scale: "normal" }), keep: true },
      { label: "로그 (Alt+L)", sub: "Logarithmic", tip: "scale_log", on: () => scale() === "log", onclick: () => c.setView({ scale: "log" }), keep: true },
      { label: "%", sub: "Percentage", tip: "scale_pct", on: () => scale() === "pct", onclick: () => c.setView({ scale: "pct" }), keep: true },
      { header: "차트 종류" },
      { label: "캔들", sub: "Candlestick", tip: "candle", on: () => type() === "candle", onclick: () => c.setView({ chart_type: "candle" }) },
      { label: "Heikin Ashi", sub: "하이킨아시", tip: "heikin", on: () => type() === "heikin", onclick: () => c.setView({ chart_type: "heikin" }) },
      { label: "선", sub: "Line", tip: "line", on: () => type() === "line", onclick: () => c.setView({ chart_type: "line" }) },
      { label: "영역", sub: "Area", tip: "area", on: () => type() === "area", onclick: () => c.setView({ chart_type: "area" }) },
      { sep: true },
      {
        label: "프리·애프터 포함",
        sub: "ETH",
        tip: "ext_hours",
        on: () => !cfg.chart.regular_hours_only,
        onclick: () => {
          cfg.chart.regular_hours_only = !cfg.chart.regular_hours_only;
          cfg.save();
          app.reloadAll();
        },
      },
      {
        label: "세션 구분선",
        tip: "session_breaks",
        on: () => cfg.chart.session_breaks,
        onclick: () => {
          cfg.chart.session_breaks = !cfg.chart.session_breaks;
          cfg.save();
          app.redrawAll();
        },
        keep: true,
      },
      ...[["show_fomc", "FOMC 날짜 표시", false, "차트 아래 보라색 FOMC (미국 종목·지수)"], ["show_earn", "실적 발표일 표시", true, "차트 아래 주황색 실적 + 범례에 다음 실적일"]].map(([k, label, def, tipText]) => ({
        label,
        tipText,
        on: () => cfg.chart[k] ?? def,
        onclick: () => {
          cfg.chart[k] = !(cfg.chart[k] ?? def);
          cfg.save();
          app.redrawAll();
        },
        keep: true,
      })),
      { header: "비교 (겹쳐 보기)" },
      ...(cc.compare ?? []).map((id) => ({ label: `✕ ${describe(id).label} 빼기`, onclick: () => c.setCompare((cc.compare ?? []).filter((x) => x !== id)) })),
      {
        label: "＋ 비교 종목 넣기",
        sub: "최대 3개 · 예: SOXL에 NQ·SOXX",
        tipText: "다른 종목을 선으로 겹쳐 봐요\n아래에서 % 비교 / 가격 그대로 중에 골라요",
        disabled: (cc.compare?.length ?? 0) >= 3 || !cc.symbol,
        onclick: () => app.pickFor?.((id) => c.setCompare([...(cc.compare ?? []), id])),
      },
      // 사용자 요청 2026-10-31: "SOXX가 얼마면 SOXL이 대략 얼마" → 가격 그대로 (눈금 두 개)
      { label: "% 비교 (누가 더 올랐나)", tipText: "보이는 첫 봉을 0%로 맞춰 겹쳐요\n같은 기간에 누가 더 올랐는지 봐요 (눈금이 %로 바뀌어요)", on: () => cc.compare_mode !== "price", onclick: () => c.setCompareMode("pct"), keep: true },
      {
        label: "가격 그대로 (눈금 두 개)",
        tipText: "오른쪽 눈금 = 이 종목 가격, 왼쪽 눈금 = 첫 번째 비교 종목 가격\n마우스를 올리면 그날 실제 가격이 두 눈금에 떠요 (흰색 = 이 종목, 선 색 = 비교 종목)\n두 선은 오른쪽 끝에서 만나게 맞춰서, 회색 가로선 양 끝은 \"지금부터 SOXX가 여기 가면 SOXL은 대략 여기\" (범례에 \"SOXX 1% ≈ SOXL 몇 %\")",
        on: () => cc.compare_mode === "price",
        onclick: () => c.setCompareMode("price"),
        keep: true,
      },
      // 차트 봉 2년치 받기를 💰 창을 열지 않고도 (사용자 요청 2026-11-01, 0.13.0) — 바이낸스 종목·토스 국내 주식만, 나머지는 왜 안 되는지 알림
      { header: "과거 봉" },
      {
        label: "📥 이 종목 차트 봉 2년치 받기",
        sub: "5분·15분·30분·1시간·4시간",
        tipText: "바이낸스 종목·국내 주식(토스 키)은 2년씩 더 받아요 (누를 때마다 2년 더)\n미국 주식(알파카)은 처음 열 때 2016년부터 저절로 받아요",
        disabled: !cc.symbol,
        onclick: () => app.downloadChart?.(c.info),
      },
      { header: "분할 화면 동기화" },
      { label: "봉 (모든 칸 같이)", on: () => sync.interval, onclick: toggleSync("interval"), keep: true, tipText: "켜면: 한 칸의 봉을 바꾸면 모든 칸이 같은 봉\n끄면(기본): 선택한 칸만 바뀌어요" },
      { label: "줌·이동 (같은 종목끼리)", on: () => sync.time, onclick: toggleSync("time"), keep: true, tipText: "켜면: 한 칸을 줌·이동하면 같은 종목 칸(예: SOXL 1분·5분)도 같은 기간으로\n끄면(기본): 칸마다 따로" },
      { label: "십자선", on: () => sync.crosshair, onclick: toggleSync("crosshair"), keep: true, tipText: "한 칸에 마우스를 올리면 다른 칸에도 같은 시각에 십자선" },
      { label: "지표", on: () => sync.indicators, onclick: toggleSync("indicators"), keep: true, tipText: "지표를 바꾸면 모든 칸에" },
      { label: "종목", on: () => sync.symbol, onclick: toggleSync("symbol"), keep: true, tipText: "모든 칸이 같은 종목 (봉만 다르게: SOXL 1분·5분·15분·1시간)" },
      { sep: true },
      { label: "📷 캡처 · 이 칸", onclick: () => app.capture(false) },
      { label: "📷 캡처 · 화면 전체", onclick: () => app.capture(true), disabled: app.grid.cells.length < 2 },
      { label: "▶ 바 리플레이", sub: "Bar Replay", tip: "replay", onclick: () => app.startReplay() },
      { sep: true },
      { label: "관심종목 보이기 (Tab)", on: () => cfg.layout.sidebar_visible, onclick: () => app.setSidebar(!cfg.layout.sidebar_visible), keep: true },
    ]);
  }

  return { paint, setMode, measureBtn, drawBtn, tradeBtn, openGoto: () => openGoto({ grid: app.grid, toast: app.toast }) };
}
