// 📋 차트 이미지 복사 (0.18.0, 사용자: "우측 마우스 복사하면 세번째 사진처럼 · 분할이면 다 같이 한 장으로 카톡에 공유")
// 브라우저 기본 "복사"는 마우스 아래 위쪽 캔버스(십자선·그린 선, 나머지는 투명)만 복사해서 흰 바탕이 됐다.
// 차트 그림(takeScreenshot)에는 머리줄·범례가 없다 (화면 글자라서) → 글자와 테두리를 캔버스에 옮겨 그려 칸 모양 그대로 한 장을 만든다

const SKIP = "button, .dw-bar"; // 누르는 것은 그림에 넣지 않는다 (✕, ⏩ 지금으로, 📌 고정, 그림 도구 막대)
const BG = "#0b0d10"; // 차트 배경 (cell.js)
const SPLIT_LINE = "#161a20"; // 분할 칸 테두리 (styles.css #grid.multi .cell)

const isClear = (c) => c === "transparent" || /^rgba\(.*,\s*0\)$/.test(c);

/** 배경·테두리 (이름표 상자, 측정 도구, 알림 글자 등) */
function paintBox(g, el, cs) {
  const fill = !isClear(cs.backgroundColor);
  const line = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none" && !isClear(cs.borderTopColor);
  if (!fill && !line) return;
  const r = el.getBoundingClientRect();
  g.beginPath();
  g.roundRect(r.left, r.top, r.width, r.height, parseFloat(cs.borderTopLeftRadius) || 0);
  if (fill) {
    g.fillStyle = cs.backgroundColor;
    g.fill();
  }
  if (line) {
    g.strokeStyle = cs.borderTopColor;
    g.lineWidth = parseFloat(cs.borderTopWidth);
    g.stroke();
  }
}

/** 낱말마다 화면 위치를 읽어 그린다 → 줄바꿈·겹친 빈칸이 화면과 같다 */
function paintText(g, node, cs) {
  g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  g.fillStyle = cs.color;
  const range = document.createRange();
  for (const m of node.nodeValue.matchAll(/\S+/g)) {
    range.setStart(node, m.index);
    range.setEnd(node, m.index + m[0].length);
    const r = range.getClientRects()[0];
    if (!r) continue;
    const { fontBoundingBoxAscent: up, fontBoundingBoxDescent: down } = g.measureText(m[0]);
    g.fillText(m[0], r.left, r.top + (r.height - up - down) / 2 + up);
  }
}

function paintNode(g, el, chartEl) {
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return;
  paintBox(g, el, cs);
  g.save();
  if (cs.overflowX !== "visible") {
    const r = el.getBoundingClientRect();
    g.beginPath();
    g.rect(r.left, r.top, r.width, r.height);
    g.clip();
  }
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) paintText(g, n, cs);
    else if (n.nodeType === Node.ELEMENT_NODE && n !== chartEl && !n.matches(SKIP)) paintNode(g, n, chartEl);
  }
  g.restore();
}

/** list: [{root: 칸, chart: 차트 요소, shot: takeScreenshot 그림}] → 화면 배치 그대로 한 장 */
export function composeCells(list) {
  const rects = list.map((c) => c.root.getBoundingClientRect());
  const x0 = Math.min(...rects.map((r) => r.left));
  const y0 = Math.min(...rects.map((r) => r.top));
  const k = list[0].shot.width / list[0].chart.getBoundingClientRect().width; // 화면 1칸 = 그림 몇 칸 (윈도우 배율·앱 글자 크기)
  const out = document.createElement("canvas");
  out.width = Math.round((Math.max(...rects.map((r) => r.right)) - x0) * k);
  out.height = Math.round((Math.max(...rects.map((r) => r.bottom)) - y0) * k);
  const g = out.getContext("2d");
  g.fillStyle = BG;
  g.fillRect(0, 0, out.width, out.height); // 불투명 바탕: 붙여 넣는 곳에서 흰색이 비치지 않게
  g.scale(k, k);
  g.translate(-x0, -y0);
  list.forEach((c, i) => {
    const r = c.chart.getBoundingClientRect();
    g.drawImage(c.shot, r.left, r.top, r.width, r.height);
    for (const n of c.root.children) if (!n.matches(SKIP)) paintNode(g, n, c.chart);
    if (list.length > 1) {
      g.strokeStyle = SPLIT_LINE;
      g.lineWidth = 2;
      g.strokeRect(rects[i].left + 1, rects[i].top + 1, rects[i].width - 2, rects[i].height - 2);
    }
  });
  return out;
}
