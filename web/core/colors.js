// 오름·내림 색 (FAKE TRADING 0.13.0, 사용자 요청 2026-11-01: "한국식·미국식 자유자재로")
// 한국식(기본) = 빨강 오름·파랑 내림, 미국식 = 초록 오름·빨강 내림 (트레이딩뷰 기본)
// 바꾸면 차트 봉·거래량·지표의 오름/내림 표시·범례 %·매수/매도 버튼·롱/숏 선·거래 기록 손익이 같이 바뀐다
// (CSS는 --up/--down 변수, 그림은 upColor()/downColor()를 그릴 때마다 읽는다)

export const CANDLE_STYLES = {
  kr: { up: "#ff4d4f", down: "#3d8bff", tp: "#26c281" },
  // 미국식은 익절선이 초록 봉에 묻히지 않게 하늘색
  us: { up: "#26a69a", down: "#ef5350", tp: "#5ec8d8" },
};

let cur = CANDLE_STYLES.kr;

export const upColor = () => cur.up;
export const downColor = () => cur.down;
export const tpColor = () => cur.tp;

/** "#rrggbb" + 투명도 → "rgba(r,g,b,a)" */
export function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** "kr" | "us" → 색 바꾸기 (화면의 CSS 변수까지). 차트는 다시 그려야 바뀐다 (main.js) */
export function setCandleStyle(name) {
  cur = CANDLE_STYLES[name] ?? CANDLE_STYLES.kr;
  if (typeof document !== "undefined") {
    const s = document.documentElement.style;
    s.setProperty("--up", cur.up);
    s.setProperty("--down", cur.down);
  }
}
