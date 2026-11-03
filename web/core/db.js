// 저장소(market.db) 얇은 포장. Rust는 넣고 꺼내기만 하고, 계산은 core/bars.js가 한다.
import { invoke } from "../platform.js";

const CHUNK = 20000; // 한 번에 넘기는 봉 수 (IPC 한 번이 너무 커지지 않게)

/** bars: [{t,o,h,l,c,v}] (t는 UTC 초) */
export async function putBars(sym, tf, bars) {
  let n = 0;
  for (let i = 0; i < bars.length; i += CHUNK) {
    const rows = bars.slice(i, i + CHUNK).map((b) => [b.t, b.o, b.h, b.l, b.c, b.v ?? 0]);
    n += await invoke("db_put", { sym, tf, rows });
  }
  return n;
}

function decode(buf) {
  if (Array.isArray(buf)) buf = new Uint8Array(buf).buffer; // 일부 환경에서 숫자 배열로 올 때
  const a = new Float64Array(buf);
  const n = a.length / 6;
  const out = new Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 6) {
    out[i] = { t: a[j], o: a[j + 1], h: a[j + 2], l: a[j + 3], c: a[j + 4], v: a[j + 5] };
  }
  return out;
}

/**
 * 봉 읽기 (시간 오름차순)
 * - {before, limit}: before 이전에서 가장 최근 limit개
 * - {after, before, limit}: after 이후부터 limit개
 */
export async function getBars(sym, tf, { before = null, after = null, limit = null } = {}) {
  return decode(await invoke("db_get", { sym, tf, before, after, limit }));
}

/** {first, last, count} 또는 null */
export function range(sym, tf) {
  return invoke("db_range", { sym, tf });
}

export function coverage() {
  return invoke("db_coverage", {});
}

/** events: [{kind:"split"|"div", t, a, b}] */
export function putEvents(sym, events) {
  if (!events.length) return 0;
  return invoke("db_put_events", { sym, rows: events.map((e) => [e.kind, e.t, e.a, e.b ?? 0]) });
}

export async function getEvents(sym) {
  const rows = (await invoke("db_get_events", { sym })) ?? [];
  return rows.map(([kind, t, a, b]) => ({ kind, t, a, b }));
}

export function deleteSymbol(sym, tf = null) {
  return invoke("db_delete", { sym, tf });
}

export async function metaGet(k) {
  const v = await invoke("db_meta_get", { k });
  try {
    return v == null ? null : JSON.parse(v);
  } catch {
    return null;
  }
}

export function metaSet(k, v) {
  return invoke("db_meta_set", { k, v: v == null ? null : JSON.stringify(v) });
}

/** 봉 사이가 minGap초보다 벌어진 곳 [[앞 봉 t, 뒤 봉 t], ...] */
export function gaps(sym, tf, minGap) {
  return invoke("db_gaps", { sym, tf, minGap });
}

export function dbSize() {
  return invoke("db_size", {});
}

export function vacuum() {
  return invoke("db_vacuum", {});
}
