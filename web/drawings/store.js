// 그린 것 저장 (SPEC §3.4): 종목마다, drawings.json — 데이터 저장소(market.db)와 따로
// → 데이터를 지우고 다시 받아도 그림은 남는다. 같은 종목을 보는 모든 칸에 같이 보인다.
import { loadFile, saveFile } from "../platform.js";

const FILE = "drawings.json";
let db = { version: 1, by: {} };
const subs = new Set();
let timer = null;

export async function loadDrawings() {
  const d = await loadFile(FILE);
  if (d?.by) db = d;
}

export function drawingsOf(sym) {
  return db.by[sym] ?? [];
}

/** 한 종목의 그림 목록 바꾸기 → 그 종목을 보는 칸 모두 다시 그림 + 0.4초 뒤 저장 */
export function setDrawings(sym, list) {
  if (list.length) db.by[sym] = list;
  else delete db.by[sym];
  for (const fn of subs) fn(sym);
  clearTimeout(timer);
  timer = setTimeout(() => saveFile(FILE, db), 400);
}

export function findDrawing(sym, id) {
  return drawingsOf(sym).find((d) => d.id === id) ?? null;
}

export function onDrawings(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export const newId = () => Math.random().toString(36).slice(2, 10);
