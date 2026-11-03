// 국내·미국 종목 이름 목록 (이름 검색, SPEC §2.10)
// 앱 안의 사본(web/data/stocks_list.json)을 쓰고, Market Board의 목록이 더 새것이면 그것을 읽기만 한다.
import { invoke } from "../platform.js";
import { indexOf } from "../ui/search.js";
import { setStockNames, describe, BUILTIN } from "./symbols.js";

let list = null;
let krMarket = new Map();

/** [{id, code, name, market, type, idx}] */
export async function getStockList(mode = "auto") {
  if (list) return list;
  const bundled = await (await fetch(new URL("../data/stocks_list.json", import.meta.url))).json();
  let src = bundled;
  if (mode === "auto") {
    try {
      const s = await invoke("load_market_board_stocklist", {});
      const mb = s ? JSON.parse(s) : null;
      if (mb?.rows?.length > 1000 && String(mb.date) > String(bundled.date)) src = mb;
    } catch {}
  }
  list = src.rows.map(([code, name, market, type]) => {
    const kr = market === "KOSPI" || market === "KOSDAQ";
    const id = kr ? `${code}.${market === "KOSDAQ" ? "KQ" : "KS"}` : code.replace(/\./g, "-");
    if (kr) krMarket.set(code, market);
    return { id, code, name, market, type, idx: indexOf(name, code, type === "ETF" ? "etf" : "") };
  });
  setStockNames(new Map(list.map((x) => [x.id, x.name])));
  // 기본으로 아는 종목(지수·심리 지표·선물)도 검색되게. 목록에 이미 있으면 한글 설명만 덧붙인다(예: TQQQ ← 나스닥100 3배)
  const byId = new Map(list.map((x) => [x.id, x]));
  for (const id of BUILTIN) {
    const d = describe(id);
    const name = d.sub || d.label;
    const old = byId.get(id);
    if (old) {
      old.desc = name;
      old.idx = indexOf(`${old.name} ${name}`, old.code, old.type === "ETF" ? "etf" : "");
    } else list.push({ id, code: id, name, market: d.kind, type: d.kind, idx: indexOf(`${name} ${d.label}`, id, d.kind, d.label), builtin: true });
  }
  return list;
}

export const marketOf = (code) => krMarket.get(code);
