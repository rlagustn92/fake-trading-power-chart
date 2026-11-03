// 차트 위 주문선 (기획서 §4-2): 평단선 + 익절선·손절선. 선이나 이름표를 잡고 위아래로 끈다.
// prototype/orderlines.html에서 확인한 방식 그대로 (원본 그리기 도구 drawings/layer.js와 같은 길):
// - 선은 차트 가격선, 이름표는 primitive로 캔버스에 그리고 누르기 판정 상자를 기억한다
// - 누르기는 칸(root)에서 차트·그리기 도구보다 먼저(capture) 받아 막고, 끄는 동안 차트 이동·가격 눈금을 멈춘다
// - 가격선은 자동 눈금에 안 들어가므로 autoscaleInfoProvider로 선을 범위에 넣는다 (익절선이 화면 밖으로 나가지 않게)
//   단 봉이 있는 범위에서 너무 먼 선은 안 넣는다 → 멀리 끌어 둔 손절선 때문에 차트가 납작해지지 않게.
//   화면 밖 선은 이름표를 위·아래 끝에 ▲▼로 붙여 두고, 그 이름표를 잡고 끌면 다시 화면 안으로 온다
// - 끄는 동안에는 마우스를 차트 안 높이로만 받는다. 전에는 창 밖까지 끌면서 재생하면 "선이 눈금을 늘리고 →
//   늘어난 눈금이 선을 더 밀어 올리는" 일이 반복돼 선이 끝없이 도망갔다 (사용자가 겪은 차트 사라짐, 2026-10-30)
// - 오른쪽 클릭 = 그 선 켜기·끄기 (onToggle). 꺼진 익절·손절선은 체결되지 않는다

const FONT = '600 15px "Segoe UI", "Malgun Gothic", sans-serif';
const LABEL_H = 30;
const GAP = 32; // 선끼리 가까우면 이름표를 위에서부터 이만큼씩 비켜 놓는다 (선은 제자리)
const GRAB = 7; // 선 위아래 이 픽셀 안을 누르면 잡힌다
const ROOM = 40; // 이름표 자리: 마지막 봉 오른쪽을 이만큼(봉 수) 비워 둔다 (원래 칸은 6)
const REACH = 0.5; // 봉 범위(높이)의 이만큼 바깥까지의 선만 자동 눈금에 넣는다

/**
 * @param list     () => [{key, price, color, text, drag, style, scale, toggle}]  지금 그릴 선 (화면 갱신 때마다 부른다).
 *                 scale: false = 자동 눈금에 안 넣음, toggle: true = 오른쪽 클릭으로 켜고 끔
 * @param onDrag   (key, price) => void  끄는 동안 (가격 정리·제한은 받는 쪽이)
 * @param onToggle (key) => void  오른쪽 클릭
 */
export function createOrderLines({ list, onDrag, onToggle }) {
  let cell = null;
  let main = null;
  let lines = new Map(); // key → 가격선
  let boxes = []; // 이름표 누르기 상자
  let drag = null;
  let scaleHeld = false;
  let offset0 = null; // 붙이기 전 칸의 오른쪽 빈칸 (떼면 돌려놓는다)
  let paneH = 0; // 가격 창 높이 (마지막으로 그릴 때)
  const ok = (p) => Number.isFinite(p) && p > 0;

  const views = [{ zOrder: () => "top", renderer: () => ({ draw: (t) => draw(t) }) }];
  const prim = {
    attached: ({ requestUpdate }) => (prim.req = requestUpdate),
    detached: () => (prim.req = null),
    updateAllViews() {},
    paneViews: () => views,
    // 커서를 위아래 화살표로 (실제 끌기는 아래 pointer 이벤트가 한다)
    hitTest: (x, y) => {
      const key = hitKey(x, y);
      return key ? { cursorStyle: "ns-resize", externalId: key, zOrder: "top" } : null;
    },
  };

  function draw(target) {
    if (!cell || !main) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      boxes = [];
      paneH = mediaSize.height;
      ctx.font = FONT;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      // 가격 눈금 바로 왼쪽에 붙인다 (차트를 옆으로 옮겨도 이름표는 제자리. 가격은 눈금 쪽 꼬리표에 보인다)
      // 화면 밖 선은 위·아래 끝에 ▲▼로 (끌 수 있는 선만 — 청산가선 같은 것은 숨긴다)
      const top = LABEL_H / 2 + 2;
      const bot = mediaSize.height - LABEL_H / 2 - 2;
      const items = list()
        .filter((L) => ok(L.price))
        .map((L) => {
          const y = main.priceToCoordinate(L.price);
          if (y == null) return null;
          const off = y < top ? "▲ " : y > bot ? "▼ " : "";
          if (off && !L.drag) return null;
          return { ...L, off, ly: Math.min(bot, Math.max(top, y)) };
        })
        .filter(Boolean)
        .sort((a, b) => a.ly - b.ly);
      for (let k = 1; k < items.length; k++) items[k].ly = Math.max(items[k].ly, items[k - 1].ly + GAP);
      for (const L of items) {
        const text = L.off + (L.drag ? "⇕ " : "") + L.text;
        const w = ctx.measureText(text).width + 22;
        const x = Math.max(4, mediaSize.width - w - 8);
        const y = L.ly - LABEL_H / 2;
        ctx.fillStyle = "rgba(18, 21, 26, 0.94)";
        ctx.strokeStyle = L.color;
        ctx.lineWidth = L.drag ? 2 : 1;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, w, LABEL_H, 7);
        else ctx.rect(x, y, w, LABEL_H);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = L.color;
        ctx.fillText(text, x + 9, L.ly + 1);
        if (L.drag) boxes.push({ key: L.key, x, y, w, h: LABEL_H });
      }
    });
  }

  /** 이 자리에 끌 수 있는 선(또는 이름표)이 있나 → key | null */
  function hitKey(x, y) {
    if (!main) return null;
    for (const b of boxes) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.key;
    for (const L of list()) {
      if (!L.drag || !ok(L.price)) continue;
      const ly = main.priceToCoordinate(L.price);
      if (ly != null && Math.abs(ly - y) <= GRAB) return L.key;
    }
    return null;
  }

  /** 가격선 맞추기 (없어진 선은 지운다) */
  function syncLines() {
    if (!main) return;
    const want = new Map(list().filter((L) => ok(L.price)).map((L) => [L.key, L]));
    for (const [key, pl] of lines) {
      if (!want.has(key)) {
        main.removePriceLine(pl);
        lines.delete(key);
      }
    }
    for (const [key, L] of want) {
      const o = { price: L.price, color: L.color, lineWidth: 2, lineStyle: L.style ?? 0, axisLabelVisible: true, title: "" };
      if (lines.has(key)) lines.get(key).applyOptions(o);
      else lines.set(key, main.createPriceLine(o));
    }
  }

  // ── 끌기 ──
  const body = () => cell?.root.querySelector(".cell-body");
  const local = (e) => {
    const r = body().getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  // 끄는 동안에는 가격 눈금도 멈춘다 (선을 따라 눈금이 늘어나면 마우스 아래 가격이 바뀌어 선이 도망간다).
  // 놓은 뒤 바로 다시 맞추면 차트 전체가 휙 바뀌어 어색하므로 다음 봉이 올 때 맞춘다 (resumeScale)
  function lockChart(on) {
    cell.chart.applyOptions({ handleScroll: !on, handleScale: !on });
    if (on) {
      main.priceScale().applyOptions({ autoScale: false });
      scaleHeld = true;
    }
  }
  function resumeScale() {
    if (!scaleHeld || !main || drag) return; // 끄는 중에는 눈금을 계속 멈춘다 (재생이 돌아도)
    scaleHeld = false;
    main.priceScale().applyOptions({ autoScale: true });
  }

  function onDown(e) {
    if (!cell || !body()?.contains(e.target)) return;
    if (e.button !== 0 && e.button !== 2) return;
    const p = local(e);
    if (p.x > cell.chart.timeScale().width()) return; // 가격 눈금 위는 차트에 맡긴다
    const key = hitKey(p.x, p.y);
    if (!key) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.button === 2) {
      // 오른쪽 클릭 = 켜기·끄기 (그리기 도구의 "우클릭 = 취소"보다 먼저)
      if (list().find((L) => L.key === key)?.toggle) onToggle?.(key);
      return;
    }
    drag = { key };
    try {
      cell.root.setPointerCapture(e.pointerId);
    } catch {} // 펜·터치 등에서 못 잡아도 끌기는 된다
    lockChart(true);
  }
  function onMove(e) {
    if (!drag) return;
    e.stopImmediatePropagation();
    // 차트 높이 안으로만 (창 밖까지 끌어도 맨 위·맨 아래 가격에서 멈춘다)
    const y = Math.min(Math.max(local(e).y, 1), Math.max(1, (paneH || body().clientHeight) - 1));
    const price = main.coordinateToPrice(y);
    if (ok(price)) onDrag(drag.key, price);
  }
  function onUp(e) {
    if (!drag) return;
    e.stopImmediatePropagation();
    drag = null;
    lockChart(false);
  }
  // 선 위에서 오른쪽 클릭 메뉴가 뜨지 않게
  function onMenu(e) {
    if (!cell || !body()?.contains(e.target)) return;
    const p = local(e);
    if (hitKey(p.x, p.y)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  const EVENTS = [["pointerdown", onDown], ["pointermove", onMove], ["pointerup", onUp], ["pointercancel", onUp], ["contextmenu", onMenu]];

  // 익절·손절이 화면 밖으로 나가지 않게 자동 눈금 범위에 넣는다 (scale: false인 선은 빼고 — 멀리 있는 청산가선).
  // 봉이 있는 범위에서 너무 먼 선(REACH 바깥)은 안 넣는다 → 화면 끝에 ▲▼ 이름표로만
  const autoscale = (orig) => {
    const r = orig();
    if (!r || !cell) return r;
    const lo = r.priceRange.minValue;
    const hi = r.priceRange.maxValue;
    const reach = (hi - lo) * REACH;
    for (const L of list()) {
      if (L.scale === false || !ok(L.price) || L.price < lo - reach || L.price > hi + reach) continue;
      r.priceRange.minValue = Math.min(r.priceRange.minValue, L.price);
      r.priceRange.maxValue = Math.max(r.priceRange.maxValue, L.price);
    }
    return r;
  };

  return {
    /** 칸에 붙이기 (칸의 차트 시리즈가 새로 만들어졌을 때도 다시 부른다: 봉·차트 종류를 바꾸면) */
    attach(c) {
      if (cell !== c) {
        this.detach();
        cell = c;
        for (const [n, f] of EVENTS) c.root.addEventListener(n, f, true);
        // 마지막 봉 오른쪽을 넉넉히 비워 이름표가 봉을 덜 가리게
        offset0 = c.chart.timeScale().options().rightOffset;
        c.chart.timeScale().applyOptions({ rightOffset: Math.max(offset0, ROOM) });
      } else if (main && main !== c.main) {
        try {
          main.detachPrimitive(prim);
        } catch {}
      }
      if (main !== c.main) {
        main = c.main;
        lines = new Map(); // 옛 시리즈의 선은 시리즈와 같이 사라졌다
        scaleHeld = false;
        main.attachPrimitive(prim);
        main.applyOptions({ autoscaleInfoProvider: autoscale });
      }
      this.refresh();
    },
    detach() {
      if (!cell) return;
      if (drag) {
        drag = null;
        cell.chart.applyOptions({ handleScroll: true, handleScale: true });
      }
      resumeScale();
      for (const [n, f] of EVENTS) cell.root.removeEventListener(n, f, true);
      try {
        if (offset0 != null) cell.chart.timeScale().applyOptions({ rightOffset: offset0 });
        for (const pl of lines.values()) main.removePriceLine(pl);
        main.detachPrimitive(prim);
      } catch {} // 칸이 이미 없어졌으면
      offset0 = null;
      lines = new Map();
      boxes = [];
      cell = null;
      main = null;
    },
    refresh() {
      if (!cell) return;
      if (main !== cell.main) return this.attach(cell);
      syncLines();
      prim.req?.();
    },
    resumeScale,
    get cell() {
      return cell;
    },
    get dragging() {
      return !!drag;
    },
    hitKey,
  };
}
