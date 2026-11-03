// CSV 가져오기 (SPEC §2.7, 대비책): Yahoo·Investing 등에서 받은 일봉 CSV를 끌어다 놓으면 그 종목 일봉으로 저장한다.
// 머리줄 이름으로 열을 찾는다 (영어·한글): Date/날짜, Open/시가, High/고가, Low/저가, Close·Price/종가, Volume·Vol./거래량
// 날짜: 2026-10-23, 2026.10.23, 2026/10/23, 10/23/2026, "Oct 23, 2026". 숫자: 1,234.5 / 1.2M / 350K
import { DAY } from "./tz.js";

const COLS = {
  t: /^(date|날짜|일자|거래일)$/i,
  o: /^(open|시가)$/i,
  h: /^(high|고가)$/i,
  l: /^(low|저가)$/i,
  c: /^(close|price|종가|현재가)$/i,
  v: /^(volume|vol\.?|거래량)$/i,
};
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** 한 줄 나누기 (따옴표 안의 쉼표는 그대로) */
function splitLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') (cur += '"'), i++;
      else q = !q;
    } else if (ch === "," && !q) (out.push(cur), (cur = ""));
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** 날짜 글자 → 그날 값 (UTC 자정 초, 저장소 일봉과 같은 규칙) */
export function parseDate(s) {
  s = String(s).trim();
  let m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); // 미국식 월/일/년
  if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2]) / 1000;
  m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return Date.UTC(+m[3], MONTHS[m[1].toLowerCase()] - 1, +m[2]) / 1000;
  return null;
}

/** "1,234.5" → 1234.5, "1.2M" → 1200000 */
export function parseNum(s) {
  const t = String(s ?? "").replace(/[,\s"]/g, "");
  const m = /^(-?\d*\.?\d+)([KMB])?$/i.exec(t);
  if (!m) return null;
  return +m[1] * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]?.toUpperCase()] ?? 1);
}

/** CSV 글자 → {rows:[{t,o,h,l,c,v}] (날짜 오름차순), skipped} */
export function parseCsv(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/).filter((x) => x.trim());
  if (lines.length < 2) throw new Error("내용이 없어요");
  const head = splitLine(lines[0]).map((x) => x.replace(/^"|"$/g, ""));
  const idx = Object.fromEntries(Object.entries(COLS).map(([k, re]) => [k, head.findIndex((x) => re.test(x))]));
  if (idx.t < 0 || idx.c < 0) throw new Error(`날짜·종가 열을 찾지 못했어요 (머리줄: ${head.join(", ")})`);
  const byDay = new Map();
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const f = splitLine(line);
    const t = parseDate(f[idx.t]);
    const c = parseNum(f[idx.c]);
    if (t == null || !(c > 0)) {
      skipped++;
      continue;
    }
    const num = (k) => (idx[k] >= 0 ? parseNum(f[idx[k]]) : null);
    const o = num("o") > 0 ? num("o") : c;
    const hh = Math.max(num("h") > 0 ? num("h") : c, o, c);
    const ll = Math.min(num("l") > 0 ? num("l") : c, o, c);
    byDay.set(t, { t, o, h: hh, l: ll, c, v: num("v") ?? 0 });
  }
  const rows = [...byDay.values()].sort((a, b) => a.t - b.t);
  if (!rows.length) throw new Error("읽을 수 있는 줄이 없어요");
  return { rows, skipped, days: Math.round((rows[rows.length - 1].t - rows[0].t) / DAY) };
}

/** 파일 이름 → 종목 코드 추측 ("QQQ.csv", "QQQ (1).csv", "005930.KS_daily.csv") */
export function guessSymbol(name) {
  const base = String(name).replace(/\.csv$/i, "").replace(/\s*\(\d+\)$/, "");
  const m = /^([A-Za-z0-9^=.\-]+?)(?:[_ ](?:daily|history|historical|data).*)?$/i.exec(base);
  return m ? m[1].toUpperCase() : "";
}
