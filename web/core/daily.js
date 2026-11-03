// 일봉 받기·이어 받기 (Yahoo). SPEC §2.4
// - 처음: 상장 첫날부터 한 번에 (요청 1번)
// - 다음부터: 마지막 저장일 10일 전부터만 받아서 덮어쓴다
// - 겹친 날 값이 0.5% 넘게 다르면(Yahoo가 과거 값을 고침) 그 종목만 처음부터 다시 받는다
// - Yahoo 일봉은 분할이 반영된 가격이라, 분할 목록으로 실제 가격으로 되돌려 저장한다
import * as Y from "../sources/yahoo.js";
import * as db from "./db.js";
import { localDay, DAY } from "./tz.js";
import { splitList, splitFactorAt } from "./bars.js";
import { logInfo } from "../platform.js";

const OVERLAP_DAYS = 10;
const MISMATCH = 0.005;

/** Yahoo 결과 → {rows(실제 가격, 날짜 값), events} */
export function fromYahoo(r, dayTz, knownSplits = []) {
  const ev = Y.events(r);
  const newSplits = ev.splits.map((s) => ({ kind: "split", t: localDay(dayTz, s.t), a: s.a, b: s.b }));
  const allSplits = splitList([...knownSplits, ...newSplits]);
  // 같은 날 두 개가 오면(장중 마지막 봉) 뒤의 것
  const byDay = new Map();
  for (const k of Y.rows(r)) byDay.set(localDay(dayTz, k.t), k);
  const rows = [];
  for (const [day, k] of [...byDay].sort((a, b) => a[0] - b[0])) {
    const f = splitFactorAt(allSplits, day);
    const p = (x) => +(x * f).toPrecision(10);
    rows.push({ t: day, o: p(k.o), h: p(k.h), l: p(k.l), c: p(k.c), v: Math.round(k.v / f) });
  }
  const divs = ev.divs.map((d) => {
    const day = localDay(dayTz, d.t);
    return { kind: "div", t: day, a: +(d.amount * splitFactorAt(allSplits, day)).toPrecision(10), b: 0 };
  });
  return { rows, events: [...newSplits, ...divs], meta: r.meta };
}

/**
 * 일봉을 최신으로. onProgress(text)는 상태줄 표시용.
 * @returns {{added:number, full:boolean}}
 */
export async function updateDaily(info, { front = false, force = false } = {}) {
  const sym = info.id;
  const rng = await db.range(sym, "1D");
  const known = await db.getEvents(sym);
  const full = force || !rng;
  const from = full ? null : rng.last - OVERLAP_DAYS * DAY;
  const r = await Y.daily(info.yahoo, from == null ? null : from - DAY, { front });
  const got = fromYahoo(r, info.dayTz, known);
  if (!full) {
    // 겹친 날 비교 (마지막 저장일은 장중에 받은 값일 수 있어서 뺀다)
    const old = await db.getBars(sym, "1D", { after: from, before: rng.last });
    const oldBy = new Map(old.map((k) => [k.t, k.c]));
    let bad = 0;
    for (const k of got.rows) {
      const c = oldBy.get(k.t);
      if (c != null && Math.abs(k.c - c) / c > MISMATCH) bad++;
    }
    if (bad) {
      logInfo(`[daily] ${sym} 겹친 날 ${bad}일 값이 달라 처음부터 다시 받음`);
      return updateDaily(info, { front, force: true });
    }
  }
  if (full && rng) await db.deleteSymbol(sym, "1D");
  await db.putBars(sym, "1D", got.rows);
  await db.putEvents(sym, got.events);
  await db.metaSet(`${sym}|info`, {
    name: got.meta?.longName ?? got.meta?.shortName ?? null,
    currency: got.meta?.currency ?? null,
    exchangeTz: got.meta?.exchangeTimezoneName ?? null,
    type: got.meta?.instrumentType ?? null,
    checked: Date.now(),
  });
  if (full) logInfo(`[daily] ${sym} 처음부터 ${got.rows.length}봉 저장`);
  return { added: got.rows.length, full, meta: got.meta };
}
