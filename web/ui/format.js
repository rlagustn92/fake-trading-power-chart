// 숫자 표시 규칙: 천 단위 콤마, 상승 빨강 ▲ / 하락 파랑 ▼ / 보합 회색 (Market Board와 같음)

const fmts = new Map();

export function num(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  let f = fmts.get(d);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    fmts.set(d, f);
  }
  return f.format(v);
}

/** 가격 크기에 맞는 소수점 자리 (종목별로 정해진 게 있으면 그것) */
export function decimalsFor(info, price) {
  if (info?.yieldLike) return 3;
  if (info?.kind === "kr" || (info?.currency === "KRW" && info?.kind === "index")) return info.kind === "kr" ? 0 : 2;
  if (info?.kind === "sentiment") return info.id === "cnn:FEAR_GREED" ? 1 : 2;
  const p = Math.abs(price ?? 0);
  if (p >= 10000) return 1;
  if (p >= 1) return 2;
  if (p >= 0.1) return 4;
  if (p >= 0.001) return 5;
  return 8;
}

export function signed(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = num(Math.abs(v), d);
  if (s === num(0, d)) return s;
  return (v > 0 ? "+" : "-") + s;
}

export function dir(v, eps = 0) {
  return v > eps ? "up" : v < -eps ? "down" : "flat";
}

export function arrow(v) {
  return v > 0 ? "▲" : v < 0 ? "▼" : "";
}

/** 큰 수 줄이기: 1,234,567 → 1.23M */
export function compact(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${num(v / 1e9, 2)}B`;
  if (a >= 1e6) return `${num(v / 1e6, 2)}M`;
  if (a >= 1e4) return `${num(v / 1e3, 1)}K`;
  return num(v, 0);
}

/** 원화 금액: 12,345,678 → 1,234만 / 1.23억 */
export function won(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (a >= 1e8) return `${s}${num(a / 1e8, 2)}억`;
  if (a >= 1e4) return `${s}${num(Math.round(a / 1e4), 0)}만`;
  return `${s}${num(a, 0)}`;
}

const pad = (n) => String(n).padStart(2, "0");

/** 차트 시각(현지 시각으로 옮겨 둔 값) → yy-mm-dd HH:mm */
export function chartTime(time, withClock) {
  const d = new Date(time * 1000);
  const date = `${pad(d.getUTCFullYear() % 100)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return withClock ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : date;
}

/** 지금 PC 시각 HH:mm */
export function clock(ms = Date.now()) {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 텍스트가 바뀔 때만 DOM에 쓴다 */
export function setText(el, s) {
  if (el._t !== s) {
    el._t = s;
    el.textContent = s;
  }
}

export function setClass(el, name, on) {
  if (el.classList.contains(name) !== !!on) el.classList.toggle(name, !!on);
}

/** 기간: 초 → "3년 2개월" / "45일" / "3시간 20분" */
export function duration(sec) {
  const d = Math.floor(sec / 86400);
  if (d >= 365) {
    const y = Math.floor(d / 365.25);
    const m = Math.floor((d - y * 365.25) / 30.44);
    return m ? `${y}년 ${m}개월` : `${y}년`;
  }
  if (d >= 60) return `${Math.floor(d / 30.44)}개월 ${Math.round(d % 30.44)}일`;
  const h = Math.floor((sec % 86400) / 3600);
  const mi = Math.floor((sec % 3600) / 60);
  if (d) return h ? `${d}일 ${h}시간` : `${d}일`;
  if (h) return mi ? `${h}시간 ${mi}분` : `${h}시간`;
  return `${mi}분`;
}
