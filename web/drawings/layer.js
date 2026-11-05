// 그리기 도구 (SPEC §3.4): 칸 하나에 붙는 그림 층.
// - lightweight-charts에는 그리기 도구가 없어서 primitive(attachPrimitive)로 캔버스에 직접 그린다
// - 점은 시각·가격으로 저장 → 봉을 바꾸거나 다른 칸에서 같은 종목을 봐도 같은 자리
// - 만들기: 도구를 고르고 점을 찍는다(그냥 누르기). 누른 채 끌면 차트가 앞뒤로 움직인다(그리기는 그대로).
//   "계속 그리기"(기본)면 하나를 다 그려도 도구가 그대로 → 우클릭·Esc로 그만. 자석: 가까운 봉의 시·고·저·종에 붙음(Shift = 끔)
// - 고치기: 그린 것을 누르면 선택 → 점 끌기·통째로 옮기기, 위쪽 막대에서 색·두께·연장·잠금·알림·삭제
import { createMapper, lineAt, intersect, distToSeg, extend } from "./geom.js";
import { drawingsOf, setDrawings, onDrawings, newId } from "./store.js";
import { anchoredVwap } from "../indicators/calc.js";
import { h, colorPick } from "../ui/dom.js";
import { num, signed, duration } from "../ui/format.js";
import { openMenu } from "../ui/menu.js";
import { ask } from "../ui/dialog.js";
import { DAY } from "../core/tz.js";
import { upColor, downColor } from "../core/colors.js";

export const TOOLS = {
  trend: { name: "Trend Line", n: 2, icon: "╱" },
  info: { name: "Info Line", n: 2, icon: "ⓘ" },
  hline: { name: "Horizontal Line", n: 1, icon: "━" },
  hray: { name: "Horizontal Ray", n: 1, icon: "┣" },
  triangle: { name: "Triangle Pattern", n: 4, icon: "◁" },
  fib: { name: "Fib Retracement", n: 2, icon: "≣" },
  avwap: { name: "Anchored VWAP", n: 1, icon: "⚓" },
  brush: { name: "Brush", n: Infinity, icon: "✎" },
  text: { name: "Text", n: 1, icon: "T" },
};
const TEXT_SIZE = { 1: 14, 2: 18, 3: 26 };
const MCTX = document.createElement("canvas").getContext("2d"); // 글자 폭 재기
const START_COLOR = { trend: "#5ec8d8", info: "#e8eaed", hline: "#ffb020", hray: "#ffb020", triangle: "#b18cff", fib: "#a0a6ae", avwap: "#ff6fae", brush: "#ffb020", text: "#e8eaed" };
// 그리기 색 16가지 + 🎨 직접 고르기 (0.13.0, 사용자: "색상도 더 다양하게")
export const DRAW_COLORS = ["#e8eaed", "#ffb020", "#ff4d4f", "#3d8bff", "#4cd5a0", "#b18cff", "#5ec8d8", "#ff6fae", "#f5c542", "#ff8a3d", "#9ad04a", "#00c853", "#26a69a", "#7c4dff", "#a1887f", "#ffffff"];

/**
 * 브러시 색·두께 (0.16.0, 사용자: "브러시 색깔이랑 두께 설정 못 함?"): 브러시를 켜면 그리기 막대에서 고르고, 고른 것을 기억한다 (cfg.chart.brush).
 * 전에는 늘 주황 2px로 그려지고, 다 그린 뒤 브러시를 끄고 선을 눌러야만 바꿀 수 있었다. 두께는 1~5px (다른 그림은 1~3px)
 */
export const BRUSH_WIDTHS = [1, 2, 3, 4, 5];
export function brushStyle(cfg) {
  const b = cfg?.chart?.brush ?? {};
  return { color: /^#[0-9a-f]{6}$/i.test(b.color ?? "") ? b.color : START_COLOR.brush, width: BRUSH_WIDTHS.includes(b.width) ? b.width : 2 };
}
const FIB = [
  [0, "#a0a6ae"],
  [0.236, "#ff4d4f"],
  [0.382, "#ff8a3d"],
  [0.5, "#4cd5a0"],
  [0.618, "#5ec8d8"],
  [0.786, "#3d8bff"],
  [1, "#a0a6ae"],
];
/** 알림을 걸 수 있는 그림 (가격이 이 선을 넘으면) */
export const ALERTABLE = new Set(["trend", "info", "hline", "hray", "triangle", "avwap"]);
const FONT = '"Segoe UI", "Malgun Gothic", sans-serif';

/**
 * o: {chart, box, main(), view() → {sym, bars, tf, info, ext, log, decimals, time, lineOnly},
 *     cfg, measureOn(), onTool(tool), onAlert(dw), setMarkers(list)}
 */
export function createDrawings(o) {
  const { chart, box, cfg } = o;
  let tool = null; // 만드는 중인 도구 종류
  let draft = null; // {type, pts, hover}
  let press = null; // 도구를 든 채 누른 곳 {x, y, shift} → 손을 뗄 때 거의 안 움직였으면 점 찍기, 끌었으면 차트 이동
  let selId = null;
  let drag = null; // {id, idx(-1 = 통째로), x, y, orig}
  let M = null;
  let mKey = null;
  let avCache = new Map(); // id → {key, vals}

  // ── 변환 ──
  function mapper() {
    const v = o.view();
    if (!M || mKey?.bars !== v.bars || mKey.tf !== v.tf || mKey.log !== v.log || mKey.ext !== v.ext || mKey.sym !== v.sym) {
      M = createMapper(v);
      mKey = { bars: v.bars, tf: v.tf, log: v.log, ext: v.ext, sym: v.sym };
      avCache = new Map();
    }
    return M;
  }
  /** 화면 가로: 봉 위치(소수 가능) → x. 라이브러리는 정수 위치만 받아서 직접 계산한다 */
  function axis() {
    const ts = chart.timeScale();
    const x0 = ts.logicalToCoordinate(0);
    const x1 = ts.logicalToCoordinate(1);
    if (x0 == null || x1 == null) return null;
    return { x0, sp: x1 - x0, W: ts.width() };
  }
  const yOf = (p) => o.main()?.priceToCoordinate(p) ?? null;

  function xy(pt, m, ax) {
    const L = m.logical(pt);
    const y = yOf(pt.p);
    if (L == null || y == null) return null;
    return { x: ax.x0 + L * ax.sp, y, L, F: m.f(pt.p) };
  }

  /** 화면 위치 → 저장할 점 (자석 포함) */
  function pointAt(x, y, e, exact = false) {
    const m = mapper();
    const ax = axis();
    const series = o.main();
    if (!m.n || !ax || !series) return null;
    const raw = (x - ax.x0) / ax.sp;
    const L = Math.round(raw);
    let p = series.coordinateToPrice(y);
    if (p == null) return null;
    if (exact) {
      // Brush: 자석 없이, 봉 사이 위치까지 그대로
      const pt = m.point(L, p);
      const off = Math.round((raw - L) * 100) / 100;
      return off ? { ...pt, o: off } : pt;
    }
    const v = o.view();
    if ((cfg.chart.magnet ?? true) && !e?.shiftKey && L >= 0 && L < v.bars.length) {
      const b = v.bars[L];
      let best = null;
      for (const c of v.lineOnly ? [b.c] : [b.o, b.h, b.l, b.c]) {
        const d = Math.abs((yOf(c) ?? 1e9) - y);
        if (d < 36 && (!best || d < best.d)) best = { c, d };
      }
      if (best) p = best.c;
    }
    return m.point(L, p);
  }

  // ── 모양 (화면 픽셀): 그리기와 누르기 판정에 같이 쓴다 ──
  function shapeOf(dw, m, ax) {
    const pts = dw.pts.map((p) => xy(p, m, ax));
    if (pts.some((p) => !p)) return null;
    const s = { segs: [], fills: [], texts: [], handles: pts, axis: [], color: dw.color, width: dw.width ?? 2 };
    const W = ax.W;
    const v = o.view();
    switch (dw.type) {
      case "trend":
      case "info": {
        const [A, B] = pts;
        const B2 = B ?? A;
        s.segs.push(extend(A.x, A.y, B2.x, B2.y, W, dw.extL, dw.extR));
        if (dw.type === "info" && B) s.texts.push(infoBox(dw, A, B, m, v));
        break;
      }
      case "hline":
        s.segs.push([-10, pts[0].y, W + 10, pts[0].y]);
        s.axis.push({ y: pts[0].y, text: fmt(dw.pts[0].p, v), color: dw.color });
        break;
      case "hray":
        s.segs.push([pts[0].x, pts[0].y, W + 10, pts[0].y]);
        s.axis.push({ y: pts[0].y, text: fmt(dw.pts[0].p, v), color: dw.color });
        break;
      case "fib": {
        const [A, B] = pts;
        if (!B) break;
        const xl = Math.min(A.x, B.x);
        const xr = dw.extR ? W + 10 : Math.max(A.x, B.x);
        s.segs.push([A.x, A.y, B.x, B.y, "dash"]);
        let prevY = null;
        for (const [lv, c] of FIB) {
          const price = dw.pts[1].p + (dw.pts[0].p - dw.pts[1].p) * lv;
          const y = yOf(price);
          if (y == null) continue;
          s.segs.push([xl, y, xr, y, null, c]);
          if (prevY != null) s.fills.push({ poly: [[xl, prevY], [xr, prevY], [xr, y], [xl, y]], color: c, alpha: 0.06 });
          s.texts.push({ x: xl - 6, y, text: `${(lv * 100).toFixed(1).replace(/\.0$/, "")}%  ${fmt(price, v)}`, color: c, align: "right" });
          prevY = y;
        }
        break;
      }
      case "triangle":
        triangleShape(dw, pts, s, m, ax, v);
        break;
      case "brush":
        s.poly = pts.map((q) => [q.x, q.y]);
        s.handles = [];
        break;
      case "text": {
        const A = pts[0];
        const size = TEXT_SIZE[dw.width ?? 2] ?? 18;
        const lines = String(dw.text ?? "").split("\n");
        MCTX.font = `bold ${size}px ${FONT}`;
        const w = Math.max(...lines.map((l) => MCTX.measureText(l).width));
        const hgt = lines.length * size * 1.25;
        s.texts.push({ x: A.x, y: A.y, text: dw.text ?? "", color: dw.color, size, outline: true });
        s.box = [A.x - 4, A.y - hgt / 2 - 2, A.x + w + 4, A.y + hgt / 2 + 2];
        break;
      }
      case "avwap": {
        const vals = avwapVals(dw, m, v);
        const A = pts[0];
        const from = Math.max(0, Math.ceil(A.L - 1e-9));
        const r = chart.timeScale().getVisibleLogicalRange();
        if (!vals || !r) break;
        const i0 = Math.max(from, Math.floor(r.from) - 1);
        const i1 = Math.min(vals.length - 1, Math.ceil(r.to) + 1);
        const line = [];
        for (let i = i0; i <= i1; i++) {
          const y = vals[i] == null ? null : yOf(vals[i]);
          if (y != null) line.push([ax.x0 + i * ax.sp, y]);
        }
        s.poly = line;
        s.handles = [{ ...A, y: yOf(vals[from]) ?? A.y }];
        const last = vals[vals.length - 1];
        if (last != null) {
          s.axis.push({ y: yOf(last), text: fmt(last, v), color: dw.color });
          const lp = line[line.length - 1];
          if (lp) s.texts.push({ x: lp[0] + 6, y: lp[1] - 10, text: "AVWAP", color: dw.color, align: "left" });
        }
        break;
      }
    }
    return s;
  }

  function fmt(p, v) {
    return v.info.yieldLike ? `${num(p, 3)}%` : num(p, v.decimals);
  }

  function infoBox(dw, A, B, m, v) {
    const [pa, pb] = dw.pts;
    const diff = pb.p - pa.p;
    const pct = (diff / pa.p) * 100;
    const nBars = Math.round(Math.abs(B.L - A.L));
    const sec = Math.abs(m.keyOf(pb) - m.keyOf(pa));
    const lines = [`${diff >= 0 ? "▲" : "▼"} ${signed(diff, v.decimals)} (${signed(pct, 2)}%)`, `${nBars}봉 · ${duration(sec)}`];
    if (m.daily && sec >= 180 * DAY && pa.p > 0 && pb.p > 0) {
      const lo = m.keyOf(pb) >= m.keyOf(pa) ? pa.p : pb.p;
      const hi = m.keyOf(pb) >= m.keyOf(pa) ? pb.p : pa.p;
      lines.push(`연 ${signed(((hi / lo) ** ((365.25 * DAY) / sec) - 1) * 100, 1)}%`);
    }
    return { x: B.x + 10, y: B.y, text: lines.join("\n"), color: diff >= 0 ? upColor() : downColor(), box: true, align: "left" };
  }

  /** 삼각수렴: A·C를 잇는 선, B·D를 잇는 선 → 꼭짓점까지 늘리고 안쪽을 옅게 */
  function triangleGeo(dw, m) {
    const P = dw.pts.map((p) => ({ L: m.logical(p), F: m.f(p.p) }));
    if (P.length < 4 || P.some((p) => p.L == null)) return null;
    let [A, B, C, D] = P;
    let up = [A, C];
    let dn = [B, D];
    const mid = (Math.max(A.L, B.L, C.L, D.L) + Math.min(A.L, B.L)) / 2;
    if (lineAt(up[0], up[1], mid) < lineAt(dn[0], dn[1], mid)) [up, dn] = [dn, up];
    const lastL = Math.max(A.L, B.L, C.L, D.L);
    const apex = intersect(up[0], up[1], dn[0], dn[1]);
    const end = apex && apex.L > lastL ? apex.L : null;
    return { up, dn, apex: end != null ? apex : null, start: Math.min(A.L, B.L), lastL, end: end ?? lastL };
  }

  function triangleShape(dw, pts, s, m, ax, v) {
    if (pts.length < 4) {
      // 만드는 중: 찍은 점끼리 지그재그
      for (let i = 1; i < pts.length; i++) s.segs.push([pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y]);
      return;
    }
    const g = triangleGeo(dw, m);
    if (!g) return;
    const X = (L) => ax.x0 + L * ax.sp;
    const Y = (F) => yOf(m.finv(F));
    const seg = (line, L1, L2) => {
      const y1 = Y(lineAt(line[0], line[1], L1));
      const y2 = Y(lineAt(line[0], line[1], L2));
      return y1 == null || y2 == null ? null : [X(L1), y1, X(L2), y2];
    };
    const a = seg(g.up, Math.min(g.up[0].L, g.up[1].L), g.end);
    const b = seg(g.dn, Math.min(g.dn[0].L, g.dn[1].L), g.end);
    if (a) s.segs.push(a);
    if (b) s.segs.push(b);
    for (let i = 1; i < 4; i++) s.segs.push([pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, "dash"]);
    // 안쪽 칠하기
    const poly = [];
    const steps = 24;
    for (let k = 0; k <= steps; k++) {
      const L = g.start + ((g.end - g.start) * k) / steps;
      const y = Y(lineAt(g.up[0], g.up[1], L));
      if (y != null) poly.push([X(L), y]);
    }
    for (let k = steps; k >= 0; k--) {
      const L = g.start + ((g.end - g.start) * k) / steps;
      const y = Y(lineAt(g.dn[0], g.dn[1], L));
      if (y != null) poly.push([X(L), y]);
    }
    s.fills.push({ poly, color: dw.color, alpha: 0.1 });
    if (g.apex) {
      const ya = Y(g.apex.F);
      const t = m.timeAt(g.apex.L);
      const d = new Date(t * 1000);
      const p2 = (n) => String(n).padStart(2, "0");
      const when = m.daily ? `${d.getUTCFullYear() % 100}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}` : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
      if (ya != null) {
        s.dots = [[X(g.apex.L), ya]];
        s.texts.push({ x: X(g.apex.L) + 8, y: ya, text: `꼭짓점 ${when}  ${fmt(m.finv(g.apex.F), v)}`, color: dw.color, align: "left" });
      }
    }
  }

  function avwapVals(dw, m, v) {
    const L = m.logical(dw.pts[0]);
    if (L == null) return null;
    const from = Math.max(0, Math.ceil(L - 1e-9));
    const key = `${from}|${v.bars.length}|${v.bars[v.bars.length - 1]?.c}`;
    const c = avCache.get(dw.id);
    if (c?.key === key) return c.vals;
    const src = v.info.volume ? v.bars : v.bars.map((b) => ({ ...b, v: 1 }));
    const vals = from < v.bars.length ? anchoredVwap(src, from) : null;
    avCache.set(dw.id, { key, vals });
    return vals;
  }

  // ── 그리기 (primitive) ──
  let shapes = []; // [{dw, s}] 마지막으로 그린 것 (누르기 판정용)
  let axisLabels = [];

  class Prim {
    constructor() {
      this._pane = [{ zOrder: () => "top", renderer: () => ({ draw: (t) => this.draw(t) }) }];
    }
    attached({ requestUpdate }) {
      this.req = requestUpdate;
    }
    detached() {
      this.req = null;
    }
    update() {
      this.req?.();
    }
    paneViews() {
      return this._pane;
    }
    updateAllViews() {
      compute();
    }
    priceAxisViews() {
      return axisLabels;
    }
    draw(target) {
      target.useMediaCoordinateSpace(({ context: ctx }) => paint(ctx));
    }
  }
  const prim = new Prim();

  function list() {
    return drawingsOf(o.view().sym);
  }

  function compute() {
    shapes = [];
    const v = o.view();
    if (!v.bars.length || !o.main()) {
      axisLabels = [];
      return;
    }
    const m = mapper();
    const ax = axis();
    if (!ax) return;
    for (const dw of list()) {
      const s = shapeOf(dw, m, ax);
      if (s) shapes.push({ dw, s });
    }
    if (draft) {
      const pts = [...draft.pts, draft.hover].filter(Boolean);
      const st = draft.type === "brush" ? brushStyle(cfg) : { color: START_COLOR[draft.type], width: 2 }; // 그리는 동안에도 고른 브러시 색·두께로
      const s = shapeOf({ id: "draft", type: draft.type, pts, color: st.color, width: st.width, extR: draft.type === "fib" }, m, ax);
      if (s) shapes.push({ dw: { id: "draft" }, s, draft: true });
    }
    axisLabels = shapes.flatMap(({ s }) => s.axis).filter((a) => a.y != null).map(axisView);
  }

  function axisView(a) {
    return { coordinate: () => a.y, text: () => a.text, textColor: () => "#0b0d10", backColor: () => a.color, visible: () => true, tickVisible: () => true };
  }

  function paint(ctx) {
    for (const { dw, s, draft: isDraft } of shapes) {
      const sel = dw.id === selId || isDraft;
      ctx.lineCap = "round";
      for (const f of s.fills) {
        if (f.poly.length < 3) continue;
        ctx.globalAlpha = f.alpha;
        ctx.fillStyle = f.color;
        ctx.beginPath();
        f.poly.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      for (const [x1, y1, x2, y2, style, color] of s.segs) {
        ctx.strokeStyle = color ?? s.color;
        ctx.lineWidth = style === "dash" ? 1 : s.width;
        ctx.setLineDash(style === "dash" ? [5, 4] : []);
        ctx.globalAlpha = style === "dash" ? 0.6 : 1;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      if (s.poly?.length > 1) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width;
        ctx.beginPath();
        s.poly.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
      }
      for (const [x, y] of s.dots ?? []) {
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const t of s.texts) drawText(ctx, t);
      if (sel) {
        for (const p of s.handles) {
          if (!p) continue;
          ctx.fillStyle = "#0b0d10";
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
      if (dw.locked && sel && s.handles[0]) {
        ctx.fillStyle = "#c9ced6";
        ctx.font = `14px ${FONT}`;
        ctx.fillText("🔒", s.handles[0].x + 8, s.handles[0].y - 8);
      }
    }
  }

  function drawText(ctx, t) {
    const lines = t.text.split("\n");
    if (t.outline) {
      // Text 도구: 굵은 글자 + 어두운 테두리 (어느 배경에서도 잘 보이게)
      ctx.font = `bold ${t.size}px ${FONT}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.lineJoin = "round";
      const lh = t.size * 1.25;
      lines.forEach((l, k) => {
        const y = t.y + (k - (lines.length - 1) / 2) * lh;
        ctx.lineWidth = Math.max(3, t.size / 5);
        ctx.strokeStyle = "rgba(11,13,16,0.9)";
        ctx.strokeText(l, t.x, y);
        ctx.fillStyle = t.color;
        ctx.fillText(l, t.x, y);
      });
      return;
    }
    ctx.font = `${t.box ? "bold 15px" : "13px"} ${FONT}`;
    ctx.textBaseline = "middle";
    const lh = t.box ? 20 : 16;
    if (t.box) {
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
      const hgt = lines.length * lh + 10;
      const W = chart.timeScale().width();
      let x = t.x;
      if (x + w > W - 4) x = t.x - w - 20;
      const y = t.y - hgt / 2;
      ctx.fillStyle = "rgba(20,24,30,0.92)";
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, hgt, 8);
      else ctx.rect(x, y, w, hgt);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = t.color;
      ctx.textAlign = "left";
      lines.forEach((l, k) => ctx.fillText(l, x + 8, y + 5 + lh / 2 + k * lh));
      return;
    }
    ctx.fillStyle = t.color;
    ctx.textAlign = t.align ?? "left";
    lines.forEach((l, k) => ctx.fillText(l, t.x, t.y - 8 + k * lh));
  }

  const redraw = () => prim.update();

  // ── 누르기 판정 ──
  function hitTest(x, y) {
    compute(); // 마지막으로 그린 뒤 봉·눈금이 바뀌었을 수 있다
    for (let k = shapes.length - 1; k >= 0; k--) {
      const { dw, s, draft: isDraft } = shapes[k];
      if (isDraft) continue;
      const hi = s.handles.findIndex((p) => p && Math.hypot(p.x - x, p.y - y) < 9);
      if (hi >= 0 && dw.id === selId) return { dw, idx: dw.type === "avwap" ? 0 : hi };
      for (const [x1, y1, x2, y2] of s.segs) if (distToSeg(x, y, x1, y1, x2, y2) < 6) return { dw, idx: -1 };
      if (s.poly) for (let i = 1; i < s.poly.length; i++) if (distToSeg(x, y, ...s.poly[i - 1], ...s.poly[i]) < 6) return { dw, idx: -1 };
      if (s.box && x >= s.box[0] && x <= s.box[2] && y >= s.box[1] && y <= s.box[3]) return { dw, idx: -1 };
      if (hi >= 0) return { dw, idx: -1 };
    }
    return null;
  }

  // ── 손으로 다루기 ──
  const local = (e) => {
    const r = box.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const inPane = (p) => {
    const ax = axis();
    const ph = chart.panes()[0]?.getHeight?.() ?? box.clientHeight;
    return ax && p.x >= 0 && p.x <= ax.W && p.y >= 0 && p.y <= ph;
  };
  const lockChart = (on) => chart.applyOptions({ handleScroll: !on, handleScale: !on });
  const stop = (e) => {
    e.stopImmediatePropagation();
    e.preventDefault();
  };

  box.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || o.measureOn() || e.target.closest?.(".dw-bar,.measure-label")) return;
      const p = local(e);
      if (!inPane(p)) return;
      if (tool && tool !== "brush") {
        // 막지 않고 차트에 넘긴다 → 끌면 차트가 움직이고, 그냥 눌렀다 떼면 점을 찍는다 (up에서)
        press = { x: p.x, y: p.y, shift: e.shiftKey };
        return;
      }
      if (tool === "brush") {
        // 누른 채로 끄는 동안 점을 모은다 (손을 떼면 끝)
        stop(e);
        const pt = pointAt(p.x, p.y, e, true);
        if (!pt) return;
        draft = { type: "brush", pts: [pt], hover: null, down: p, last: p };
        box.setPointerCapture(e.pointerId);
        lockChart(true);
        return;
      }
      const hit = hitTest(p.x, p.y);
      if (!hit) {
        if (selId) select(null);
        return;
      }
      stop(e);
      select(hit.dw.id);
      if (hit.dw.locked) return;
      drag = { id: hit.dw.id, idx: hit.idx, x: p.x, y: p.y, orig: structuredClone(hit.dw.pts), moved: false };
      box.setPointerCapture(e.pointerId);
      lockChart(true);
    },
    true
  );

  box.addEventListener(
    "pointermove",
    (e) => {
      const p = local(e);
      if (draft?.type === "brush") {
        if (!(e.buttons & 1) || Math.hypot(p.x - draft.last.x, p.y - draft.last.y) < 3) return;
        const pt = pointAt(p.x, p.y, e, true);
        if (pt) draft.pts.push(pt);
        draft.last = p;
        redraw();
        return;
      }
      if (draft) {
        draft.hover = pointAt(p.x, p.y, e);
        redraw();
        return;
      }
      if (drag) {
        e.stopImmediatePropagation();
        moveDrag(p, e);
        return;
      }
      if (e.buttons || tool) return;
      const hit = inPane(p) && hitTest(p.x, p.y);
      box.classList.toggle("dw-hover", !!hit);
    },
    true
  );

  /** 도구를 든 채 한 번 누른 곳에 점 찍기 */
  function place(p, ev) {
    if (tool === "text") {
      const pt = pointAt(p.x, p.y, ev, true); // 글자는 누른 자리 그대로 (자석 없이)
      if (pt) writeText(pt);
      return;
    }
    const pt = pointAt(p.x, p.y, ev);
    if (!pt) return;
    if (!draft) {
      draft = { type: tool, pts: [pt], hover: pt };
      if (TOOLS[tool].n === 1) finish();
    } else {
      draft.pts.push(pt);
      draft.hover = null;
      if (draft.pts.length >= TOOLS[draft.type].n) finish();
    }
    redraw();
  }

  const up = (e) => {
    if (press) {
      const pr = press;
      press = null;
      const p = local(e);
      // 6px 안이면 "누르기", 더 끌었으면 차트를 옮긴 것 (점은 안 찍음)
      if (tool && e.type === "pointerup" && Math.hypot(p.x - pr.x, p.y - pr.y) <= 6) place(pr, { shiftKey: pr.shift || e.shiftKey });
      return;
    }
    if (draft?.type === "brush") {
      if (draft.pts.length >= 2) finish();
      else {
        draft = null;
        lockChart(false);
      }
      redraw();
      return;
    }
    if (!drag) return;
    e.stopImmediatePropagation();
    const d = drag;
    drag = null;
    lockChart(false);
    if (d.moved) save(list().map((x) => x));
  };
  box.addEventListener("pointerup", up, true);
  box.addEventListener("pointercancel", up, true);

  box.addEventListener(
    "contextmenu",
    (e) => {
      const p = local(e);
      // 도구를 든 채 우클릭 = 그리던 것 취소, 한 번 더 = 그리기 그만
      if (tool && inPane(p) && e.target.tagName === "CANVAS") {
        stop(e);
        if (draft) {
          draft = null;
          lockChart(false);
          redraw();
        } else setTool(null);
        return;
      }
      const hit = inPane(p) && hitTest(p.x, p.y);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      select(hit.dw.id);
      menu(hit.dw, e.clientX, e.clientY);
    },
    true
  );

  function moveDrag(p, e) {
    const dw = list().find((x) => x.id === drag.id);
    if (!dw) return;
    const m = mapper();
    const ax = axis();
    if (!ax) return;
    drag.moved = drag.moved || Math.hypot(p.x - drag.x, p.y - drag.y) > 2;
    if (drag.idx >= 0) {
      const pt = pointAt(p.x, p.y, e);
      if (pt) dw.pts[drag.idx] = dw.type === "hline" ? { ...dw.pts[0], p: pt.p } : pt;
    } else {
      // 통째로: 화면에서 움직인 만큼 (로그 눈금이어도 모양 그대로)
      const dL = Math.round((p.x - drag.x) / ax.sp);
      const dy = p.y - drag.y;
      const series = o.main();
      dw.pts = drag.orig.map((pt) => {
        const L = m.logical(pt);
        const y0 = yOf(pt.p);
        const np = y0 == null ? pt.p : series.coordinateToPrice(y0 + dy) ?? pt.p;
        if (dw.type === "hline") return { ...pt, p: np };
        const q = m.point(Math.round(L - (pt.o ?? 0)) + dL, np);
        return pt.o ? { ...q, o: pt.o } : q;
      });
    }
    refreshMarkers();
    redraw();
  }

  function finish() {
    const d = draft;
    draft = null;
    lockChart(false);
    const need = d?.type === "brush" ? 2 : TOOLS[d?.type]?.n;
    if (!d || d.pts.length < need) return;
    const st = d.type === "brush" ? brushStyle(cfg) : { color: START_COLOR[d.type], width: d.type === "hline" || d.type === "hray" ? 1 : 2 };
    const dw = { id: newId(), type: d.type, pts: d.type === "brush" ? d.pts : d.pts.slice(0, TOOLS[d.type].n), color: st.color, width: st.width, extL: false, extR: d.type === "fib", locked: false };
    // 계속 그리기면 도구를 그대로 두고 바로 다음 것을 그린다 (선택 막대도 안 띄움)
    if (cfg.chart.keep_draw_tool ?? true) selId = null;
    else {
      selId = dw.id;
      setTool(null);
    }
    save([...list(), dw]);
    paintBar();
  }

  function save(next) {
    setDrawings(o.view().sym, next);
  }

  /** Text: 누른 곳에 글자 쓰기 (이미 있는 글자를 고칠 때는 dw를 넘긴다) */
  async function writeText(pt, dw = null) {
    if (!dw && !(cfg.chart.keep_draw_tool ?? true)) setTool(null);
    const text = await ask(dw ? "글자 고치기" : "차트에 쓸 글자", { placeholder: "예: 여기서 샀음, 실적 발표, 지지선", value: dw?.text ?? "", ok: dw ? "고치기" : "쓰기" });
    if (!text) return;
    if (dw) return update(dw.id, { text });
    const nd = { id: newId(), type: "text", pts: [pt], text, color: START_COLOR.text, width: 2, locked: false };
    selId = tool ? null : nd.id;
    save([...list(), nd]);
    paintBar();
  }

  function update(id, patch) {
    save(list().map((x) => (x.id === id ? { ...x, ...patch } : x)));
    paintBar();
  }

  function remove(id) {
    if (selId === id) select(null);
    save(list().filter((x) => x.id !== id));
  }

  // ── 선택하면 뜨는 막대: 색·두께·연장·잠금·알림·삭제 ──
  const bar = h("div.dw-bar", { hidden: true });
  box.append(bar);
  bar.addEventListener("pointerdown", (e) => e.stopPropagation());

  function select(id) {
    selId = id;
    paintBar();
    redraw();
  }

  // 막대 접기 (0.19.0, 사용자: "저거 땜시 멀리 있는 차트 보는 데 방해 · 최소화 버튼"): ✏ 버튼만 남긴다. 접은 채로 기억 → 선을 누를 때마다 다시 접지 않게
  // 선 끌기·Delete·오른쪽 클릭 메뉴는 막대와 따로라 그대로 된다
  function setBarMini(on) {
    cfg.chart.draw_bar_mini = on;
    cfg.save();
    paintBar();
  }

  function paintBar() {
    const dw = list().find((x) => x.id === selId);
    bar.hidden = !dw;
    if (!dw) return;
    const b = (label, on, onclick, tip) => h(`button${on ? ".on" : ""}`, { onclick, "data-tip-text": tip }, label);
    const mini = !!cfg.chart.draw_bar_mini;
    bar.classList.toggle("mini", mini);
    if (mini) return bar.replaceChildren(b("✏️", false, () => setBarMini(false), "설정 막대 펼치기 (색·두께·연장)"));
    const lineLike = dw.type === "trend" || dw.type === "info";
    const items = [
      h("span.dw-bar-name", { "data-tip": dw.type }, TOOLS[dw.type].name),
      h("span.dw-colors", DRAW_COLORS.map((c) => h(`button.swatch${dw.color === c ? ".on" : ""}`, { style: `background:${c}`, onclick: () => update(dw.id, { color: c }) })), colorPick(dw.color, (c) => update(dw.id, { color: c }))),
      dw.type === "text"
        ? [[1, "작게"], [2, "보통"], [3, "크게"]].map(([w, l]) => b(l, (dw.width ?? 2) === w, () => update(dw.id, { width: w }), "글자 크기"))
        : (dw.type === "brush" ? BRUSH_WIDTHS : [1, 2, 3]).map((w) => b(`${w}px`, (dw.width ?? 2) === w, () => update(dw.id, { width: w }), "두께")),
      dw.type === "text" ? b("✎ 고치기", false, () => writeText(null, dw), "글자 고치기") : null,
      lineLike ? b("← 연장", dw.extL, () => update(dw.id, { extL: !dw.extL }), "왼쪽으로 화면 끝까지 늘리기") : null,
      lineLike || dw.type === "fib" ? b("연장 →", dw.extR, () => update(dw.id, { extR: !dw.extR }), "오른쪽으로 화면 끝까지 늘리기") : null,
      b(dw.locked ? "🔒" : "🔓", dw.locked, () => update(dw.id, { locked: !dw.locked }), "잠금: 실수로 옮기지 않게"),
      ALERTABLE.has(dw.type) ? b("🔔", false, () => o.onAlert?.(dw), "알림 만들기\n가격(종가)이 이 선을 넘으면 알려줘요") : null,
      b("🗑", false, () => remove(dw.id), "지우기 (Delete)"),
      b("—", false, () => setBarMini(true), "막대 접기: 작은 ✏️ 버튼만 남겨요\n선 끌기·지우기는 그대로 돼요"),
      b("✕", false, () => select(null), "선택 풀기 (Esc)"),
    ];
    bar.replaceChildren(...items.flat().filter(Boolean));
  }

  function menu(dw, x, y) {
    openMenu(null, [
      { header: TOOLS[dw.type].name },
      ...(dw.type === "trend" || dw.type === "info" ? [
        { label: "← 왼쪽 연장", on: dw.extL, onclick: () => update(dw.id, { extL: !dw.extL }) },
        { label: "오른쪽 연장 →", on: dw.extR, onclick: () => update(dw.id, { extR: !dw.extR }) },
      ] : []),
      dw.type === "text" ? { label: "✎ 글자 고치기", onclick: () => writeText(null, dw) } : null,
      { label: dw.locked ? "🔓 잠금 풀기" : "🔒 잠그기", onclick: () => update(dw.id, { locked: !dw.locked }) },
      ALERTABLE.has(dw.type) ? { label: "🔔 알림 만들기", onclick: () => o.onAlert?.(dw) } : null,
      { sep: true },
      { label: "🗑 지우기", onclick: () => remove(dw.id) },
    ].filter(Boolean), { x, y });
  }

  // ── 삼각수렴 이탈 표시 (종가가 선 밖으로) ──
  function refreshMarkers() {
    const v = o.view();
    const out = [];
    if (v.bars.length) {
      const m = mapper();
      for (const dw of list()) {
        if (dw.type !== "triangle") continue;
        const g = triangleGeo(dw, m);
        if (!g) continue;
        const b = breakout(g, v.bars, m);
        if (b) out.push({ time: v.time(v.bars[b.i].t), position: b.up ? "aboveBar" : "belowBar", shape: b.up ? "arrowUp" : "arrowDown", color: b.up ? upColor() : downColor(), text: b.up ? "▲ 위 이탈" : "▼ 아래 이탈" });
      }
    }
    o.setMarkers(out);
  }

  const offStore = onDrawings((sym) => {
    if (sym !== o.view().sym) return;
    if (selId && !list().some((x) => x.id === selId)) selId = null;
    refreshMarkers();
    paintBar();
    redraw();
  });

  function setTool(t) {
    tool = t;
    draft = null;
    press = null;
    lockChart(false);
    box.classList.toggle("drawing", !!t);
    if (t) select(null);
    o.onTool?.(t);
    redraw();
  }

  return {
    prim,
    get tool() {
      return tool;
    },
    get selected() {
      return selId;
    },
    setTool,
    /** 봉·종목·눈금이 바뀌었을 때 */
    refresh() {
      M = null;
      if (selId && !list().some((x) => x.id === selId)) selId = null;
      refreshMarkers();
      paintBar();
      redraw();
    },
    /** Esc: 그리던 것 취소 → 한 번 더 누르면 그리기 그만 → 선택돼 있으면 풀기 */
    cancel() {
      if (draft && draft.type !== "brush") {
        draft = null;
        lockChart(false);
        redraw();
        return true;
      }
      if (draft || tool) {
        setTool(null);
        return true;
      }
      if (selId) {
        select(null);
        return true;
      }
      return false;
    },
    deleteSelected() {
      if (!selId) return false;
      remove(selId);
      return true;
    },
    clearAll() {
      select(null);
      save([]);
    },
    count: () => list().length,
    hitTest: (x, y) => hitTest(x, y)?.dw.id ?? null, // 시험용
    destroy() {
      offStore();
      bar.remove();
    },
  };
}

/** 삼각수렴 이탈: 마지막 점 다음 봉부터 종가가 선 밖으로 처음 나간 곳 */
export function breakout(g, bars, m) {
  const i0 = Math.max(0, Math.floor(g.lastL) + 1);
  const i1 = Math.min(bars.length - 1, Math.floor(g.apex ? g.apex.L : bars.length - 1));
  for (let i = i0; i <= i1; i++) {
    const F = m.f(bars[i].c);
    if (F > lineAt(g.up[0], g.up[1], i)) return { i, up: true };
    if (F < lineAt(g.dn[0], g.dn[1], i)) return { i, up: false };
  }
  return null;
}

/**
 * 알림용: 그림의 i번째 봉 위치 가격 (선이 없는 곳이면 null)
 * triangle은 {up, dn} 둘 다
 */
export function drawingValueAt(dw, m, bars, i, info) {
  const P = dw.pts.map((p) => ({ L: m.logical(p), F: m.f(p.p) }));
  if (P.some((p) => p.L == null)) return null;
  switch (dw.type) {
    case "hline":
      return dw.pts[0].p;
    case "hray":
      return i >= P[0].L - 1e-9 ? dw.pts[0].p : null;
    case "trend":
    case "info": {
      const [A, B] = P;
      const lo = Math.min(A.L, B.L);
      const hi = Math.max(A.L, B.L);
      if ((i < lo && !dw.extL) || (i > hi + 1e-9 && !dw.extR)) return null;
      return m.finv(lineAt(A, B, i));
    }
    case "avwap": {
      const from = Math.max(0, Math.ceil(P[0].L - 1e-9));
      if (i < from) return null;
      const src = info.volume ? bars : bars.map((b) => ({ ...b, v: 1 }));
      return anchoredVwap(src.slice(0, i + 1), from)[i];
    }
    case "triangle": {
      let [A, B, C, D] = P;
      let up = [A, C];
      let dn = [B, D];
      const mid = (Math.max(A.L, B.L, C.L, D.L) + Math.min(A.L, B.L)) / 2;
      if (lineAt(up[0], up[1], mid) < lineAt(dn[0], dn[1], mid)) [up, dn] = [dn, up];
      return { up: m.finv(lineAt(up[0], up[1], i)), dn: m.finv(lineAt(dn[0], dn[1], i)) };
    }
  }
  return null;
}
