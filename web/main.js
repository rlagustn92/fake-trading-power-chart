// 시작: 설정 → 종목 목록 → 데이터 관리자 → 화면(툴바·관심종목·분할 차트·상태줄) → 이어 받기
import { loadConfig } from "./config.js";
import { invoke, inTauri, logInfo, toggleFullscreen, setZoom, showVersionInTitle } from "./platform.js";
import * as A from "./sources/alpaca.js";
import * as TS from "./sources/toss.js";
import { reconnectAll } from "./sources/reconnect.js";
import { getStockList, marketOf } from "./core/stocklist.js";
import { createData, TF_NAME } from "./core/data.js";
import { createEstimator } from "./core/estimate.js";
import { TIMEFRAMES, TF_SEC } from "./core/bars.js";
import { createGrid } from "./ui/grid.js";
import { createToolbar } from "./ui/toolbar.js";
import { createSidebar } from "./ui/sidebar.js";
import { createStatusbar } from "./ui/statusbar.js";
import { createPicker } from "./ui/picker.js";
import { createIndicatorPanel } from "./ui/indpanel.js";
import { createSettings } from "./ui/settings.js";
import { setupTips, hideTip } from "./ui/tip.js";
import { closeMenu, openMenu } from "./ui/menu.js";
import { createDrawbar } from "./ui/drawbar.js";
import { createReplay } from "./ui/replay.js";
import { createUpdater } from "./ui/update.js";
import { createAlertPanel } from "./ui/alerts.js";
import { createAlerts, alertText, IND_NAME } from "./alerts/engine.js";
import { loadDrawings } from "./drawings/store.js";
import { toast, ask, confirmBox } from "./ui/dialog.js";
import { parseCsv, guessSymbol } from "./core/csv.js";
import * as db from "./core/db.js";
import { ymd } from "./core/tz.js";
import { startEventAlerts } from "./core/events.js";
import { maybeWelcome } from "./ui/welcome.js";
import { normalizeInput, describe, preferLive } from "./core/symbols.js";
import { createTrading } from "./trade/panel.js";
import { canBackfill, canToss, ensureMinutes, fetchOlder, probeToss, reachBack } from "./trade/history.js";
import { baseTf } from "./core/intraday.js";
import { setCandleStyle } from "./core/colors.js";

const $ = (s) => document.querySelector(s);
const t0 = performance.now();

setupTips();
const cfg = await loadConfig();
cfg.watchlist = [...new Set(cfg.watchlist.map(preferLive))]; // 예전에 넣은 BTC-USD → Binance 실시간
setZoom(cfg.font.scale);
setCandleStyle(cfg.chart.candle_style); // 봉 색 한국식(기본)·미국식 — 차트를 그리기 전에 (0.13.0)
await Promise.all([A.keyStatus(), getStockList(cfg.data.stock_list), loadDrawings()]);
const data = createData(cfg);
const estimator = createEstimator({ cfg, data }); // 장이 닫힌 시간 24시간 추정가

// 🔔 알림 (앱이 켜져 있는 동안 계속 확인)
const alerts = createAlerts({
  cfg,
  data,
  onFire: (a, text) => {
    // 알림을 누르면 그 종목·그 봉 차트로
    toast(`🔔 ${text}`, 15000, {
      label: "차트 보기",
      onclick: () => {
        if (mode !== "chart") setMode("chart");
        grid.setSymbol(a.sym);
        if (grid.current && grid.current.tf !== a.tf) grid.current.setTimeframe(a.tf);
      },
    });
    alertPanel?.render();
  },
  onChange: () => {
    grid?.cells.forEach((c) => c.paintHead());
    if (alertPanel?.isOpen) alertPanel.render();
    updateWatch();
  },
});

let mode = "chart";
let backtest = null;
let trading = null; // 💰 모의매매 (아래에서 만든다)
const oldestShown = new Set(); // "여기부터가 전부" 알림을 띄운 종목 (바이낸스) · 종목|봉 (야후)
const YAHOO_KEEP = { "1m": "최근 30일", "5m": "최근 60일", "1h": "최근 2년" }; // 야후가 주는 국내 분봉 기간 (core/intraday.js Y_TF)

/**
 * 모의매매: 리플레이를 시각 t에서 이어 가기 전에 그 봉을 준비한다 (0.8.1)
 * - 리플레이 중에 처음 보는 봉으로 바꿈(15분 → 4시간) → 저장된 게 없으면 먼저 받는다
 * - Binance는 그 시각 앞 300봉까지 이어서 뒤로 받는다 (분할 화면의 다른 칸·다른 종목이 같이 갈 때도)
 */
const prepping = new Map(); // 종목|봉 → 받는 중 (미리 받기와 봉 바꾸기가 겹쳐도 한 번만)
async function needsPrep(info, tf, t) {
  if (!info || tf === "1D" || tf === "1W") return false;
  const r = await db.range(info.id, baseTf(info, tf) ?? tf);
  return !r || !!(canBackfill(info) && TF_SEC[tf] && r.first > t - 300 * TF_SEC[tf]);
}
function beforeReplayLoad(info, tf, t) {
  const key = `${info?.id}|${baseTf(info, tf) ?? tf}`;
  if (prepping.has(key)) return prepping.get(key);
  const p = (async () => {
    if (!(await needsPrep(info, tf, t))) return;
    const j = data.job(`받는 중 ${info.label} ${TF_NAME[tf]}봉 (리플레이 시각까지)`);
    try {
      if (!(await db.range(info.id, baseTf(info, tf) ?? tf))) await data.ensure(info, tf, { front: true });
      if (canBackfill(info)) await reachBack(info, tf, t);
    } finally {
      j.done();
    }
  })().finally(() => prepping.delete(key));
  prepping.set(key, p);
  return p;
}

/**
 * 리플레이를 시작하면 매매하는 종목의 다른 봉(5분·15분·1시간·4시간)도 그 시각까지 뒤에서 미리 받아 둔다 (0.8.2 사용자 요청:
 * "모의매매하러 들어가면 4시간봉 같은 게 없을 때 받아서 하자고 알림"). 묻지 않고 받고 알림만 → 봉을 바꿀 때 기다리지 않는다
 */
async function prefetchTfs(cell, t) {
  const info = cell?.info;
  if (!info?.tfs || cell.tf === "1D" || cell.tf === "1W") return;
  const need = [];
  const seen = new Set([baseTf(info, cell.tf) ?? cell.tf]);
  for (const tf of ["5m", "15m", "30m", "1h", "4h"]) {
    const base = baseTf(info, tf) ?? tf;
    if (!info.tfs.includes(tf) || seen.has(base)) continue; // 15분·4시간이 5분·1시간으로 만들어지는 종목은 한 번만
    seen.add(base);
    if (await needsPrep(info, tf, t).catch(() => false)) need.push(tf);
  }
  if (!need.length) return;
  toast(`${info.label.replace(/ 24h$/, "")} ${need.map((tf) => TF_NAME[tf]).join("·")}봉도 그 시각까지 뒤에서 받아 둘게요\n리플레이 중에 봉을 바꿔도 바로 이어져요`, 5000);
  for (const tf of need) await beforeReplayLoad(info, tf, t).catch(() => {});
}

/**
 * 모의매매가 끝나 버리는 일을 하기 전에 묻는다 (0.13.0, 사용자: "모르고 해버리면 … 다 깨져요 경고등 넣는 건 어때?").
 * 매매하는 칸(리플레이·📡 실시간)이 cells 안에 있고(null = 칸과 상관없이), 들고 있는 포지션이나 깔아 둔 대기선이 있을 때만 묻는다.
 * 반환 true = 바로 해도 됨, false = 물어봤고 "그래도 할게요"를 누르면 proceed()
 */
function guardTrading(cells, what, proceed) {
  const s = trading?.stake;
  if (!s || !(s.holding || s.pending) || (cells && !cells.includes(s.cell))) return true;
  const text = [`${what} 지금 ${s.live ? "📡 실시간 모의매매" : "리플레이"}가 끝나요.`];
  if (s.holding) text.push(`들고 있는 ${s.holding}은 지금 가격으로 정리돼서 일지에 남아요.`);
  if (s.pending) text.push("깔아 둔 대기선은 없어져요.");
  confirmBox("⚠ 모의매매 중이에요", text.join(" "), { ok: "그래도 할게요", danger: true }).then((ok) => ok && proceed());
  return false;
}

/**
 * 5분·15분봉을 뒤로 당겨 더 받으면 (한 번에 4,500봉 = 5분봉 약 15일) 2년치를 한 번에 받는 버튼을 한 번 알린다
 * (사용자 요청 2026-10-30: "계속 차트 뒤로 땡기고 땡기고 받는데" → 💰 "📥 2년치 받기"). 종목마다 켤 때 한 번
 */
const pullTipShown = new Set();
function pullTip(info, tf) {
  if (pullTipShown.has(info.id) || !trading || trading.downloading) return;
  pullTipShown.add(info.id);
  const days = Math.round((4500 * TF_SEC[tf]) / 86400);
  toast(`${info.label.replace(/ 24h$/, "")} ${TF_NAME[tf]}봉은 뒤로 당길 때마다 약 ${days}일씩 받아요\n한 번에 2년치를 받을 수도 있어요 (5분·15분·30분·1시간·4시간봉, 약 2~3분)`, 12000, { label: "📥 2년치 받기", onclick: () => trading?.downloadChart(info) });
}

// ── 화면 ──
const grid = createGrid($("#grid"), {
  cfg,
  data,
  hasAlpaca: A.hasKey,
  hasToss: () => TS.hasKey() && !TS.isStandby(),
  estimator,
  onIndicatorClick: (cell, inst) => {
    grid.select(grid.cells.indexOf(cell));
    indpanel.open(inst.uid);
  },
  onPicksChange: () => toolbar?.paint(),
  onPickFor: () => openPicker(),
  toast,
  onSelectChange: () => {
    toolbar?.paint();
    drawbar?.paint();
    sidebar?.markCurrent();
    trading?.paintData();
    const c = grid.current;
    if (c) status?.setMode(["1D", "1W"].includes(c.tf), c.cc.range);
  },
  onCellsChange: () => {
    replay?.checkCells();
    toolbar?.paint();
    sidebar?.markCurrent();
    updateWatch();
    trading?.paintData();
    const c = grid.current;
    if (c) status?.setMode(["1D", "1W"].includes(c.tf), c.cc.range);
  },
  onMeasure: () => toolbar?.paint(),
  onReplayReset: (cell) => replay?.onCellReset(cell),
  onMain: (cell) => trading?.onMain(cell),
  onReplayStart: (cell) => (trading?.onReplayStart(cell), replay?.refresh()),
  beforeReplayLoad,
  followReplay: (cell) => !!replay?.follows(cell),
  joinReplay: (cell) => !!replay?.join(cell), // 칸을 늘리면 새 칸도 같은 리플레이 시각으로 (0.13.0)
  guard: (cells, what, proceed) => guardTrading(cells, what, proceed),
  // 리플레이가 저장된 1분봉의 빈 곳에 닿았다 → Binance에서 그 사이 1분봉을 받는다 (0.11.1, 옛날 구간은 시작 앞뒤만 받아 둠)
  fillMinutes: async (info, from, to) => {
    if (!canBackfill(info)) return 0;
    const j = data.job(`받는 중 ${info.label} 1분봉 (리플레이)`);
    try {
      return await ensureMinutes(info, from, to);
    } finally {
      j.done();
    }
  },
  // 모의매매: 차트를 왼쪽 끝까지 밀었는데 저장된 봉이 끝났으면 Binance에서 그 앞을 더 받아 온다
  fetchOlder: async (info, tf) => {
    if (!canBackfill(info)) return 0;
    const j = data.job(`받는 중 ${info.label} ${TF_NAME[tf]}봉 더 옛날`);
    try {
      const n = await fetchOlder(info, tf);
      if (n) trading?.paintData(); // 💰 "차트 봉 ○○부터"를 새로
      if (n && (tf === "5m" || tf === "15m")) pullTip(info, tf);
      return n;
    } finally {
      j.done();
    }
  },
  // 왼쪽 끝 = 받을 수 있는 가장 옛날 → 왜 거기서 끝나는지 한 번 알린다 (받기가 안 되는 줄 알고 헷갈리지 않게)
  // - Binance: 상장일 (예: 삼성전자 무기한선물 2026-06-02) · 종목마다 한 번
  // - Yahoo 국내 분봉: 1시간봉 2년·5분봉 60일·1분봉 30일까지만 준다 (삼성전자 4시간봉이 2024-11부터) · 종목·봉마다 한 번
  onOldest: (cell, firstT) => {
    const info = cell.info;
    const name = info.label.replace(/ 24h$/, "");
    if (canBackfill(info)) {
      if (oldestShown.has(info.id)) return;
      oldestShown.add(info.id);
      toast(`${name}: 바이낸스에 ${ymd(firstT)}부터 있어요 (상장일)\n그보다 옛날 봉은 없어요`, 6000);
    } else if (info.intraday === "yahoo" && YAHOO_KEEP[baseTf(info, cell.tf)]) {
      const key = `${info.id}|${cell.tf}`;
      if (oldestShown.has(key)) return;
      oldestShown.add(key);
      const base = baseTf(info, cell.tf);
      const made = base !== cell.tf ? ` (${TF_NAME[cell.tf]}봉은 ${TF_NAME[base]}봉을 묶어 만들어요)` : "";
      // 국내 주식 + 토스 키 → 토스에서 2년씩 받는 버튼 (토스 1분봉은 약 4년 전까지: 2026-10-30 확인, 삼성전자 2022-11)
      if (canToss(info)) toast(`${name} ${TF_NAME[cell.tf]}봉: ${ymd(firstT)}부터 있어요 (야후는 ${TF_NAME[base]}봉을 ${YAHOO_KEEP[base]}치만 줘요)\n토스에서 2년치씩 받으면 더 뒤로 보여요 (약 3~5분)`, 12000, { label: "📥 토스로 2년 받기", onclick: () => trading?.downloadChart(info) });
      else toast(`${name} ${TF_NAME[cell.tf]}봉: ${ymd(firstT)}부터 있어요\n무료 데이터(야후)가 ${TF_NAME[base]}봉은 ${YAHOO_KEEP[base]}치만 줘요${made}\n켤 때마다 이어서 쌓여요 · 더 옛날은 일봉·주봉으로 보세요`, 9000);
    }
  },
  onDrawTool: () => drawbar?.paint(),
  toast,
  alertCount: (sym) => alerts.countFor(sym),
  /** 그린 선 → 알림 (가격이 이 선을 넘으면) */
  onDrawingAlert: (cell, dw) => {
    const a = alerts.add({ sym: cell.cc.symbol, tf: cell.tf, kind: "line", drawingId: dw.id, op: "cross", log: cell.drawView().log });
    toast(`🔔 알림을 만들었어요 · ${alertText(a)}
🔔 목록에서 실시간·매번으로 바꿀 수 있어요`, 6000);
  },
  /** 범례의 지표 이름을 오른쪽 클릭 → 알림 만들기 */
  onIndicatorMenu: (cell, inst, e) => {
    const add = (a) => {
      const al = alerts.add({ sym: cell.cc.symbol, tf: cell.tf, ...a });
      toast(`🔔 알림을 만들었어요 · ${alertText(al)}`, 6000);
    };
    const items = [];
    // 기준 봉이 차트보다 작으면 그 선은 숨겨져 있다 (0.16.0) → 알림도 만들지 않는다
    const lowerTf = !!inst.params?.tf && TF_SEC[inst.params.tf] < TF_SEC[cell.tf];
    if (IND_NAME[inst.id] && !lowerTf) {
      const htf = inst.params.tf && inst.params.tf !== cell.tf ? inst.params.tf : undefined;
      const src = inst.params.src && inst.params.src !== "c" ? inst.params.src : null; // 소스가 고가·저가…면 알림도 그 선으로 (0.14.0)
      const ind = { id: inst.id, params: { length: inst.params.length, ...(src ? { src } : {}), ...(htf ? { tf: htf } : {}) } };
      const srcName = src ? ` ${{ o: "시가", h: "고가", l: "저가", hl2: "(고+저)/2", hlc3: "(고+저+종)/3", ohlc4: "(시+고+저+종)/4" }[src] ?? src}` : "";
      const name = inst.id === "vwap" ? "VWAP" : `${IND_NAME[inst.id]} ${inst.params.length}${srcName}${htf ? ` (${TF_NAME[htf]}봉)` : ""}`;
      items.push({ label: `🔔 가격이 ${name} 위로 뚫으면 알림`, onclick: () => add({ kind: "ind", op: "up", ind }) });
      items.push({ label: `🔔 가격이 ${name} 아래로 뚫으면 알림`, onclick: () => add({ kind: "ind", op: "down", ind }) });
    }
    if ((inst.id === "bb" || inst.id === "vwbb") && !lowerTf) {
      // 위 밴드를 뚫고 올라가면 / 아래 밴드를 깨고 내려가면 (가운데 굵은 띠 = 배수 σ)
      const htf = inst.params.tf && inst.params.tf !== cell.tf ? inst.params.tf : undefined;
      const params = { length: inst.params.length, mult: inst.params.mult, ...(inst.params.tvLower ? { tvLower: true } : {}), ...(htf ? { tf: htf } : {}) };
      const name = `${inst.id === "vwbb" ? "VWBB" : "BB"} ${inst.params.length}${htf ? ` (${TF_NAME[htf]}봉)` : ""}`;
      items.push({ label: `🔔 가격이 ${name} 위 밴드(${inst.params.mult}σ)를 뚫으면 알림`, onclick: () => add({ kind: "ind", op: "up", ind: { id: `${inst.id}_up`, params } }) });
      items.push({ label: `🔔 가격이 ${name} 아래 밴드(${inst.params.mult}σ)를 깨면 알림`, onclick: () => add({ kind: "ind", op: "down", ind: { id: `${inst.id}_dn`, params } }) });
    }
    if (inst.id === "orb") {
      const m = inst.params.minutes ?? 15;
      items.push({ label: `🔔 가격이 ORH(장 시작 ${m}분 고가) 위로 뚫으면 알림`, onclick: () => add({ kind: "ind", op: "up", ind: { id: "orbh", params: { minutes: m } } }) });
      items.push({ label: `🔔 가격이 ORL(장 시작 ${m}분 저가) 아래로 깨면 알림`, onclick: () => add({ kind: "ind", op: "down", ind: { id: "orbl", params: { minutes: m } } }) });
    }
    if (inst.id === "rsi") {
      const ind = { id: "rsi", length: inst.params.length };
      items.push({ label: `🔔 RSI가 ${inst.params.lo} 아래로 가면 알림`, onclick: () => add({ kind: "rsi", op: "down", value: inst.params.lo, ind }) });
      items.push({ label: `🔔 RSI가 ${inst.params.hi} 위로 가면 알림`, onclick: () => add({ kind: "rsi", op: "up", value: inst.params.hi, ind }) });
    }
    items.push({ label: "⚙ 이 지표 설정", onclick: () => (grid.select(grid.cells.indexOf(cell)), indpanel.open(inst.uid)) });
    openMenu(null, items, { x: e.clientX, y: e.clientY });
  },
  onCellMenu: (cell, e) => {
    const items =
      grid.shownCells().length > 1
        ? [
            { label: "📋 화면 전체 복사", onclick: () => copyImage() },
            { label: "📋 이 칸만 복사", onclick: () => copyImage(cell) },
          ]
        : [{ label: "📋 차트 이미지 복사", onclick: () => copyImage(cell) }];
    openMenu(null, items, { x: e.clientX, y: e.clientY });
  },
});

let pickCb = null; // 백테스트 화면에서 고를 때는 그쪽으로
const picker = createPicker($("#picker"), {
  onTf: (tf) => (mode !== "chart" && setMode("chart"), grid.setTimeframe(tf)),
  onPick: (id) => {
    if (pickCb) {
      const cb = pickCb;
      pickCb = null;
      return cb(id);
    }
    if (mode !== "chart") setMode("chart");
    grid.setSymbol(id);
  },
  onAdd: (id) => addWatch(id),
  perpOf: (id) => estimator.mappingOf(id),
  // 무기한선물 → 한글 이름 (SAMSUNGUSDT → 삼성전자): 설정의 짝 목록에서
  perpNames: () => new Map(Object.entries(cfg.perp?.map ?? {}).filter(([, m]) => m.symbol).map(([id, m]) => [`${m.source === "binance" ? "bn" : "hl"}:${m.symbol}`, describe(id).label])),
  isWatched: (id) => cfg.watchlist.includes(id),
});

function addWatch(id) {
  if (cfg.watchlist.includes(id)) return;
  cfg.watchlist.push(id);
  cfg.save();
  sidebar.build();
  updateWatch();
  data.ensure(describe(id), "1D");
}

function openPicker(text = "") {
  pickCb = null;
  picker.open(text);
}

const sidebar = createSidebar($("#sidebar"), {
  cfg,
  data,
  estimator,
  onPick: (id) => {
    if (mode !== "chart") setMode("chart");
    grid.setSymbol(id);
  },
  onAdd: () => openPicker(),
  onChange: updateWatch,
  onCollapse: () => setSidebar(false),
  current: () => grid.current?.cc.symbol,
});

const status = createStatusbar($("#status"), {
  data,
  onRange: (k) => grid.current?.setRange(k),
  onRefresh: () => {
    toast("빠진 부분을 이어 받는 중이에요");
    data.catchUpAll([...cfg.watchlist, ...grid.symbols()]).then(() => grid.cells.forEach((c) => c.reload()));
  },
});

const indpanel = createIndicatorPanel($("#indpanel"), {
  cfg,
  getCell: () => grid.current,
  apply: (list) => grid.setIndicators(list),
});

// 🆕 새 버전 받기 (0.15.0): 켜고 20초 뒤 한 번 + 켜 둔 동안 12시간마다 GitHub Releases 확인 → 있으면 알림 → 받고 다시 켜기
const updater = createUpdater({ cfg, beforeRestart: () => cfg.saveNow() });
setTimeout(() => updater.check(false), 20000);
setInterval(() => updater.check(false), 12 * 3600e3);

const settings = createSettings($("#settings"), {
  cfg,
  checkUpdate: () => updater.check(true),
  showWelcome: () => maybeWelcome(welcomeApp, true),
  repaintWatch: () => sidebar.paintAll(),
  data,
  setFontScale,
  setSidebar,
  toggleFullscreen,
  redrawAll: () => grid.cells.forEach((c) => c.redraw()),
  // 봉 색 한국식·미국식 (0.13.0): CSS 변수 → 차트 다시 그리기 → 💰 선·일지
  setCandleStyle: (v) => {
    setCandleStyle(v);
    grid.cells.forEach((c) => c.redraw());
    trading?.repaint();
  },
  onPerpToggle: () => updateWatch(),
  onAlpacaKey: () => {
    data.restartStream();
    grid.cells.forEach((c) => c.reload());
    data.catchUpAll(cfg.watchlist);
  },
});

const toolbar = createToolbar($("#toolbar"), {
  cfg,
  grid,
  pickFor: (cb) => pickerFor(cb),
  drawbarPaint: () => drawbar?.paint(),
  toast,
  setMode,
  openPicker: () => openPicker(),
  openIndicators: () => indpanel.open(),
  openSettings: () => settings.open(),
  openAlerts: () => alertPanel.open(),
  toggleDrawBar: () => drawbar.toggle(),
  startReplay: () => (mode !== "chart" && setMode("chart"), replay.start()),
  toggleTrade: () => (mode !== "chart" && setMode("chart"), trading?.toggle()),
  downloadChart: (info) => trading?.downloadChart(info), // 보기 ▾ "📥 2년치 받기" (💰 창이 열리며 진행을 보여 준다)
  toggleFullscreen,
  setSidebar,
  capture,
  reloadAll: () => grid.cells.forEach((c) => c.reload()),
  redrawAll: () => grid.cells.forEach((c) => c.redraw()),
});

const drawbar = createDrawbar($("#drawbar"), { cfg, grid, onToggle: (on) => toolbar.drawBtn.classList.toggle("on", on) });
toolbar.drawBtn.classList.toggle("on", drawbar.visible);

const replay = createReplay($("#replaybar"), {
  cfg,
  grid,
  gridBox: $("#grid"),
  toast,
  // 시작 전: 매매하는 칸의 1분봉 + 같이 가는 다른 칸(분할 화면)의 그 시각 봉
  onPrepare: async (cell, t, cells) => {
    const slow = setTimeout(() => toast("그때 봉을 받는 중… (처음이면 몇 초 걸려요)", 4000), 1200);
    try {
      await trading?.prepare(cell, t);
      for (const c of cells) if (c !== cell && c.cc.symbol) await beforeReplayLoad(c.info, c.tf, t).catch(() => {});
    } finally {
      clearTimeout(slow);
    }
  },
  onBegin: (cell, t) => (trading?.onBegin(cell, t), prefetchTfs(cell, t)),
  onStep: (cell, t, prev) => trading?.onStep(cell, t, prev),
  onStop: (cell, t) => trading?.onStop(cell, t),
  confirmEnd: (what, proceed) => guardTrading(null, what, proceed), // 🎲·📍 새로 시작, ✕ 끝내기·Esc (0.13.0)
});

trading = await createTrading($("#trade"), { cfg, grid, replay, toast, journalRoot: $("#journal"), onToggle: (on) => toolbar.tradeBtn.classList.toggle("on", on) });

const alertPanel = createAlertPanel($("#alerts"), {
  cfg,
  alerts,
  getCell: () => grid.current,
  pickSymbol: (cb) => {
    alertPanel.close();
    pickerFor((id) => {
      cb(id);
      alertPanel.open({ keepForm: true });
    });
  },
});

function setSidebar(on) {
  cfg.layout.sidebar_visible = on;
  cfg.save();
  document.body.classList.toggle("no-sidebar", !on);
  toolbar?.paint();
}

function setFontScale(v) {
  cfg.font.scale = Math.round(Math.min(2, Math.max(0.5, v)) * 20) / 20;
  cfg.save();
  setZoom(cfg.font.scale);
}

async function setMode(m) {
  mode = m;
  $("#charts").hidden = m !== "chart";
  $("#backtest").hidden = m !== "backtest";
  document.body.classList.toggle("mode-backtest", m === "backtest"); // 백테스트 화면에서는 💰 모의매매 창을 숨긴다
  toolbar.setMode(m);
  $("#drawbar").hidden = m !== "chart" || !cfg.layout.drawbar_visible; // 백테스트 화면에는 그리기 막대가 필요 없다
  if (m === "backtest") {
    if (!backtest) {
      const { createBacktest } = await import("./backtest/view.js");
      backtest = createBacktest($("#backtest"), {
        cfg,
        data,
        openPicker: (cb) => pickerFor(cb),
        showOnChart: (id, days) => {
          setMode("chart");
          const c = grid.current;
          if (c.cc.symbol !== id) c.setSymbol(id);
          if (c.tf !== "1D") c.setTimeframe("1D");
          c.setExtraMarkers(id, days);
          toast("초록 점 = 백테스트에서 산 날", 5000);
        },
      });
    }
    backtest.show();
  }
}

/** 백테스트 화면에서 종목 고르기 */
function pickerFor(cb) {
  picker.open();
  pickCb = cb;
}

/** 📷 캡처: PNG를 사진\FAKE TRADING POWER CHART에 저장 + 클립보드에 복사 (SPEC §3.9) */
async function capture(all) {
  try {
    const canvas = await grid.screenshot(all);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    const c = grid.current;
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const name = `${all ? "split" : c.info.label.replace(/[^A-Za-z0-9_.-]/g, "_")}_${all ? grid.cells.length : c.tf}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let where = "";
    try {
      where = await invoke("save_capture", bytes, { headers: { name } });
    } catch (e) {
      console.warn("캡처 저장 실패", e);
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast(`📷 캡처했어요 · 클립보드에 복사됨${where ? `\n${where}` : ""}`);
    } catch {
      toast(`📷 캡처했어요${where ? ` · ${where}` : ""}`);
    }
  } catch (e) {
    toast(`캡처하지 못했어요 (${e.message ?? e})`);
  }
}

/** 📋 오른쪽 클릭 복사 (0.18.0): 파일로 남기지 않고 클립보드에만 → 카톡 등에 바로 붙여 넣기. cell 없으면 보이는 칸 전부 */
async function copyImage(cell) {
  try {
    const canvas = grid.snapshot(cell);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("📋 복사했어요 · 카톡 등에 Ctrl+V로 붙여 넣으세요");
  } catch (e) {
    logInfo(`[copy] 실패 ${e?.message ?? e}`); // 이유는 영어라 기록에만
    toast("복사하지 못했어요 · 앱 창을 한 번 누르고 다시 해 보세요");
  }
}

/** 현재가를 받을 종목 = 관심종목 + 화면에 보이는 칸 */
function updateWatch() {
  data.setWatch([...new Set([...cfg.watchlist, ...grid.symbols(), ...(cfg.alerts ?? []).filter((a) => a.on).map((a) => a.sym)])]);
  estimator.setTargets([...new Set([...cfg.watchlist, ...grid.symbols()])]);
}

// ── 시작 ──
setSidebar(cfg.layout.sidebar_visible);
grid.build();
drawbar.paint();
updateWatch();
$("#boot").hidden = true;
logInfo(`ui ready ${Math.round(performance.now() - t0)}ms`);
showVersionInTitle();

if (cfg.data.auto_update) {
  setTimeout(() => data.catchUpAll([...cfg.watchlist, ...grid.symbols()]), 1200);
}

// 모의매매: 토스가 국내 1분봉을 얼마나 옛날까지 주는지 한 번만 확인 (사용자 요청 2026-10-30, 요청 약 20번)
// → 기록(app.log)과 알림. 받아 쌓을지는 결과를 보고 정한다. 실패하면(대기·인터넷) 다음에 켤 때 다시
setTimeout(async () => {
  try {
    await TS.keyStatus();
    if (!TS.hasKey() || TS.isStandby() || (await db.metaGet("toss|probe_1m"))) return;
    const r = await probeToss({ id: "005930.KS" });
    await db.metaSet("toss|probe_1m", Math.floor(Date.now() / 1000));
    const months = r.oldest == null ? 0 : Math.round((Date.now() / 1000 - r.oldest) / (30.4 * 86400));
    const when = months >= 24 ? `약 ${Math.round(months / 12)}년` : `약 ${months}개월`;
    toast(r.oldest == null ? "토스 1분봉 확인: 옛날 1분봉은 주지 않아요" : `토스 1분봉 확인: 삼성전자 ${ymd(r.oldest)}쯤부터 있어요 (${r.beyond ? "10년 넘게" : when})`, 12000);
  } catch (e) {
    logInfo(`[trade] 토스 1분봉 깊이 확인 못 함: ${e?.message ?? e}`);
  }
}, 15000);

data.on("need-key", () => toast("미국 주식 분봉은 알파카 키가 있어야 받을 수 있어요 · ⚙ 설정 → 데이터", 6000));

// 절전에서 깨어나면 연결을 다시 맺고 빠진 부분을 받는다
let lastBeat = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - lastBeat > 30e3) {
    reconnectAll();
    data.catchUpAll([...cfg.watchlist, ...grid.symbols()]);
  }
  lastBeat = now;
}, 10e3);
addEventListener("online", () => {
  reconnectAll();
  data.catchUpAll([...cfg.watchlist, ...grid.symbols()]);
});

// 설정 저장이 실패하면 알린다 (모르고 쓰다가 바꾼 게 사라지지 않게)
addEventListener("pc:save", (e) => {
  if (e.detail.name === "config.json" && !e.detail.ok) toast("⚠ 설정 저장 실패 · 바꾼 내용이 다음 실행 때 사라질 수 있어요", 6000);
});

// ── 키보드 (SPEC §3.1, §3.9) ──
const overlays = () => [picker, indpanel, settings, alertPanel, trading?.journal].filter((o) => o?.isOpen);
const DRAW_KEYS = { t: "trend", i: "info", h: "hline", j: "hray", f: "fib", g: "triangle", a: "avwap", b: "brush", x: "text" };
// ── CSV 가져오기 (SPEC §2.7): 일봉 CSV 파일을 창에 끌어다 놓으면 그 종목 일봉으로 저장 (Yahoo가 막혀도 차트·백테스트) ──
addEventListener("dragover", (e) => {
  if ([...(e.dataTransfer?.types ?? [])].includes("Files")) e.preventDefault();
});
addEventListener("drop", async (e) => {
  const f = [...(e.dataTransfer?.files ?? [])].find((x) => /\.csv$/i.test(x.name));
  if (!f) return;
  e.preventDefault();
  try {
    const { rows, skipped } = parseCsv(await f.text());
    const sym = await ask(`${f.name} · 일봉 ${rows.length}개 (${ymd(rows[0].t)} ~ ${ymd(rows[rows.length - 1].t)}) — 어느 종목으로 넣을까요?`, { value: guessSymbol(f.name), placeholder: "예: QQQ, 005930", ok: "넣기" });
    if (!sym) return;
    const id = normalizeInput(sym, marketOf);
    await db.putBars(id, "1D", rows);
    await db.metaSet(`${id}|csv`, { file: f.name, n: rows.length, at: Date.now() });
    toast(`${describe(id).label} 일봉 ${rows.length}개를 넣었어요${skipped ? ` (못 읽은 줄 ${skipped}개)` : ""}`, 6000);
    if (mode !== "chart") setMode("chart");
    grid.setSymbol(id);
    if (grid.current && grid.current.tf !== "1D") grid.current.setTimeframe("1D");
  } catch (err) {
    toast(`CSV를 읽지 못했어요 · ${err.message ?? err}`, 6000);
  }
});

addEventListener("keydown", (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g" && mode === "chart") {
    e.preventDefault();
    toolbar.openGoto();
    return;
  }
  if (e.key === "Escape") {
    hideTip();
    if (closeMenu()) return; // 메뉴만 닫는다 (크게 본 칸은 그대로)
    if (overlays().length) {
      for (const o of overlays()) o.close();
      return;
    }
    const c = grid.current;
    if (grid.cells.some((x) => x.drawings.cancel())) return;
    if (replay.active) return replay.requestStop(); // 들고 있으면 먼저 묻는다 (0.13.0)
    if (c?.measure.on) c.measure.toggle(false);
    else if (grid.maximized) grid.toggleMaximize();
    return;
  }
  // 그리기 단축키 (TradingView와 비슷하게): Alt+T 추세선, Alt+H 수평선, Alt+J 수평 반직선, Alt+F 피보나치…
  if (e.altKey && !e.ctrlKey && mode === "chart" && !typing && !overlays().length && DRAW_KEYS[e.key.toLowerCase()]) {
    e.preventDefault();
    if (!drawbar.visible) drawbar.toggle(true);
    drawbar.pick(DRAW_KEYS[e.key.toLowerCase()]);
    return;
  }
  // 💰 모의매매 창이 열려 있으면: B 매수 · S 매도 · X 종료 (글자를 치면 종목 찾기가 열리는 것보다 먼저)
  if (!typing && !overlays().length && mode === "chart" && trading?.handleKey(e)) return;
  // 리플레이 중: Space = 재생/멈춤, → = 보는 봉 하나 (1시간봉이면 1시간), Shift+→ = 1분 (0.14.1)
  if (replay.active && !typing && !overlays().length && mode === "chart" && (e.key === " " || e.key === "ArrowRight")) {
    e.preventDefault();
    if (e.key === " ") replay.toggle();
    else {
      replay.pause();
      if (e.shiftKey) replay.step();
      else replay.stepBar();
    }
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && !typing && !overlays().length && mode === "chart") {
    if (grid.current?.drawings.deleteSelected()) {
      e.preventDefault();
      return;
    }
  }
  if (e.ctrlKey && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    setFontScale(cfg.font.scale + 0.05);
    return;
  }
  if (e.ctrlKey && e.key === "-") {
    e.preventDefault();
    setFontScale(cfg.font.scale - 0.05);
    return;
  }
  if (e.ctrlKey && e.key === "0") {
    e.preventDefault();
    setFontScale(1);
    return;
  }
  if (e.key === "F11") {
    e.preventDefault();
    toggleFullscreen();
    return;
  }
  // 바로 바꾸기: 한 글자 단축키는 종목 찾기(SOXL·MU·247540…)와 겹쳐서 Alt·Ctrl 조합으로 (QA #1)
  if (!typing && !overlays().length) {
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const c0 = grid.current;
    if (e.altKey && !ctrl && /^[1-8]$/.test(e.key) && mode === "chart") {
      e.preventDefault();
      return grid.setTimeframe(TIMEFRAMES[+e.key - 1]);
    }
    if (e.altKey && !ctrl && k === "m" && mode === "chart") {
      e.preventDefault();
      c0?.toggleMeasure();
      return drawbar.paint();
    }
    if (e.altKey && !ctrl && k === "l" && mode === "chart" && c0) {
      e.preventDefault();
      const daily = ["1D", "1W"].includes(c0.tf);
      const cur = c0.cc.scale ?? (daily ? cfg.chart.scale_daily : cfg.chart.scale_intraday);
      return c0.setView({ scale: cur === "log" ? "normal" : "log" });
    }
    if (ctrl && !e.altKey && k === "i" && mode === "chart") {
      e.preventDefault();
      return indpanel.open();
    }
    if (ctrl && !e.altKey && k === "b") {
      e.preventDefault();
      return setMode(mode === "backtest" ? "chart" : "backtest");
    }
    if (ctrl && !e.altKey && e.key === ",") {
      e.preventDefault();
      return settings.open();
    }
  }
  if (typing || e.ctrlKey || e.altKey || e.metaKey || overlays().length) return;
  const c = grid.current;
  if (e.key === "Tab") {
    e.preventDefault();
    setSidebar(!cfg.layout.sidebar_visible);
  } else if (e.key === "/") {
    e.preventDefault();
    openPicker();
  } else if (mode === "chart" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    const w = cfg.watchlist;
    const i = w.indexOf(c?.cc.symbol);
    const j = i < 0 ? 0 : Math.max(0, Math.min(w.length - 1, i + (e.key === "ArrowUp" ? -1 : 1)));
    if (w[j]) grid.setSymbol(w[j]);
  } else if (mode === "chart" && (e.key.length === 1 && /[a-z0-9^]/i.test(e.key) || e.key === "Process" || /^[ㄱ-ㅎㅏ-ㅣ가-힣]$/.test(e.key))) {
    // 차트 위에서 그냥 글자를 치면 바로 종목 찾기 (한글 입력 중이면 빈 칸으로 열고 이어서 치면 된다)
    e.preventDefault();
    openPicker(e.key === "Process" ? "" : e.key);
  }
});

startEventAlerts({ toast, enabled: () => cfg.chart.show_events ?? true });
const welcomeApp = { cfg, data, grid, trading, openSettings: (t, then) => settings.open(t, then) };
setTimeout(() => maybeWelcome(welcomeApp), 1500);

window.pc = { cfg, data, grid, alerts, estimator, replay, trading, updater, normalizeInput, marketOf };
