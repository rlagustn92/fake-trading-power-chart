// 분할 화면 (SPEC §3.3): 1·2·3·4·6·8·9·16칸, 선택된 칸, 봉·시점·십자선 동기화, ⇄ 모두 맞추기, 더블클릭 크게
import { createCell } from "./cell.js";
import { preferLive } from "../core/symbols.js";
import { h } from "./dom.js";

export const SPLITS = {
  1: [1, 1],
  "2h": [2, 1],
  "2v": [1, 2],
  3: [3, 1],
  4: [2, 2],
  6: [3, 2],
  8: [4, 2],
  9: [3, 3],
  16: [4, 4],
};
export const SPLIT_NAME = { 1: "1", "2h": "2 좌우", "2v": "2 위아래", 3: "3", 4: "4", 6: "6", 8: "8", 9: "9", 16: "16" };
/** 메뉴 순서 (객체 키 순서는 숫자가 먼저라 "2 좌우"가 맨 뒤로 갔다) */
export const SPLIT_ORDER = ["1", "2h", "2v", "3", "4", "6", "8", "9", "16"];

const splitKey = (s) => (s === "2" ? "2h" : String(s));

export function createGrid(box, env) {
  const { cfg } = env;
  let cells = [];
  let selected = 0;
  let maximized = false;
  let picked = new Set(); // Ctrl+클릭으로 고른 칸: "지표 맞추기"·"⇄ 모두 맞추기"를 이 칸들에만

  const layout = () => cfg.grid.layouts[cfg.grid.current] ?? Object.values(cfg.grid.layouts)[0];
  const sync = () => ({ ...cfg.grid.sync, ...(layout().sync ?? {}) });

  function cellEnv() {
    return {
      ...env,
      onChange: () => cfg.save(),
      onSelect: (c, e) => {
        const i = cells.indexOf(c);
        if ((e?.ctrlKey || e?.metaKey) && cells.length > 1) {
          if (i !== selected) picked.has(c) ? picked.delete(c) : picked.add(c);
          return paintPicks();
        }
        if (picked.size && i !== selected) clearPicks();
        select(i);
      },
      onMaximize: (c) => toggleMaximize(cells.indexOf(c)),
      onClearCell: (c) => {
        const run = () => {
          const r = clearCell(cells.indexOf(c));
          if (r) env.toast?.(`${r.label} 칸을 비웠어요`, 6000, { label: "되돌리기", onclick: r.undo });
        };
        if (guard([c], "이 칸을 비우면", run)) run();
      },
      onCrosshair: (c, t) => {
        if (!sync().crosshair || cells.length < 2) return;
        for (const o of cells) if (o !== c) o.applyCrosshair(t);
      },
      // 시점은 같은 종목 칸끼리만 (SOXL 1분·5분처럼). 다른 종목 칸은 그대로 둔다
      onRange: (c, r) => {
        if (!sync().time || cells.length < 2 || c !== cells[selected]) return;
        for (const o of cells) if (o !== c && o.cc.symbol === c.cc.symbol) o.applyRange(r);
      },
    };
  }

  function build() {
    for (const c of cells) c.destroy();
    cells = [];
    const L = layout();
    const key = splitKey(L.split ?? "1");
    const [cols, rows] = SPLITS[key] ?? [1, 1];
    const n = cols * rows;
    L.cells ??= [];
    while (L.cells.length < n) L.cells.push({ ...(L.cells[L.cells.length - 1] ?? { symbol: "QQQ", timeframe: "1D" }), indicators: undefined, range: undefined });
    box.style.setProperty("--cols", cols);
    box.style.setProperty("--rows", rows);
    box.replaceChildren();
    const ce = cellEnv();
    for (let i = 0; i < n; i++) {
      const cc = L.cells[i];
      cc.symbol = preferLive(cc.symbol); // 예전에 넣은 BTC-USD(Yahoo, 늦음) → Binance 실시간
      cc.timeframe ??= L.timeframe ?? "1D";
      if (!cc.indicators) cc.indicators = structuredClone(cfg.indicators);
      const c = createCell(ce, cc);
      box.append(c.root);
      cells.push(c);
      enableDrag(c);
    }
    selected = Math.min(selected, n - 1);
    picked = new Set();
    maximized = false;
    box.classList.remove("maxed");
    box.classList.toggle("multi", n > 1);
    paintSelection();
    for (const c of cells) c.load("fresh");
    env.onCellsChange?.();
  }

  /**
   * 칸 수만 바꾸기 (0.13.0, 사용자: "2019년 리플레이로 모의매매하다가 칸을 늘렸더니 다 깨졌다"):
   * build()처럼 칸을 전부 새로 만들지 않고, 있던 칸은 그대로 두고 남는 칸만 없애고 모자란 칸만 만든다
   * → 리플레이·모의매매가 이어지고, 새 칸은 지금 리플레이 시각으로 같이 간다 (env.joinReplay)
   */
  function resize() {
    const L = layout();
    const key = splitKey(L.split ?? "1");
    const [cols, rows] = SPLITS[key] ?? [1, 1];
    const n = cols * rows;
    L.cells ??= [];
    while (L.cells.length < n) L.cells.push({ ...(L.cells[L.cells.length - 1] ?? { symbol: "QQQ", timeframe: "1D" }), indicators: undefined, range: undefined });
    for (const c of cells.slice(n)) c.destroy();
    const keep = cells.slice(0, n);
    const added = [];
    const ce = cellEnv();
    for (let i = keep.length; i < n; i++) {
      const cc = L.cells[i];
      cc.symbol = preferLive(cc.symbol);
      cc.timeframe ??= L.timeframe ?? "1D";
      if (!cc.indicators) cc.indicators = structuredClone(cfg.indicators);
      const c = createCell(ce, cc);
      keep.push(c);
      enableDrag(c);
      added.push(c);
    }
    cells = keep;
    box.style.setProperty("--cols", cols);
    box.style.setProperty("--rows", rows);
    box.replaceChildren(...cells.map((c) => c.root));
    selected = Math.min(selected, n - 1);
    picked = new Set();
    maximized = false;
    box.classList.remove("maxed");
    cells.forEach((c) => c.root.classList.remove("max"));
    box.classList.toggle("multi", n > 1);
    paintSelection();
    for (const c of added) if (!env.joinReplay?.(c)) c.load("fresh");
    env.onCellsChange?.();
  }

  /** 모의매매 중인 칸이 끝나게 되는 일이면 먼저 묻는다 (main.js guardTrading, 0.13.0). true = 바로 해도 됨 */
  const guard = (list, what, proceed) => !env.guard || env.guard(list, what, proceed);

  /** 이 칸 비우기 (빈 칸으로) → {label, undo} */
  function clearCell(i) {
    const c = cells[i];
    if (!c?.cc.symbol) return null;
    const before = c.exportConfig();
    const label = c.info.label;
    c.applyConfig({ symbol: null, timeframe: before.timeframe, indicators: [] });
    env.onCellsChange?.();
    return { label, undo: () => cells.includes(c) && (c.applyConfig(before), env.onCellsChange?.()) };
  }

  /** 지금 보이는 칸 모두 비우기 (초기화) → undo */
  function clearAll(force = false) {
    const later = () => {
      const undo = clearAll(true);
      env.toast?.("모든 칸을 비웠어요", 8000, { label: "되돌리기", onclick: undo });
    };
    if (!force && !guard(cells, "모든 칸을 비우면", later)) return null;
    const before = cells.map((c) => [c, c.exportConfig()]);
    for (const c of cells) c.applyConfig({ symbol: null, timeframe: c.cc.timeframe ?? "1D", indicators: [] });
    env.onCellsChange?.();
    return () => (before.forEach(([c, conf]) => cells.includes(c) && c.applyConfig(conf)), env.onCellsChange?.());
  }

  /** 칸 위쪽 이름 줄을 꾹 눌러(또는 끌어서) 다른 칸에 놓으면 두 칸이 자리를 바꾼다 */
  function enableDrag(c) {
    c.head.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || cells.length < 2 || e.target.closest("button")) return;
      const x0 = e.clientX;
      const y0 = e.clientY;
      let ghost = null;
      let target = null;
      const hold = setTimeout(() => start(), 300);
      const start = () => {
        if (ghost) return;
        ghost = h("div.cell-ghost", c.cc.symbol ? `${c.info.label} 옮기는 중…` : "빈 칸 옮기는 중…");
        document.body.append(ghost);
        c.root.classList.add("dragging");
        move({ clientX: x0, clientY: y0 });
      };
      const move = (ev) => {
        if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) start();
        if (!ghost) return;
        ghost.style.left = `${ev.clientX + 12}px`;
        ghost.style.top = `${ev.clientY + 12}px`;
        const el = document.elementsFromPoint(ev.clientX, ev.clientY).find((x) => x.classList?.contains("cell"));
        const t = cells.find((o) => o.root === el && o !== c) ?? null;
        if (t !== target) {
          target?.root.classList.remove("drop");
          target = t;
          target?.root.classList.add("drop");
        }
      };
      const up = () => {
        clearTimeout(hold);
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        ghost?.remove();
        c.root.classList.remove("dragging");
        target?.root.classList.remove("drop");
        if (ghost && target) swap(cells.indexOf(c), cells.indexOf(target));
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    });
  }

  function swap(i, j, force = false) {
    if (i < 0 || j < 0 || i === j) return;
    if (!force && !guard([cells[i], cells[j]], "칸 자리를 바꾸면", () => swap(i, j, true))) return;
    const a = cells[i].exportConfig();
    const b = cells[j].exportConfig();
    cells[i].applyConfig(b);
    cells[j].applyConfig(a);
    select(j);
    env.onCellsChange?.();
  }

  function paintPicks() {
    cells.forEach((c) => c.setPicked(picked.has(c)));
    env.onPicksChange?.();
  }
  function clearPicks() {
    picked.clear();
    paintPicks();
  }
  /** 맞출 대상: Ctrl+클릭으로 고른 칸이 있으면 그 칸들, 없으면 선택한 칸을 뺀 보이는 칸 모두 */
  const targets = () => (picked.size ? [...picked] : cells.filter((c, i) => i !== selected));

  function paintSelection() {
    cells.forEach((c, i) => c.setSelected(i === selected && cells.length > 1));
    env.onSelectChange?.(cells[selected]);
  }

  function select(i) {
    if (i < 0 || i >= cells.length || i === selected) return;
    selected = i;
    paintSelection();
  }

  function toggleMaximize(i = selected) {
    if (cells.length < 2) return;
    select(i);
    maximized = !maximized;
    box.classList.toggle("maxed", maximized);
    cells.forEach((c, k) => c.root.classList.toggle("max", maximized && k === selected));
  }

  /** ⇄ 모두 맞추기: 선택된 칸의 봉·지표·가격 기준·눈금·차트 종류·보이는 범위를 다른 칸 모두에 */
  function matchAll() {
    const src = cells[selected];
    if (!src) return;
    const r = src.visibleMoments();
    const { timeframe, indicators, basis, scale, chart_type } = src.cc;
    for (const c of targets()) {
      Object.assign(c.cc, { timeframe, indicators: structuredClone(indicators), basis, scale, chart_type });
      c.load("keep").then(() => r && c.applyRange(r));
    }
    cfg.save();
  }

  /** 지표 맞추기: 선택한 칸의 지표를 대상 칸에 똑같이 → {count, undo} */
  function matchIndicators() {
    const src = cells[selected];
    if (!src) return { count: 0, undo: () => {} };
    const list = (src.cc.indicators ?? []).map(({ uid, ...x }) => x);
    const before = targets().map((c) => [c, structuredClone(c.cc.indicators ?? [])]);
    for (const [c] of before) c.setIndicators(structuredClone(list));
    return { count: before.length, undo: () => before.forEach(([c, l]) => cells.includes(c) && c.setIndicators(l)) };
  }

  return {
    build,
    get cells() {
      return cells;
    },
    get current() {
      return cells[selected];
    },
    get maximized() {
      return maximized;
    },
    select,
    toggleMaximize,
    matchAll,
    matchIndicators,
    /** 날짜로 가기: scope "one" | "all" | "picked" */
    async goToDate(scope, dateStr, timeStr, tf, zone = "local") {
      const list = scope === "all" ? cells : scope === "picked" && picked.size ? [...picked, cells[selected]] : [cells[selected]];
      const res = await Promise.all(list.map((c) => c.goToDate(dateStr, timeStr, tf, zone)));
      clearPicks();
      env.onCellsChange?.();
      return { count: list.length, early: res.filter((r) => r?.early).length };
    },
    clearPicks,
    get picked() {
      return picked.size;
    },
    /** 선택된 칸에 종목 (종목 동기화가 켜져 있으면 모든 칸) */
    setSymbol: function setSymbol(id, force = false) {
      const targets = sync().symbol ? cells : [cells[selected]];
      if (!force && !guard(targets.filter((c) => c.cc.symbol !== id), "종목을 바꾸면", () => setSymbol(id, true))) return;
      for (const c of targets) c.setSymbol(id);
      env.onCellsChange?.();
    },
    /** 선택된 칸에 봉 (봉 동기화가 켜져 있으면 모든 칸, 그 종목이 그 봉을 지원할 때만) */
    setTimeframe(tf) {
      const targets = sync().interval ? cells : [cells[selected]];
      for (const c of targets) if (c.info.tfs.includes(tf)) c.setTimeframe(tf);
      env.onCellsChange?.();
    },
    setIndicators(list) {
      const targets = sync().indicators ? cells : [cells[selected]];
      for (const c of targets) c.setIndicators(list);
    },
    /** 지표 모두 빼기: "one" = 선택한 칸만, "all" = 지금 보이는 칸 모두 (분할을 줄여서 안 보이는 칸은 그대로) → {count, undo} */
    clearIndicators(scope = "one") {
      const targets = scope === "all" ? cells : [cells[selected]];
      const before = targets.map((c) => [c, structuredClone(c.cc.indicators ?? [])]);
      for (const c of targets) c.setIndicators([]);
      return {
        count: before.reduce((s, [, l]) => s + l.length, 0),
        undo: () => before.forEach(([c, l]) => cells.includes(c) && c.setIndicators(l)),
      };
    },
    setSplit: function setSplit(key, force = false) {
      const [cols, rows] = SPLITS[splitKey(key)] ?? [1, 1];
      if (!force && !guard(cells.slice(cols * rows), "칸을 줄여서 매매하는 칸이 없어지면", () => setSplit(key, true))) return;
      layout().split = key;
      cfg.save();
      resize(); // 있던 칸은 그대로 (리플레이가 이어진다)
    },
    setLayout: function setLayout(name, force = false) {
      if (!cfg.grid.layouts[name]) return;
      if (!force && name !== cfg.grid.current && !guard(cells, "다른 저장한 화면으로 바꾸면", () => setLayout(name, true))) return;
      cfg.grid.current = name;
      selected = 0;
      cfg.save();
      build();
    },
    /** 지금 분할·칸 구성을 이름 붙여 저장 */
    saveLayoutAs(name) {
      cfg.grid.layouts[name] = structuredClone(layout());
      cfg.grid.current = name;
      cfg.save();
    },
    deleteLayout: function deleteLayout(name, force = false) {
      if (Object.keys(cfg.grid.layouts).length <= 1) return;
      if (!force && cfg.grid.current === name && !guard(cells, "지금 화면을 지우면", () => deleteLayout(name, true))) return;
      delete cfg.grid.layouts[name];
      if (cfg.grid.current === name) cfg.grid.current = Object.keys(cfg.grid.layouts)[0];
      cfg.save();
      build();
    },
    symbols: () => cells.map((c) => c.cc.symbol).filter(Boolean),
    clearCell,
    clearAll,
    /** 분할 화면 전체 캡처: 칸 그림을 이어 붙인다 */
    async screenshot(all) {
      if (!all || cells.length === 1) return cells[selected].screenshot();
      const rect = box.getBoundingClientRect();
      const dpr = devicePixelRatio || 1;
      const out = h("canvas", { width: Math.round(rect.width * dpr), height: Math.round(rect.height * dpr) });
      const g = out.getContext("2d");
      g.fillStyle = "#0b0d10";
      g.fillRect(0, 0, out.width, out.height);
      for (const c of cells) {
        const r = c.root.querySelector(".cell-body").getBoundingClientRect();
        const shot = await c.screenshot();
        g.drawImage(shot, (r.left - rect.left) * dpr, (r.top - rect.top) * dpr, r.width * dpr, r.height * dpr);
        const hr = c.root.querySelector(".cell-head").getBoundingClientRect();
        g.fillStyle = "#e8eaed";
        g.font = `${Math.round(15 * dpr)}px "Segoe UI", "Malgun Gothic", sans-serif`;
        g.fillText(`${c.info.label} ${c.root.querySelector(".ch-price").textContent} ${c.root.querySelector(".ch-chg").textContent}`, (hr.left - rect.left + 6) * dpr, (hr.top - rect.top + hr.height * 0.72) * dpr);
      }
      return out;
    },
  };
}
