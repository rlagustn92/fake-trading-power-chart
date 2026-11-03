// 📏 구간 측정 (Market Board에서 가져옴 + 기간·연환산 수익률, SPEC §3.1)
// - 측정 모드(📏, 키보드 M)에서는 차트 이동·확대를 잠가서 드래그가 겹치지 않는다
// - 드래그 또는 두 번 클릭(A → B). 측정 모드가 아니어도 Shift + 드래그로 바로 잰다
// - 결과는 다음 측정이나 ✕ 전까지 그 자리(봉 위치·가격)에 고정된다
import { signed, duration } from "./format.js";

function el(cls, parent) {
  const e = document.createElement("div");
  e.className = cls;
  parent.appendChild(e);
  return e;
}

/**
 * @param o {chart, getSeries, box, getBars, isDaily, getDecimals, onToggle}
 */
export function createMeasure({ chart, getSeries, box, getBars, isDaily, getDecimals, onToggle }) {
  const layer = el("measure-layer", box);
  const rect = el("measure-rect", layer);
  const dotA = el("measure-dot", layer);
  const label = el("measure-label", layer);
  const text = el("measure-text", label);
  const close = document.createElement("button");
  close.className = "measure-close";
  close.textContent = "✕";
  close.setAttribute("aria-label", "측정 지우기");
  label.appendChild(close);

  let on = false;
  let a = null; // {logical, price}
  let b = null;
  let dragging = false;
  let waitingB = false;
  let start = null;
  let shiftDrag = false;

  function point(e) {
    const r = box.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const logical = chart.timeScale().coordinateToLogical(x);
    const price = getSeries().coordinateToPrice(y);
    if (logical == null || price == null) return null;
    return { logical: Math.round(logical), price, x, y };
  }

  const show = (elm, v) => (elm.style.display = v ? "" : "none");

  function barTime(i) {
    const bars = getBars();
    const k = bars[Math.max(0, Math.min(bars.length - 1, i))];
    return k?.t;
  }

  function draw() {
    if (!a) {
      show(rect, false);
      show(dotA, false);
      show(label, false);
      return;
    }
    const ts = chart.timeScale();
    const series = getSeries();
    const xa = ts.logicalToCoordinate(a.logical);
    const ya = series.priceToCoordinate(a.price);
    if (xa == null || ya == null) return;
    show(dotA, true);
    dotA.style.transform = `translate(${xa - 6}px, ${ya - 6}px)`;
    if (!b || waitingB) {
      show(rect, false);
      show(label, true);
      label.className = "measure-label hint";
      text.textContent = "끝점을 누르세요";
      place(xa, ya, true);
      return;
    }
    const xb = ts.logicalToCoordinate(b.logical);
    const yb = series.priceToCoordinate(b.price);
    if (xb == null || yb == null) return;
    const up = b.price >= a.price;
    show(rect, true);
    rect.className = `measure-rect ${up ? "up" : "down"}`;
    rect.style.transform = `translate(${Math.min(xa, xb)}px, ${Math.min(ya, yb)}px)`;
    rect.style.width = `${Math.max(1, Math.abs(xb - xa))}px`;
    rect.style.height = `${Math.max(1, Math.abs(yb - ya))}px`;

    const d = getDecimals();
    const diff = b.price - a.price;
    const pct = (diff / a.price) * 100;
    const nBars = Math.abs(b.logical - a.logical);
    const ta = barTime(a.logical);
    const tb = barTime(b.logical);
    const sec = ta != null && tb != null ? Math.abs(tb - ta) : 0;
    let line2 = `${nBars}봉 · ${duration(sec)}`;
    // 일·주봉: 1년에 몇 %씩 (연환산), 1년 넘을 때만
    if (isDaily() && sec >= 365 * 86400 && a.price > 0 && b.price > 0) {
      const lo = b.logical >= a.logical ? a.price : b.price;
      const hi = b.logical >= a.logical ? b.price : a.price;
      const cagr = ((hi / lo) ** (365.25 * 86400 / sec) - 1) * 100;
      line2 += ` · 연 ${signed(cagr, 1)}%`;
    }
    show(label, true);
    label.className = `measure-label ${up ? "up" : "down"}`;
    text.textContent = `${up ? "▲" : "▼"} ${signed(pct, 2)}%  (${signed(diff, d)})\n${line2}`;
    place(xb, yb, up);
  }

  function place(x, y, up) {
    const W = box.clientWidth;
    const H = box.clientHeight;
    const lw = label.offsetWidth || 180;
    const lh = label.offsetHeight || 56;
    let lx = x + 10;
    if (lx + lw > W - 70) lx = x - lw - 10;
    let ly = up ? y - lh - 10 : y + 10;
    lx = Math.max(4, Math.min(W - lw - 4, lx));
    ly = Math.max(4, Math.min(H - lh - 4, ly));
    label.style.transform = `translate(${lx}px, ${ly}px)`;
  }

  box.addEventListener(
    "pointerdown",
    (e) => {
      if (e.target === close || e.button !== 0) return;
      shiftDrag = !on && e.shiftKey && e.pointerType === "mouse";
      if (!on && !shiftDrag) return;
      const p = point(e);
      if (!p) return;
      e.stopPropagation();
      e.preventDefault();
      box.setPointerCapture(e.pointerId);
      start = p;
      if (waitingB && a) {
        b = p;
        waitingB = false;
        dragging = false;
        draw();
        return;
      }
      a = p;
      b = p;
      dragging = true;
      draw();
    },
    true
  );
  box.addEventListener(
    "pointermove",
    (e) => {
      if (!dragging) return;
      e.stopPropagation();
      const p = point(e);
      if (p) {
        b = p;
        draw();
      }
    },
    true
  );
  const end = (e) => {
    if (!dragging) return;
    e.stopPropagation();
    dragging = false;
    const r = box.getBoundingClientRect();
    const moved = start && Math.hypot(e.clientX - r.left - start.x, e.clientY - r.top - start.y) > 6;
    waitingB = !moved && !shiftDrag;
    if (!moved && shiftDrag) a = b = null;
    draw();
  };
  box.addEventListener("pointerup", end, true);
  box.addEventListener("pointercancel", end, true);
  close.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    api.clear();
  });

  chart.timeScale().subscribeVisibleLogicalRangeChange(() => draw());

  const api = {
    get on() {
      return on;
    },
    toggle(force) {
      on = force ?? !on;
      box.classList.toggle("measuring", on);
      chart.applyOptions({ handleScroll: !on, handleScale: !on });
      if (!on) {
        dragging = false;
        if (waitingB) {
          waitingB = false;
          a = b = null;
        }
      }
      draw();
      onToggle?.(on);
    },
    clear() {
      a = b = null;
      waitingB = false;
      dragging = false;
      draw();
    },
    /** 왼쪽에 봉이 붙으면 측정 위치도 같이 민다 */
    shift(n) {
      if (a) a.logical += n;
      if (b) b.logical += n;
      draw();
    },
    redraw: draw,
  };
  draw();
  return api;
}
