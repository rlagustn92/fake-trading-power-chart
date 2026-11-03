// 경제 일정·실적일 (차트 마커 + 상태 줄 "이번 주 일정" + 30분 전 알림)
// 해마다 할 일·자료 출처·막힌 곳: 프로젝트 폴더의 MAINTENANCE.md
// 한 달에 한 번 나오는 자료라 자주 받지 않는다 (아래 due): 켤 때(받은 지 하루 넘었으면) · 🔄 누를 때 · 발표 직후 한 번
// - FOMC 금리 결정일: 연준 홈페이지 FOMC 일정 페이지에서 자동으로 (일주일에 한 번, 파일에 보관 · 못 받으면 아래 표)
// - 이번 주 미국 주요 지표(CPI·고용·PCE·GDP…): ForexFactory 주간 일정 JSON (하루에 한 번 + 새 주가 되면, 파일에 보관)
// - 실적일: Nasdaq (지난 4번 발표일 + 다음 예정일), 종목마다 12시간에 한 번, 파일에 보관
// - 상태 줄 "다음 FOMC·CPI" (macroOutlook): 금리·선물은 하루에 한 번 + FOMC 뒤, 클리블랜드는 일주일에 한 번 + CPI 발표 뒤 (파일에 보관)
//   · 직전 FOMC 결과·지금 금리: 뉴욕 연준 공식 금리 API (목표 범위·실효 금리, 키 필요 없음)
//   · FOMC 예상: 그 주면 ForexFactory 시장 예상, 아니면 금리 선물(Yahoo ZQ)로 계산 (CME FedWatch와 같은 방식)
//   · CPI 직전·예상: 클리블랜드 연준 나우캐스트 파일 (실제 값 + 예측)
//     그 주에는 ForexFactory 시장 예상(컨센서스)이 우선
import { getJson, getText, loadFile, saveFile, notify } from "../platform.js";
import { tzOffset } from "./tz.js";
import { chart as yahooChart } from "../sources/yahoo.js";

const H = 3600;
const DAY = 86400;

/** FOMC 결정일 (뉴욕 날짜, 이틀 회의의 둘째 날). 기본 표 — 켜면 연준 페이지에서 받은 날짜로 바뀐다(refreshFomc) */
const FOMC = [
  "2024-01-31", "2024-03-20", "2024-05-01", "2024-06-12", "2024-07-31", "2024-09-18", "2024-11-07", "2024-12-18",
  "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10",
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
];

/** CPI 발표일 (뉴욕 08:30). 노동통계국 사이트는 프로그램 접속을 막아서(403) 자동으로 못 받는다
 *  → 이 표 + 발표하는 주에는 ForexFactory 날짜·시각이 우선. 표가 끝나면 "N월 중순(날짜 미정)"으로 보여 준다.
 *  다음 해 날짜: 백악관(OMB) "Schedule of Release Dates for Principal Federal Economic Indicators" PDF (해마다 10월쯤)
 *  넣는 법: MAINTENANCE.md "CPI 발표 날짜 넣기" */
const CPI = [
  "2026-01-13", "2026-02-13", "2026-03-11", "2026-04-10", "2026-05-12", "2026-06-10", "2026-07-14", "2026-08-12", "2026-09-11", "2026-10-14", "2026-11-10", "2026-12-10",
  "2027-01-13", "2027-02-11", "2027-03-10", "2027-04-13", "2027-05-12", "2027-06-10", "2027-07-14", "2027-08-11", "2027-09-14", "2027-10-14", "2027-11-10", "2027-12-10",
];

/** 날짜 글자 → 날짜 값 (UTC 자정 초, 일봉과 같은 규칙) */
const dayOf = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 1000;
export const FOMC_DAYS = FOMC.map(dayOf);
/** 뉴욕 날짜·시각 → UTC 초 */
const nyAt = (s, hh, mm = 0) => {
  const d = dayOf(s);
  return d + hh * H + mm * 60 - tzOffset("America/New_York", d + 12 * H);
};

// ── 언제 받나 ──
// 1) 켤 때: 받은 지 start(기본 하루)가 지났으면  2) 🔄 지금 업데이트: 받은 지 forceAge(기본 1시간)가 지났으면
// 3) 발표 직후 한 번(since)  4) 켜 둔 채로는 long 간격으로만 (없으면 안 받음). 못 받으면 다음 확인 때 다시
const checked = new Set(); // 이번에 켠 뒤 한 번 확인한 것
let forceAt = 0;
function due(name, at, { start = DAY * 1000, long = Infinity, since = 0, forceAge = H * 1000 } = {}) {
  const first = !checked.has(name);
  checked.add(name);
  if (!at) return true;
  const age = Date.now() - at;
  if (forceAt > at && age > forceAge) return true;
  if (first && age > start) return true;
  if (since > at && since <= Date.now()) return true;
  return age > long;
}
const failed = (name) => checked.delete(name); // 못 받았으면 다음 확인 때 다시
/** 🔄 지금 업데이트를 누르면 경제 자료도 (받은 지 1시간 넘은 것만) */
export function forceEconRefresh() {
  forceAt = Date.now();
}
/** 뉴욕 기준 주 번호 (일요일 시작, ForexFactory "이번 주"와 같게) */
const weekOf = (t) => Math.floor((Math.floor((t + tzOffset("America/New_York", t)) / DAY) + 4) / 7);

// ── FOMC 날짜 자동 갱신 (연준 공식 일정 페이지, 올해·내년이 다 나와 있다) ──
const FED_CAL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const MONTH = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad2 = (n) => String(n).padStart(2, "0");

/** 연준 FOMC 일정 페이지 → 결정일(이틀 회의의 둘째 날) "YYYY-MM-DD" 목록. 표결만 하는 날(notation vote)은 뺀다 */
export function parseFedCalendar(html) {
  const out = new Set();
  const parts = String(html).split(/(\d{4}) FOMC Meetings/);
  const re = /fomc-meeting__month[^>]*><strong>([^<]+)<\/strong><\/div>\s*<div class="fomc-meeting__date[^>]*>([^<]+)<\/div>/g;
  for (let k = 1; k < parts.length; k += 2) {
    const y = +parts[k];
    for (const [, mon, date] of parts[k + 1].matchAll(re)) {
      if (/notation/i.test(date)) continue;
      const m = /^\s*(\d{1,2})(?:\s*-\s*(\d{1,2}))?/.exec(date);
      if (!m) continue;
      const months = mon.split("/").map((s) => MONTH.indexOf(s.trim().slice(0, 3).toLowerCase()) + 1);
      const d1 = +m[1];
      const d2 = m[2] ? +m[2] : d1;
      // "Apr/May 30-1" → 둘째 날은 뒤 달
      const month = d2 < d1 && months[1] ? months[1] : months[0];
      if (month >= 1 && month <= 12) out.add(`${y}-${pad2(month)}-${pad2(d2)}`);
    }
  }
  return [...out].sort();
}

/** 받은 날짜로 표 바꾸기: 받은 해는 받은 것만(일정이 바뀌었을 수도), 나머지 해는 기본 표 그대로 */
function applyFomc(list) {
  const years = new Set(list.map((s) => s.slice(0, 4)));
  const all = [...new Set([...FOMC.filter((s) => !years.has(s.slice(0, 4))), ...list])].sort();
  FOMC.splice(0, FOMC.length, ...all);
  FOMC_DAYS.splice(0, FOMC_DAYS.length, ...all.map(dayOf));
}

async function refreshFomc() {
  const cache = await loadFile("fomc_dates.json");
  let list = cache?.list ?? null;
  if (due("fomc", cache?.at, { start: 7 * DAY * 1000, long: 7 * DAY * 1000, forceAge: DAY * 1000 })) {
    try {
      const got = parseFedCalendar(await getText(FED_CAL, UA));
      // 페이지 모양이 바뀌어 거의 못 읽었으면 쓰지 않는다 (올해 회의가 4번은 넘어야)
      if (got.filter((s) => s.startsWith(String(new Date().getUTCFullYear()))).length >= 4) {
        list = got;
        await saveFile("fomc_dates.json", { at: Date.now(), list });
      } else failed("fomc");
    } catch (e) {
      console.warn("[events] 연준 FOMC 일정", e.message);
      failed("fomc");
    }
  }
  if (list?.length) applyFomc(list);
}
let fomcJob = null;
/** FOMC 날짜 (받을 때가 됐으면 연준 페이지에서 새로) */
export function fomcDates() {
  fomcJob ??= refreshFomc()
    .catch(() => {})
    .finally(() => (fomcJob = null));
  return fomcJob;
}

// 영어 이름 → 쉬운 한글
const KO = [
  [/^CPI/i, "CPI 물가"],
  [/Core CPI/i, "근원 CPI"],
  [/Non-Farm/i, "고용(비농업)"],
  [/Unemployment Rate/i, "실업률"],
  [/FOMC|Federal Funds Rate/i, "FOMC 금리"],
  [/PCE/i, "PCE 물가"],
  [/GDP/i, "GDP 성장률"],
  [/Retail Sales/i, "소매판매"],
  [/ISM Manufacturing/i, "ISM 제조업"],
  [/ISM Services/i, "ISM 서비스업"],
  [/PPI/i, "PPI 생산자물가"],
  [/JOLTS/i, "구인(JOLTS)"],
  [/Powell|Fed Chair/i, "파월 발언"],
];
const koTitle = (t) => KO.find(([re]) => re.test(t))?.[1] ?? t;

const NASDAQ = { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } };
const ECON_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

/** 이번 주 미국 주요 지표 [{t(UTC 초), title, ko, forecast, previous}] — 하루에 한 번 + 새 주가 되면 */
let weekJob = null;
export function econWeek() {
  weekJob ??= loadEconWeek().finally(() => (weekJob = null)); // 상태 줄·알림이 같이 불러도 한 번만
  return weekJob;
}
async function loadEconWeek() {
  const cache = await loadFile("econ_week.json");
  const newWeek = cache && weekOf(cache.at / 1000) !== weekOf(Date.now() / 1000);
  if (cache && !newWeek && !due("ff", cache.at, { long: DAY * 1000 })) return cache.list;
  try {
    const raw = await getJson(ECON_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
    const list = raw
      .filter((x) => x.country === "USD" && x.impact === "High")
      .map((x) => ({ t: Date.parse(x.date) / 1000, title: x.title, ko: koTitle(x.title), forecast: x.forecast || "", previous: x.previous || "" }))
      .filter((x) => Number.isFinite(x.t))
      .sort((a, b) => a.t - b.t);
    await saveFile("econ_week.json", { at: Date.now(), list });
    return list;
  } catch (e) {
    console.warn("[events] 경제 일정", e.message);
    failed("ff");
    return cache?.list ?? [];
  }
}

const earnCache = new Map();
/** 실적 발표일 {past: [날짜 값], next: 날짜 값 | null, estimated} — 미국 개별 종목만 (ETF는 없음) */
export async function earnings(symbol) {
  const key = symbol.toUpperCase();
  if (earnCache.has(key)) return earnCache.get(key);
  const file = (await loadFile("earnings.json")) ?? {};
  const c = file[key];
  if (c && Date.now() - c.at < 12 * H * 1000) {
    earnCache.set(key, c);
    return c;
  }
  const out = { at: Date.now(), past: [], next: null, estimated: true };
  try {
    const [hist, nxt] = await Promise.all([
      getJson(`https://api.nasdaq.com/api/company/${encodeURIComponent(key)}/earnings-surprise`, NASDAQ).catch(() => null),
      getJson(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(key)}/earnings-date`, NASDAQ).catch(() => null),
    ]);
    const md = (s) => {
      const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s ?? "");
      return m ? Date.UTC(+m[3], +m[1] - 1, +m[2]) / 1000 : null;
    };
    out.past = (hist?.data?.earningsSurpriseTable?.rows ?? []).map((r) => md(r.dateReported)).filter(Boolean);
    const text = `${nxt?.data?.reportText ?? ""} ${nxt?.data?.announcement ?? ""}`;
    out.next = md(text);
    out.estimated = /estimated|algorithm/i.test(text);
  } catch (e) {
    console.warn("[events] 실적일", key, e.message);
  }
  earnCache.set(key, out);
  file[key] = out;
  saveFile("earnings.json", file);
  return out;
}

// ── 다음 FOMC·CPI (상태 줄) ──
const NYFED = (from, to) => `https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json?startDate=${from}&endDate=${to}`;
const NOWCAST_URL = "https://www.clevelandfed.org/-/media/files/webcharts/inflationnowcasting/nowcast_year.json?sc_lang=en";
const UA = { headers: { "User-Agent": "Mozilla/5.0" } };
const ymdOf = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

/** 뉴욕 연준 실효 금리 응답 → 날짜순 [{d, effr, lo, hi}] */
export function parseNyFed(json) {
  return (json?.refRates ?? [])
    .map((r) => ({ d: r.effectiveDate, effr: +r.percentRate, lo: +r.targetRateFrom, hi: +r.targetRateTo }))
    .filter((r) => /^\d{4}-\d\d-\d\d$/.test(r.d) && Number.isFinite(r.hi))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
}

/** 금리가 바뀐 폭(%p) → 동결·인상·인하 (0.25가 아니면 폭도) */
export function rateMove(delta) {
  if (Math.abs(delta) < 0.01) return "동결";
  const dir = delta > 0 ? "인상" : "인하";
  return Math.abs(Math.abs(delta) - 0.25) < 0.01 ? dir : `${dir} ${Math.abs(delta).toFixed(2)}%p`;
}

/** 직전 회의 결과: 목표 금리 상단(일별)의 회의 날 값(옛 금리) vs 다음 날 값(새 금리). 다음 날 값이 아직 없으면 null */
export function lastDecision(series, meeting) {
  let before = null;
  let after = null;
  for (const [d, v] of series) {
    if (d <= meeting) before = v;
    else if (after == null) after = v;
  }
  return before == null || after == null ? null : { text: rateMove(after - before), from: before, to: after };
}

/** 30일 연방기금 선물 기호 (m = 1~12) */
export const zqOf = (y, m) => (m > 12 ? zqOf(y + 1, m - 12) : `ZQ${"FGHJKMNQUVXZ"[m - 1]}${String(y % 100).padStart(2, "0")}.CBT`);

/** 선물로 본 회의 뒤 금리 변화(%p): 달 후반 회의는 다음 달 선물, 전반 회의는 그 달 평균에서 회의 전 날수를 빼서 */
export function futuresDelta(meeting, r0, pMonth, pNext) {
  const [y, m, d] = meeting.split("-").map(Number);
  const N = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let post = null;
  if ((d >= 16 || pMonth == null) && pNext != null) post = 100 - pNext;
  else if (pMonth != null) post = ((100 - pMonth) * N - r0 * d) / (N - d);
  return post == null || r0 == null ? null : post - r0;
}

/** 변화(%p) → "동결 90%" / "인하 72%" (0.25%p 한 번 기준 확률, 대략) */
export function oddsText(delta) {
  const pct = Math.round((Math.abs(delta) / 0.25) * 100);
  if (Math.abs(delta) < 0.125) return `동결 ${Math.max(1, 100 - pct)}%`;
  return `${delta < 0 ? "인하" : "인상"} ${Math.min(99, pct)}%`;
}

/**
 * 클리블랜드 연준 나우캐스트(전년 대비 %) → {y, m, cpi, core}(아직 발표 안 된 마지막 달의 예측)
 * + actual {y, m, cpi, core}(실제 값이 나온 가장 최근 달)
 */
export function nowcastOf(list) {
  const ym = (x) => String(x?.chart?.subcaption ?? "").split("-").map(Number);
  const val = (x, name) => {
    const v = (x?.dataset?.find((s) => s.seriesname === name)?.data ?? []).map((d) => parseFloat(d.value)).filter(Number.isFinite);
    return v.length ? v[v.length - 1] : null;
  };
  const last = list?.[list.length - 1];
  const [y, m] = ym(last);
  if (!y || !m) return null;
  let actual = null;
  for (let i = list.length - 1; i >= 0 && !actual; i--) {
    const cpi = val(list[i], "Actual CPI Inflation");
    if (cpi != null) {
      const [ay, am] = ym(list[i]);
      actual = { y: ay, m: am, cpi, core: val(list[i], "Actual Core CPI Inflation") };
    }
  }
  return { y, m, cpi: val(last, "CPI Inflation"), core: val(last, "Core CPI Inflation"), actual };
}

const settle = (p, what) =>
  p.catch((e) => {
    console.warn("[events]", what, e.message);
    return null;
  });

/** 받아 둔 재료: 금리·선물은 하루에 한 번 + FOMC 뒤(1시간 뒤 선물, 이틀 뒤 뉴욕 연준 새 금리)
 *  클리블랜드(7MB)는 일주일에 한 번 + CPI 발표 1시간 뒤 */
let factsJob = null;
function macroFacts(now, week) {
  factsJob ??= loadMacroFacts(now, week).finally(() => (factsJob = null)); // 상태 줄과 다른 곳이 동시에 불러도 한 번만 받는다
  return factsJob;
}
async function loadMacroFacts(now, week = []) {
  const cache = await loadFile("macro.json");
  const passed = (list) => Math.max(0, ...list.filter((t) => t < now)) * 1000;
  const lastFomc = passed(FOMC.flatMap((s) => [nyAt(s, 14) + H, nyAt(s, 14) + 42 * H]));
  const lastCpi = passed([...CPI.map((s) => nyAt(s, 8, 30) + H), ...week.filter((e) => /^CPI/i.test(e.title)).map((e) => e.t + H)]);
  const ratesDue = due("rates", cache?.at, { long: DAY * 1000, since: lastFomc });
  const castDue = due("nowcast", cache?.nowcastAt, { long: 7 * DAY * 1000, since: lastCpi });
  if (cache && !ratesDue && !castDue) return cache;
  const next = FOMC.find((s) => nyAt(s, 14) + 1800 > now);
  const [y, m] = next ? next.split("-").map(Number) : [];
  const price = (sym) => settle(yahooChart(sym, { range: "5d", interval: "1d" }).then((r) => r.meta?.regularMarketPrice ?? null), sym);
  const [rates, pMonth, pNext, cast] = await Promise.all([
    ratesDue ? settle(getJson(NYFED(ymdOf(now - 150 * DAY), ymdOf(now)), UA).then(parseNyFed), "뉴욕 연준 금리") : null,
    ratesDue && next ? price(zqOf(y, m)) : null,
    ratesDue && next ? price(zqOf(y, m + 1)) : null,
    castDue ? settle(getJson(NOWCAST_URL, UA).then(nowcastOf), "클리블랜드 나우캐스트") : null,
  ]);
  const ok = !!rates?.length;
  if (ratesDue && !ok) failed("rates");
  if (castDue && !cast) failed("nowcast");
  const zqNew = ratesDue && next && (pMonth != null || pNext != null) ? { meeting: next, pMonth, pNext } : null;
  const facts = {
    at: ok ? Date.now() : cache?.at ?? 0,
    rates: ok ? rates.map((r) => [r.d, r.hi]) : cache?.rates ?? null, // [[날짜, 목표 상단]]
    lo: ok ? rates[rates.length - 1].lo : cache?.lo ?? null,
    effr: ok ? rates[rates.length - 1].effr : cache?.effr ?? null,
    zq: zqNew ?? cache?.zq ?? null,
    nowcast: cast ?? cache?.nowcast ?? null,
    nowcastAt: cast ? Date.now() : cache?.nowcastAt ?? 0,
  };
  await saveFile("macro.json", facts);
  return facts;
}

/** 손으로 넣어야 할 CPI 해 (MAINTENANCE.md): 표가 끝났으면 그다음 해, 10월부터는 다음 해 날짜가 표에 있어야. 다 있으면 null */
export function cpiNeedYear(today, table = CPI) {
  const lastYear = +table[table.length - 1].slice(0, 4);
  if (!table.some((s) => nyAt(s, 8, 30) + 1800 > today.getTime() / 1000)) return lastYear + 1;
  return today.getMonth() >= 9 && lastYear <= today.getFullYear() ? today.getFullYear() + 1 : null;
}

/**
 * 상태 줄: 다음 FOMC·CPI
 * {fomc: {t, meeting, expect, expectFrom, last, lastMeeting, upper, effr},
 *  cpi: {t, refY, refM, expect, expectCore, expectFrom, prev, prevCore, prevM}}
 */
export async function macroOutlook() {
  const now = Date.now() / 1000;
  const [week] = await Promise.all([econWeek(), fomcDates()]);
  const f = await macroFacts(now, week);
  const near = (e, t) => Math.abs(e.t - t) < 6 * H;

  // FOMC
  const meeting = FOMC.find((s) => nyAt(s, 14) + 1800 > now) ?? null;
  const past = [...FOMC].reverse().find((s) => nyAt(s, 14) <= now) ?? null;
  let fomc = null;
  if (meeting) {
    const t = nyAt(meeting, 14);
    fomc = { t, meeting, expect: null, expectFrom: "", alt: "", last: null, lastMeeting: past, lower: f.lo, upper: f.rates?.[f.rates.length - 1]?.[1] ?? null, effr: f.effr };
    // 두 가지로 본다: ① 시장 예상(ForexFactory, 회의가 있는 주에만) ② 금리 선물(언제나). 상태 줄에는 ①이 있으면 ①
    const ff = week.find((e) => /Federal Funds Rate/i.test(e.title) && near(e, t) && e.forecast && e.previous);
    const consensus = ff ? { text: rateMove(parseFloat(ff.forecast) - parseFloat(ff.previous)), from: `시장 예상 (ForexFactory 경제 캘린더, 전문가 예상치) ${ff.previous} → ${ff.forecast}` } : null;
    const d = f.zq?.meeting === meeting ? futuresDelta(meeting, f.effr, f.zq.pMonth, f.zq.pNext) : null;
    const odds = d != null ? { text: oddsText(d), from: `금리 선물로 계산 (CME FedWatch와 같은 방식, 대략) · 회의 뒤 예상 실효 금리 ${(f.effr + d).toFixed(2)}%` } : null;
    const main = consensus ?? odds;
    if (main) {
      fomc.expect = main.text;
      fomc.expectFrom = main.from;
    }
    if (consensus && odds) fomc.alt = `${odds.text} — ${odds.from}`;
    if (past && f.rates) fomc.last = lastDecision(f.rates, past);
  }

  // CPI
  const ffCpi = week.find((e) => /^CPI y\/y/i.test(e.title) && e.t + 1800 > now);
  const day = CPI.find((s) => nyAt(s, 8, 30) + 1800 > now);
  const t = ffCpi?.t ?? (day ? nyAt(day, 8, 30) : null);
  const A = f.nowcast?.actual;
  // 몇 월 치 발표인지: 날짜를 알면 발표한 달의 앞 달, 모르면(표가 끝남) 마지막 실제 값의 다음 달
  let ref = null;
  if (t) {
    const rel = new Date((t - 5 * H) * 1000);
    ref = rel.getUTCMonth() === 0 ? { y: rel.getUTCFullYear() - 1, m: 12 } : { y: rel.getUTCFullYear(), m: rel.getUTCMonth() };
  } else if (A) ref = A.m === 12 ? { y: A.y + 1, m: 1 } : { y: A.y, m: A.m + 1 };
  let cpi = null;
  if (ref) {
    cpi = { t, approx: t ? "" : `${ref.m === 12 ? 1 : ref.m + 1}월 중순`, refY: ref.y, refM: ref.m, expect: null, expectCore: null, expectFrom: "", prev: A?.cpi ?? null, prevCore: A?.core ?? null, prevM: A?.m ?? null };
    const cast = f.nowcast?.y === ref.y && f.nowcast?.m === ref.m && f.nowcast.cpi != null ? f.nowcast : null;
    if (ffCpi?.forecast) {
      cpi.expect = parseFloat(ffCpi.forecast);
      cpi.expectFrom = "시장 예상 (ForexFactory 경제 캘린더, 전문가 예상치)";
      if (cast) cpi.alt = `${cast.cpi.toFixed(1)}%${cast.core != null ? ` · 근원 ${cast.core.toFixed(1)}%` : ""} — 클리블랜드 연준 예측`;
    } else if (cast) {
      cpi.expect = cast.cpi;
      cpi.expectCore = cast.core;
      cpi.expectFrom = "클리블랜드 연준 예측 (나우캐스트)";
    }
    if (cpi.prev == null && ffCpi?.previous) cpi.prev = parseFloat(ffCpi.previous);
  }
  if (cpi) cpi.needYear = cpiNeedYear(new Date());
  return { fomc, cpi };
}

/** 30분 전 알림: 이번 주 주요 지표·FOMC (앱이 켜져 있을 때) */
export function startEventAlerts({ toast, enabled }) {
  const told = new Set();
  const tick = async () => {
    if (enabled()) {
      const now = Date.now() / 1000;
      for (const e of await econWeek()) {
        const left = e.t - now;
        const key = `${e.t}|${e.title}`;
        if (left > 0 && left <= 30 * 60 && !told.has(key)) {
          told.add(key);
          const when = new Date(e.t * 1000).toTimeString().slice(0, 5);
          const text = `📅 ${when} 미국 ${e.ko} 발표 (${Math.round(left / 60)}분 뒤)${e.forecast ? ` · 예상 ${e.forecast}` : ""}`;
          toast(text, 15000);
          notify("📅 FAKE TRADING 일정", text);
        }
      }
    }
    setTimeout(tick, 60e3);
  };
  setTimeout(tick, 10e3);
}

export const DAY_SEC = DAY;
