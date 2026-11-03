// 쉬운 검색: 띄어쓰기·대소문자·기호 무시, 단어 여러 개는 모두 들어간 것만, 초성(ㅋㄷ) 검색,
// 국내 ETF 브랜드 한글 발음(타이거 → TIGER)도 알아듣는다.

// 국내 ETF 브랜드·자주 쓰는 말 → 실제 이름에 쓰이는 표기
const ALIAS = [
  ["타이거", "tiger"], ["코덱스", "kodex"], ["카덱스", "kodex"], ["에이스", "ace"], ["라이즈", "rise"],
  ["킨덱스", "kindex"], ["아리랑", "arirang"], ["하나로", "hanaro"], ["히어로즈", "heroes"],
  ["코세프", "kosef"], ["케이탑", "ktop"], ["파워", "power"], ["마이티", "mighty"], ["트루", "true"],
  ["에스앤피", "s&p"], ["에스엔피", "s&p"], ["에센피", "s&p"], ["쏠", "sol"],
  ["레버", "레버리지"], ["인버", "인버스"],
];

// 많이 찾는 종목: 점수가 같으면 먼저 ("삼성" → 삼성전자가 삼성화재보다 위)
const POPULAR = new Set([
  "005930", "000660", "373220", "207940", "005380", "000270", "068270", "035420", "035720", "005490",
  "051910", "006400", "105560", "055550", "012330", "028260", "247540", "086520", "003550", "066570",
  "069500", "122630", "252670", "233740", "133690", "360750", "379800", "381180",
  "QQQ", "TQQQ", "SPY", "SOXL", "NVDA", "AAPL", "TSLA", "MSFT", "AMD", "bn:BTCUSDT", "bn:ETHUSDT",
]);

const STRIP = /[\s\-_.()·,&'"/[\]+]/g;

export function norm(s) {
  return String(s ?? "").normalize("NFC").toLowerCase().replace(STRIP, "");
}

const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

/** 한글 초성만 뽑기: "삼성전자" → "ㅅㅅㅈㅈ" */
export function chosung(s) {
  let out = "";
  for (const ch of String(s ?? "")) {
    const c = ch.charCodeAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) out += CHO[Math.floor((c - 0xac00) / 588)];
    else if (!/\s/.test(ch)) out += ch.toLowerCase();
  }
  return out;
}

function expandAlias(token) {
  let t = token;
  for (const [ko, en] of ALIAS) if (t.includes(ko)) t = t.replace(ko, norm(en));
  return t;
}

/** 검색어 → 판별 함수 + 점수 함수 */
export function makeQuery(text) {
  const raw = String(text ?? "").trim();
  const tokens = raw
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      const n = norm(t);
      return { n, alias: expandAlias(n), cho: /^[ㄱ-ㅎ]+$/.test(t) ? t : null };
    });
  const whole = norm(raw);

  /** idx: {key: 정규화된 이름+심볼, cho: 초성, name, symbol} */
  const test = (idx) =>
    tokens.length > 0 &&
    tokens.every((t) => (t.cho ? idx.cho.includes(t.cho) : idx.key.includes(t.n) || idx.key.includes(t.alias)));

  // 점수: 심볼 정확히 일치 > 이름이 검색어로 시작 > 이름에 포함, 짧은 이름 우선
  const score = (idx) => {
    const sym = norm(idx.symbol);
    const name = norm(idx.name);
    let s = 3;
    if (sym === whole || (idx.label && norm(idx.label) === whole)) s = 0; // 화면 이름(SPX, BTC)을 정확히 쳐도 맨 위
    else if (name === whole) s = 0.5;
    else if (name.startsWith(whole) || sym.startsWith(whole)) s = 1;
    else if (name.includes(whole)) s = 2;
    return s + name.length / 200 - (POPULAR.has(idx.symbol) ? 0.2 : 0);
  };
  return { test, score, empty: tokens.length === 0 };
}

/** 검색용 색인 만들기 */
export function indexOf(name, symbol, extra = "", label = "") {
  return { key: norm(`${name}|${symbol}|${extra}|${label}`), cho: chosung(name), name, symbol, label };
}
