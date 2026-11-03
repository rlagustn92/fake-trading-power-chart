// 종목 id 규칙 (SPEC §6) → 어디서 받는지, 어느 시간대인지, 거래량이 있는지 등을 한곳에서 정한다.
//   QQQ, AAPL           미국 주식·ETF  (일봉 Yahoo, 분봉 Alpaca)
//   005930.KS, 247540.KQ 국내 주식·ETF  (Yahoo)
//   ^NDX ^GSPC ^VIX ^TNX ^KS11  지수·금리 (Yahoo)
//   KRW=X               환율 (Yahoo)
//   NQ=F                선물 (Yahoo)
//   hl:xyz:XYZ100       Hyperliquid 무기한선물
//   bn:QQQUSDT          Binance 무기한선물
//   cboe:PC_EQUITY      풋/콜 비율 (CBOE)    cnn:FEAR_GREED  공포·탐욕 (CNN)
//   ratio:SOXL/AMD      비율 차트 (§3.7)

const H = 3600;

// 기본 종목의 알아보기 쉬운 이름 (목록에 한글 이름이 없는 미국 ETF·지수)
const NAMES = {
  QQQ: "나스닥100 ETF",
  QLD: "나스닥100 2배",
  TQQQ: "나스닥100 3배",
  SQQQ: "나스닥100 -3배",
  PSQ: "나스닥100 -1배",
  SPY: "S&P500 ETF",
  VOO: "S&P500 ETF (뱅가드)",
  IVV: "S&P500 ETF (아이셰어즈)",
  SSO: "S&P500 2배",
  UPRO: "S&P500 3배",
  SPXL: "S&P500 3배",
  SPXU: "S&P500 -3배",
  SOXX: "반도체 ETF",
  SMH: "반도체 ETF (반에크)",
  SOXL: "반도체 3배",
  SOXS: "반도체 -3배",
  USD: "반도체 2배",
  TECL: "기술주 3배",
  FNGU: "빅테크 3배",
  SCHD: "미국 배당 ETF",
  JEPI: "커버드콜 배당 ETF",
  TLT: "미국 장기채 ETF",
  TMF: "미국 장기채 3배",
  GLD: "금 ETF",
  DIA: "다우 ETF",
  IWM: "러셀2000 ETF",
  AMD: "AMD",
  NVDA: "엔비디아",
  "^NDX": "나스닥100 지수",
  "^IXIC": "나스닥 종합지수",
  "^GSPC": "S&P500 지수",
  "^DJI": "다우 지수",
  "^RUT": "러셀2000 지수",
  "^SOX": "필라델피아 반도체 지수",
  "^VIX": "VIX 공포지수",
  "^TNX": "미국채 10년 금리",
  "^TYX": "미국채 30년 금리",
  "^FVX": "미국채 5년 금리",
  "^KS11": "한국 종합주가지수 (KOSPI)",
  "^KQ11": "코스닥 지수 (KOSDAQ)",
  "KRW=X": "원/달러 환율",
  "JPYKRW=X": "엔/원 환율",
  "DX-Y.NYB": "달러 인덱스",
  "NQ=F": "나스닥100 선물 (CME)",
  "ES=F": "S&P500 선물 (CME)",
  "GC=F": "금 선물",
  "CL=F": "WTI 원유 선물",
  "bn:BTCUSDT": "비트코인 (Binance 실시간)",
  "bn:ETHUSDT": "이더리움 (Binance 실시간)",
  "bn:SOLUSDT": "솔라나 (Binance 실시간)",
  "bn:XRPUSDT": "리플 (Binance 실시간)",
  "hl:BTC": "비트코인 (Hyperliquid 실시간)",
  "hl:xyz:XYZ100": "나스닥100 선물",
  "hl:xyz:SP500": "S&P500 선물",
  "hl:xyz:KR200": "코스피200 선물",
  "cboe:PC_EQUITY": "풋/콜 비율 (주식)",
  "cboe:PC_TOTAL": "풋/콜 비율 (전체)",
  "cnn:FEAR_GREED": "공포·탐욕 지수",
};

// 짧게 보이는 코드 (차트 칸 머리줄)
const SHORT = {
  "bn:BTCUSDT": "BTC",
  "bn:ETHUSDT": "ETH",
  "bn:SOLUSDT": "SOL",
  "bn:XRPUSDT": "XRP",
  "hl:BTC": "BTC (HL)",
  "hl:xyz:XYZ100": "NQ 24h",
  "hl:xyz:SP500": "ES 24h",
  "hl:xyz:KR200": "KR200 24h",
  "cboe:PC_EQUITY": "P/C",
  "cboe:PC_TOTAL": "P/C 전체",
  "cnn:FEAR_GREED": "F&G",
  "KRW=X": "USD/KRW",
  "^TNX": "US10Y",
  "^KS11": "코스피",
  "^KQ11": "코스닥",
  "^KS200": "코스피200",
  "^GSPC": "SPX",
  "^TYX": "US30Y",
  "^FVX": "US05Y",
};

/** 검색에 기본으로 나오는 종목 (지수·금리·환율·선물·심리 지표 등) */
export const BUILTIN = Object.keys(NAMES);

let stockNames = new Map(); // 목록의 한글 이름: "005930.KS" → 삼성전자, "NVDA" → 엔비디아

export function setStockNames(map) {
  stockNames = map;
}

const KR_INDEX = new Set(["^KS11", "^KQ11", "^KS200"]);

/** id → 종목 정보 (빈 칸 null도 받는다) */
export function describe(id) {
  id ??= "";
  const info = {
    id,
    kind: "us",
    label: id,
    sub: "",
    tz: "America/New_York", // 일봉 날짜·분봉 묶기 기준 시간대
    dayTz: "America/New_York",
    daily: "yahoo", // 일봉 출처
    intraday: "alpaca", // 분봉 출처
    yahoo: id, // Yahoo 티커
    anchor: 9.5 * H, // 분봉 묶기 기준 시각(현지, 하루 중 초): 정규장 시작
    extAnchor: 4 * H, // 프리·애프터 포함일 때 기준 시각
    rth: [9.5 * H, 16 * H], // 정규장
    volume: true,
    line: false, // 선 차트로만 (심리 지표)
    currency: "USD",
    tfs: ["1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W"],
    yieldLike: false,
    splits: true, // 분할·배당이 있을 수 있음
  };

  if (id.startsWith("ratio:")) {
    const [a, b] = id.slice(6).split("/");
    const A = describe(a);
    const B = describe(b);
    Object.assign(info, {
      kind: "ratio",
      label: `${A.label}/${B.label}`,
      sub: "비율 차트",
      tz: A.tz,
      dayTz: A.dayTz,
      daily: "ratio",
      intraday: A.intraday && B.intraday ? "ratio" : null,
      anchor: A.anchor,
      extAnchor: A.extAnchor,
      rth: A.rth,
      volume: false,
      currency: "",
      parts: [a, b],
      partInfos: [A, B],
      splits: false,
      tfs: A.intraday && B.intraday ? A.tfs.filter((t) => B.tfs.includes(t)) : ["1D", "1W"],
    });
    return info;
  }

  if (id.startsWith("hl:") || id.startsWith("bn:")) {
    const sym = id.slice(3);
    const hl = id.startsWith("hl:");
    Object.assign(info, {
      kind: "perp",
      label: SHORT[id] ?? (hl ? sym.replace(/^xyz:/, "") : `${sym.replace(/USDT$/, "")} 24h`),
      sub: NAMES[id] ?? (hl ? "Hyperliquid 무기한선물" : "Binance 무기한선물"),
      tz: "UTC",
      dayTz: "UTC",
      daily: hl ? "hyperliquid" : "binance",
      intraday: hl ? "hyperliquid" : "binance",
      symbol: sym,
      anchor: 0,
      extAnchor: 0,
      rth: null,
      splits: false,
    });
    return info;
  }

  if (id.startsWith("cboe:") || id.startsWith("cnn:")) {
    Object.assign(info, {
      kind: "sentiment",
      label: SHORT[id] ?? id,
      sub: NAMES[id] ?? "",
      daily: id.startsWith("cboe:") ? "cboe" : "cnn",
      intraday: null,
      volume: false,
      line: true,
      currency: "",
      tfs: ["1D", "1W"],
      splits: false,
      rth: null,
    });
    return info;
  }

  const base = { label: SHORT[id] ?? id, sub: NAMES[id] ?? stockNames.get(id) ?? "" };

  if (/\.(KS|KQ)$/.test(id)) {
    const name = stockNames.get(id);
    Object.assign(info, {
      kind: "kr",
      label: name ?? id,
      sub: id.replace(/\.(KS|KQ)$/, ""),
      tz: "Asia/Seoul",
      dayTz: "Asia/Seoul",
      intraday: "yahoo",
      anchor: 9 * H,
      extAnchor: 9 * H,
      rth: null, // Yahoo 국내 분봉은 정규장만
      currency: "KRW",
    });
    return info;
  }

  if (id.startsWith("^")) {
    // "^"는 Yahoo가 지수 앞에 붙이는 표시 → 화면에는 빼고 보인다 (^NDX → NDX)
    const kr = KR_INDEX.has(id);
    Object.assign(info, base, {
      label: SHORT[id] ?? id.slice(1),
      kind: id === "^TNX" || id === "^TYX" || id === "^FVX" ? "yield" : "index",
      tz: kr ? "Asia/Seoul" : "America/New_York",
      dayTz: kr ? "Asia/Seoul" : "America/New_York",
      intraday: "yahoo",
      anchor: kr ? 9 * H : 9.5 * H,
      extAnchor: kr ? 9 * H : 9.5 * H,
      rth: null,
      volume: false, // 지수는 거래량이 없다(Yahoo가 0 또는 의미 없는 값)
      currency: kr ? "KRW" : "",
      splits: false,
    });
    if (info.kind === "yield") info.yieldLike = true;
    return info;
  }

  if (id.endsWith("=X")) {
    Object.assign(info, base, {
      kind: "fx",
      tz: "UTC",
      dayTz: "Europe/London", // Yahoo 환율 일봉은 런던 자정 기준 (SPEC §2.1)
      intraday: "yahoo",
      anchor: 0,
      extAnchor: 0,
      rth: null,
      volume: false,
      currency: id === "KRW=X" ? "KRW" : "",
      splits: false,
    });
    return info;
  }

  if (id.endsWith("=F") || id.endsWith("-USD") || id.includes(".NYB")) {
    Object.assign(info, base, {
      kind: "future",
      intraday: "yahoo",
      anchor: 18 * H, // CME 선물은 저녁 6시(ET)에 하루가 시작
      extAnchor: 18 * H,
      rth: null,
      splits: false,
    });
    if (id.endsWith("-USD")) Object.assign(info, { tz: "UTC", dayTz: "UTC", anchor: 0, extAnchor: 0 });
    return info;
  }

  Object.assign(info, base);
  return info;
}

const SRC = { yahoo: "Yahoo", alpaca: "Alpaca", hyperliquid: "Hyperliquid", binance: "Binance", cboe: "CBOE", cnn: "CNN" };

/** 어디서 받는지: {quote: 머리줄에 보이는 짧은 이름, text: 현재가·일봉·분봉 출처 설명} */
export function sourcesOf(info, alpaca, toss = false) {
  if (info.kind === "ratio") return { quote: "계산", text: `두 종목 값을 나눠서 계산해요\n${info.partInfos.map((p) => `${p.label}: ${sourcesOf(p, alpaca).quote}`).join("\n")}` };
  const us = info.intraday === "alpaca";
  const quote = us && alpaca ? "Alpaca" : SRC[info.daily];
  const lines = [`현재가: ${us && alpaca ? "Alpaca (IEX 거래소 실시간)" : quote}`, `일봉: ${SRC[info.daily]}`];
  if (toss && (info.kind === "kr" || info.id === "^KS11" || info.id === "^KQ11")) lines[0] = "현재가: 장중에는 Toss 실시간 (Market Board와 같은 키), 장 밖에는 Yahoo";
  if (toss && us) lines[0] = `현재가: 1순위 Toss (주간·프리·정규·애프터) → 2순위 ${alpaca ? "Alpaca 실시간" : "Yahoo"}`;
  if (us) lines.push(alpaca ? "분봉: Alpaca (전체 거래소 · 최근 15분은 IEX)" : "분봉: Alpaca 키가 있어야 받아요 (⚙ 설정 → 데이터)");
  else if (toss && info.kind === "kr") lines.push("분봉: Yahoo (30일) + 장중 최근 1시간은 Toss 1분봉");
  else if (info.intraday) lines.push(`분봉: ${SRC[info.intraday]}`);
  return { quote, text: lines.join("\n") };
}

/** 관심종목·머리줄에 보이는 이름 한 줄 */
export function displayName(id) {
  const d = describe(id);
  return d.sub && d.kind !== "kr" ? `${d.label} · ${d.sub}` : d.label;
}

// Yahoo 코인 시세(BTC-USD)는 15분쯤 늦다 → Binance 무기한선물로 연다 (실시간·24시간, 2019년부터)
const CRYPTO = new Set(["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "BNB", "AVAX", "LINK", "DOT", "LTC", "BCH", "TRX", "SUI", "TON"]);

/** 늦는 출처 대신 실시간 출처 id로 (BTC-USD → bn:BTCUSDT) */
export function preferLive(id) {
  const m = /^([A-Z]+)-USDT?$/.exec(id ?? "");
  return m && CRYPTO.has(m[1]) ? `bn:${m[1]}USDT` : id;
}

/** 직접 입력한 글자를 종목 id로 (소문자·공백 정리, 국내 6자리 코드 → .KS) */
export function normalizeInput(s, krMarket) {
  return preferLive(normalizeRaw(s, krMarket));
}

function normalizeRaw(s, krMarket) {
  let t = String(s ?? "").trim();
  if (!t) return null;
  if (/^(hl|bn|cboe|cnn|ratio):/i.test(t)) {
    const [p, ...rest] = t.split(":");
    return `${p.toLowerCase()}:${rest.join(":")}`;
  }
  if (t.includes("/") && !t.startsWith("ratio:")) {
    const [a, b] = t.split("/").map((x) => normalizeRaw(x, krMarket));
    return a && b ? `ratio:${a}/${b}` : null;
  }
  if (/^\d{6}$/.test(t)) return `${t}.${krMarket?.(t) === "KOSDAQ" ? "KQ" : "KS"}`;
  return t.toUpperCase();
}
