// 국내 종목 무기한선물(달러) → 원화 추정 (0.30.0, 사용자 요청 2026-11-25)
// 이 선물들은 "국내 1주 가격 ÷ 원달러"로 움직인다 (2026-11-24 15:29 확인: 하이닉스·삼성 0.3%, 현대차 0.1% 차이)
// → 원화 ≈ 선물 가격 × 원달러. 대략 보는 값이라 리플레이는 그 전날 환율, 주말은 마지막 환율로 충분하다 (사용자 결정)
// 순수 계산만 (화면은 ui/cell.js)

const H = 3600;

// 국내 종목 → 그 종목 선물 (바이낸스 · OKX · 하이퍼리퀴드). 사용자가 고른 4종목
// 하이닉스 ADR(바이낸스 SKHYUSDT · 하이퍼리퀴드 xyz:SKHY, $112쯤)은 국내 1주 가격이 아니라서 뺀다
// 2배 상품(CSOP…2L)은 홍콩 상장이라 뺀다
const MAP = {
  "000660.KS": ["bn:SKHYNIXUSDT", "ok:SKHYNIX-USDT-SWAP", "hl:xyz:SKHX"],
  "005930.KS": ["bn:SAMSUNGUSDT", "ok:SAMSUNG-USDT-SWAP", "hl:xyz:SMSN"],
  "005380.KS": ["bn:HYUNDAIUSDT", "ok:HYUNDAI-USDT-SWAP", "hl:xyz:HYUNDAI"],
  "035420.KS": ["bn:NAVERUSDT", "ok:NAVER-USDT-SWAP"], // 하이퍼리퀴드엔 없음 (2026-11-25 확인)
};
const KRX_OF = new Map(Object.entries(MAP).flatMap(([krx, ids]) => ids.map((id) => [id, krx])));

/** 선물 id → 국내 종목 id (원화 딱지를 붙이는 선물이 아니면 null) */
export const krxOf = (id) => KRX_OF.get(id) ?? null;

/** 국장 일봉 날짜(그날 0시) + 6.5시간 = 15:30 KST(06:30 UTC) 마감 */
export const KRX_CLOSE = 6.5 * H;

/** 국장 호가 단위 (2023-01-25부터 코스피·코스닥 같음) */
export function krxTick(p) {
  return p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000;
}

/** 원화를 국장 호가 단위로 맞춰서 세 자리마다 쉼표: 1096294 → "1,096,000" (사용자 요청: 쉼표가 있어야 바로 읽힌다) */
export function krwText(p) {
  if (!(p > 0)) return "";
  const t = krxTick(p);
  return String(Math.round(p / t) * t).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 시간순 봉에서 t(초) 전에 끝난 마지막 봉 (끝 = 봉 시각 + span) — 미래 값을 안 본다 */
export function lastBefore(rows, t, span) {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].t + span <= t) return rows[i];
  return null;
}
