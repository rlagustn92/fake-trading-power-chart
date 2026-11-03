// 종목 찾기 (SPEC §2.8, §3.9): 티커·한글 이름·초성·브랜드 발음, 비율 차트(SOXL/AMD), 직접 입력.
// 차트 위에서 그냥 글자를 치면 바로 열린다. Enter = 맨 위 결과, ↑↓로 고르기.
// 위쪽 탭으로 종류를 나눠 볼 수 있다: 미국 주식 · 미국 ETF · 국내 주식 · 국내 ETF · 지수·환율·공포 · Binance · Hyperliquid
import { h } from "./dom.js";
import { makeQuery, indexOf } from "./search.js";
import { getStockList, marketOf } from "../core/stocklist.js";
import { describe, normalizeInput, preferLive } from "../core/symbols.js";
import * as Y from "../sources/yahoo.js";
import * as BN from "../sources/binance.js";
import * as HL from "../sources/hyperliquid.js";

const KIND = { us: "미국", kr: "국내", index: "지수", yield: "금리", fx: "환율", future: "선물", perp: "24시간 선물", sentiment: "심리 지표", ratio: "비율" };

const PERP_SRC = { binance: "Binance", hyperliquid: "Hyperliquid" };
const TF_KEYS = ["1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W"];
const TF_LABEL = { "1m": "1분", "5m": "5분", "15m": "15분", "30m": "30분", "1h": "1시간", "4h": "4시간", "1D": "일", "1W": "주" };

const CATS = [
  ["all", "전체"],
  ["us_stock", "미국 주식"],
  ["us_etf", "미국 ETF"],
  ["kr_stock", "국내 주식"],
  ["kr_etf", "국내 ETF"],
  ["index", "지수·환율·공포"],
  ["bn", "Binance 24시간"],
  ["hl", "Hyperliquid 24시간"],
];

// 탭만 누르고 아무것도 안 쳤을 때 보여 줄 종목
const SUGGEST = {
  us_stock: ["NVDA", "AAPL", "MSFT", "TSLA", "AMD", "AMZN", "GOOGL", "META", "AVGO", "NFLX", "PLTR", "MU", "TSM", "COIN", "MSTR"],
  us_etf: ["QQQ", "QLD", "TQQQ", "SQQQ", "SPY", "VOO", "SSO", "UPRO", "SOXX", "SMH", "SOXL", "SOXS", "SCHD", "JEPI", "TLT", "TMF", "GLD", "IWM", "DIA"],
  kr_stock: ["005930.KS", "000660.KS", "373220.KS", "207940.KS", "005380.KS", "000270.KS", "068270.KS", "035420.KS", "035720.KS", "005490.KS", "051910.KS", "006400.KS", "105560.KS", "012330.KS", "247540.KQ", "086520.KQ"],
  kr_etf: ["069500.KS", "122630.KS", "252670.KS", "233740.KQ", "133690.KS", "360750.KS", "379800.KS", "381180.KS"],
};

/** 이 종목은 어느 탭에 들어가나 */
function catOf(it) {
  const d = describe(it.id);
  if (d.kind === "perp") return d.daily === "binance" ? "bn" : "hl";
  if (["index", "yield", "fx", "future", "sentiment"].includes(d.kind)) return "index";
  const etf = /ETF|ETN/i.test(it.type ?? "");
  if (d.kind === "kr") return etf ? "kr_etf" : "kr_stock";
  if (d.kind === "us") return etf ? "us_etf" : "us_stock";
  return "other";
}

// 무기한선물 전체 목록 (Binance·Hyperliquid, 처음 한 번 받아 둔다)
let perpCatalog = null;
async function perps(names = new Map()) {
  if (perpCatalog) return perpCatalog;
  const [bn, xyz, main] = await Promise.all([BN.symbols().catch(() => new Map()), HL.listAll("xyz"), HL.listAll("")]);
  // Binance 선물 종류 (exchangeInfo underlyingType) → 한글, 보여 줄 순서
  const KIND_KO = { EQUITY: "미국 주식·ETF", KR_EQUITY: "한국 주식", HK_EQUITY: "홍콩 주식", CN_EQUITY: "중국 주식", COMMODITY: "원자재", FX: "환율", INDEX: "지수", PREMARKET: "상장 전 (프리마켓)" };
  const ORDER = ["EQUITY", "KR_EQUITY", "HK_EQUITY", "CN_EQUITY", "COMMODITY", "FX", "INDEX", "PREMARKET"];
  const rank = (u) => (ORDER.includes(u) ? ORDER.indexOf(u) : ORDER.length);
  const out = [];
  const add = (id, base, kind) => {
    const ko = names.get(id) ?? describe(base).sub; // NVDA → 엔비디아, SAMSUNGUSDT → 삼성전자 (설정의 무기한선물 짝)
    const desc = `${ko && ko !== base ? `${ko} · ` : ""}${kind}`;
    out.push({ id, desc, type: "perp", idx: indexOf(`${base} ${desc}`, id, "perp 24시간 무기한", base), coin: kind === "코인" });
  };
  const trad = [...bn].filter(([, x]) => x.type === "TRADIFI_PERPETUAL" || x.underlying === "INDEX").sort((a, b) => rank(a[1].underlying) - rank(b[1].underlying) || a[1].base.localeCompare(b[1].base));
  for (const [sym, x] of trad) add(`bn:${sym}`, x.base, KIND_KO[x.underlying] ?? "기타");
  for (const [sym, x] of bn) if (x.type !== "TRADIFI_PERPETUAL" && x.underlying !== "INDEX" && sym.endsWith("USDT")) add(`bn:${sym}`, x.base, "코인");
  for (const coin of xyz.sort()) add(`hl:${coin}`, coin.replace(/^xyz:/, ""), "주식·지수·원자재");
  for (const coin of main) if (/^[A-Z0-9]+$/.test(coin)) add(`hl:${coin}`, coin, "코인");
  if (out.length) perpCatalog = out;
  return out;
}

export function createPicker(root, { onPick, onAdd, isWatched, onTf = null, perpOf = () => null, perpNames = () => new Map() }) {
  const input = h("input.search", { placeholder: "티커·이름·초성 (예: TQQQ, 삼성전자, ㅅㅅㅈㅈ, 코덱스 레버, SOXL/AMD)", autocomplete: "off", spellcheck: false });
  const tabs = h("div.pick-tabs");
  const list = h("div.pick-list");
  const hint = h("p.hint", "Enter: 맨 위 종목 · ↑↓: 고르기 · ＋: 관심종목에 넣기 · Esc: 닫기");
  const panel = h("div.panel.picker", h("div.pick-head", h("h2", "종목 찾기"), h("button", { onclick: () => close() }, "닫기")), input, tabs, hint, list);
  root.replaceChildren(panel);
  root.addEventListener("pointerdown", (e) => e.target === root && close());

  let items = [];
  let cursor = 0;
  let yahooTimer = 0;
  let seq = 0;
  let cat = "all";

  function paintTabs() {
    tabs.replaceChildren(...CATS.map(([k, label]) => h(`button${k === cat ? ".on" : ""}`, { onclick: () => ((cat = k), paintTabs(), search(), input.focus()) }, label)));
  }

  function row(it, i) {
    const d = describe(it.id);
    const watched = isWatched(it.id);
    if (it.perpFor) return perpRow(it, i, watched);
    if (it.tf) return h(`div.pick-row.pick-tf${i === cursor ? ".cur" : ""}`, { onclick: () => choose(it), onpointerenter: () => setCursor(i) }, h("div.pick-main", h("span.pick-label", `⏱ ${TF_LABEL[it.tf]}봉으로 바꾸기`), h("span.pick-sub", "Enter · 종목을 찾으려면 이어서 치세요 (예: 247540)")));
    const src = d.kind === "perp" ? PERP_SRC[d.daily] : null;
    const sub = [it.direct ? "직접 입력" : null, it.code && it.code !== d.label && !it.code.startsWith("^") ? it.code : null, it.market && !it.builtin && KIND[d.kind] !== it.market ? it.market : null, src, KIND[d.kind], it.type && !["us", "kr", "index", "fx", "perp", "sentiment", "future", "yield"].includes(it.type) ? it.type : null]
      .filter(Boolean)
      .join(" · ");
    const title = d.kind === "kr" ? it.name ?? d.label : `${d.label}${it.desc || d.sub || (it.name && it.name !== d.label) ? `  ${it.desc ?? d.sub ?? it.name}` : ""}`;
    return h(
      `div.pick-row${i === cursor ? ".cur" : ""}`,
      { onclick: () => choose(it), onpointerenter: () => setCursor(i), "data-tip-text": it.id.startsWith("^") ? `지수예요 (Yahoo 코드 ${it.id})\n지수는 사고팔 수 없고, 시장 전체의 흐름을 보는 숫자예요` : src ? `${src} 무기한선물: 24시간, 실시간으로 움직여요` : "" },
      h("div.pick-main", h("span.pick-label", title), h("span.pick-sub", sub)),
      addBtn(it, watched)
    );
  }

  function addBtn(it, watched) {
    return h(
      "button.pick-add",
      {
        disabled: watched,
        onclick: (e) => {
          e.stopPropagation();
          onAdd(it.id);
          render();
        },
        "data-tip-text": watched ? "이미 관심종목에 있어요" : "관심종목에 넣기",
      },
      watched ? "✓" : "＋"
    );
  }

  /** 주식 바로 아래 "↳ 24시간 실시간" 줄 */
  function perpRow(it, i, watched) {
    const base = describe(it.perpFor);
    const src = PERP_SRC[it.src] ?? it.src;
    return h(
      `div.pick-row.pick-perp${i === cursor ? ".cur" : ""}`,
      {
        onclick: () => choose(it),
        onpointerenter: () => setCursor(i),
        "data-tip-text": `${src} 무기한선물 (24시간, 실시간으로 움직여요)\n주식이 아니라 같은 값을 따라가는 상품이라 값이 조금 다를 수 있어요${it.usd ? "\n가격은 달러예요" : ""}`,
      },
      h("div.pick-main", h("span.pick-label", `↳ ${base.label} 24시간 실시간`), h("span.pick-sub", `${src} 무기한선물${it.usd ? " · 달러 가격" : ""}`)),
      addBtn(it, watched)
    );
  }

  /** 앞쪽 결과 중 무기한선물이 있는 주식 밑에 선택지를 끼워 넣는다 */
  function withPerps(list) {
    const out = [];
    list.forEach((it, k) => {
      out.push(it);
      if (k >= 8 || it.perpFor) return;
      const m = perpOf(it.id);
      if (!m || m.via || (m.mult ?? 1) !== 1 || !PERP_SRC[m.source]) return;
      const id = `${m.source === "binance" ? "bn" : "hl"}:${m.symbol}`;
      if (!list.some((x) => x.id === id)) out.push({ id, perpFor: it.id, src: m.source, usd: m.fx === "KRW" });
    });
    return out;
  }

  function render() {
    const perpTab = cat === "bn" || cat === "hl";
    list.replaceChildren(...(perpTab && items.length ? [h("p.hint", `${items.length}개 · 위에서 이름을 치면 바로 찾아요`)] : []), ...items.slice(0, perpTab ? 1200 : 40).map(row));
    if (!items.length) list.append(h("p.hint", input.value.trim() ? "이 탭에는 찾는 종목이 없어요 · '전체' 탭도 봐 주세요" : "받는 중…"));
    list.querySelector(".cur")?.scrollIntoView({ block: "nearest" });
  }

  function setCursor(i) {
    if (i === cursor) return;
    cursor = i;
    list.querySelectorAll(".pick-row").forEach((el, k) => el.classList.toggle("cur", k === cursor));
  }

  async function search() {
    const text = input.value.trim();
    const my = ++seq;
    const perpTab = cat === "bn" || cat === "hl";
    const stocks = perpTab ? await perps(perpNames()) : await getStockList();
    if (my !== seq) return;
    const out = [];
    const seen = new Set();
    const inTab = (it) => cat === "all" || it.perpFor || catOf(it) === cat;
    const push = (it) => {
      if (!it?.id || seen.has(it.id) || !inTab(it)) return;
      seen.add(it.id);
      out.push(it);
    };
    if (text) {
      const q = makeQuery(text);
      const hits = stocks.filter((s) => q.test(s.idx) && inTab(s)).sort((a, b) => q.score(a.idx) - q.score(b.idx));
      // 티커를 정확히 쳤으면 그게 맨 위
      const direct = normalizeInput(text, marketOf);
      const exact = hits.find((s) => s.id === direct);
      if (exact) push(exact);
      for (const s of hits.slice(0, perpTab ? 1200 : 30)) push(s);
      if (!perpTab && direct && /^[A-Z0-9^=.\-:/]+$/i.test(text.replace(/\s/g, "")) && !seen.has(direct)) push({ id: direct, direct: true });
    } else if (perpTab) {
      for (const s of stocks) push(s);
    } else if (SUGGEST[cat]) {
      const byId = new Map(stocks.map((s) => [s.id, s]));
      for (const id of SUGGEST[cat]) push(byId.get(id) ?? { id });
    } else {
      // 전체·지수 탭: 앱이 기본으로 아는 것 (지수·심리 지표·24시간·자주 보는 ETF)을 종류별로
      const order = ["index", "us_etf", "us_stock", "bn", "hl", "other"];
      const list = stocks.filter((x) => x.builtin || x.desc).sort((a, b) => order.indexOf(catOf(a)) - order.indexOf(catOf(b)));
      for (const s of list) push(s);
    }
    items = perpTab ? out : withPerps(out);
    // 숫자 하나(1~8)만 쳤으면 맨 위에 "그 봉으로 바꾸기" (Alt+1~8과 같음)
    if (onTf && cat === "all" && /^[1-8]$/.test(text)) items.unshift({ id: `tf:${text}`, tf: TF_KEYS[+text - 1] });
    cursor = 0;
    render();
    // 영어 이름은 Yahoo에도 물어본다 (목록에 없는 종목)
    clearTimeout(yahooTimer);
    if (!perpTab && text.length >= 2 && /[a-z]/i.test(text)) {
      yahooTimer = setTimeout(async () => {
        try {
          const ys = await Y.search(text);
          if (my !== seq) return;
          for (const y of ys) {
            const id = preferLive(y.symbol);
            push(id === y.symbol ? { id, name: y.name, code: y.symbol, market: y.exchange, type: y.type } : { id });
          }
          const tfRow = items[0]?.tf ? [items[0]] : [];
          items = [...tfRow, ...withPerps(out)];
          render();
        } catch {}
      }, 350);
    }
  }

  function choose(it) {
    if (!it) return;
    close();
    if (it.tf) return onTf?.(it.tf);
    onPick(it.id);
  }

  input.addEventListener("input", search);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(Math.min(items.length - 1, cursor + 1));
      list.querySelector(".cur")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(Math.max(0, cursor - 1));
      list.querySelector(".cur")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      choose(items[cursor]);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });

  function open(text = "") {
    root.hidden = false;
    cat = "all";
    paintTabs();
    input.value = text;
    input.focus();
    search();
  }

  function close() {
    root.hidden = true;
    clearTimeout(yahooTimer);
    input.blur(); // 숨은 입력칸이 포커스를 쥐고 있으면 다음 글자가 차트로 안 간다
  }

  return {
    open,
    close,
    get isOpen() {
      return !root.hidden;
    },
  };
}
