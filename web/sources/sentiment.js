// 심리 지표 (SPEC §2.12): 주식처럼 저장소에 일봉(시가=고가=저가=종가=값)으로 쌓는다.
// - CBOE 풋/콜 비율: 2006-11-01~2019-10-04는 CSV 2개, 2019-10-07부터는 날짜별 JSON(하루 1번 요청)
//   처음 채우기는 최근 날짜부터 거꾸로(최근 것이 먼저 보이게), 0.3초 간격
// - CNN 공포·탐욕: 2021-01-04부터, 요청 1번에 전부 (Referer가 없으면 막힌다)
import { getText, getJson, logInfo } from "../platform.js";
import { createLimiter } from "../core/limit.js";
import * as db from "../core/db.js";
import { DAY, parseYmd, ymd, weekday, today } from "../core/tz.js";
import { setSourceStatus } from "./status.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)";
const CBOE_CSV = "https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/";
const CBOE_DAY = "https://cdn.cboe.com/data/us/options/market_statistics/daily/";
const JSON_FROM = parseYmd("2019-10-07");
const cboeQueue = createLimiter(1, 300);

const pt = (t, v) => ({ t, o: v, h: v, l: v, c: v, v: 0 });

function parseCsv(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const p = line.split(",").map((x) => x.trim());
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(p[0] ?? "");
    const v = parseFloat(p[p.length - 1]);
    if (!m || !(v > 0)) continue;
    out.push(pt(Date.UTC(+m[3], +m[1] - 1, +m[2]) / 1000, v));
  }
  return out;
}

const NAMES = { "cboe:PC_TOTAL": "TOTAL PUT/CALL RATIO", "cboe:PC_EQUITY": "EQUITY PUT/CALL RATIO", "cboe:PC_INDEX": "INDEX PUT/CALL RATIO" };

/** 날짜별 JSON 하나 → {id: 값} (휴장일은 null) */
async function cboeDay(day) {
  try {
    const d = await cboeQueue(() => getJson(`${CBOE_DAY}${ymd(day)}_daily_options`, { headers: { "User-Agent": UA } }));
    const out = {};
    for (const [id, name] of Object.entries(NAMES)) {
      const r = d.ratios?.find((x) => x.name === name);
      const v = parseFloat(r?.value);
      if (v > 0) out[id] = v;
    }
    setSourceStatus("CBOE", true);
    return out;
  } catch (e) {
    if (/HTTP (403|404)/.test(e.message)) return null; // 휴장일·아직 안 올라온 날
    setSourceStatus("CBOE", false);
    throw e;
  }
}

let cboeRunning = null;

/**
 * 풋/콜 비율 최신으로 (세 종류를 같이). onBatch()는 몇 날짜마다 불러서 차트가 바로 보이게.
 */
export function updateCboe(onBatch = () => {}) {
  if (cboeRunning) return cboeRunning;
  cboeRunning = (async () => {
    // 1) 2019년 이전 CSV (한 번만)
    const old = await db.range("cboe:PC_TOTAL", "1D");
    if (!old || old.first > parseYmd("2006-11-02")) {
      for (const [id, file] of [["cboe:PC_TOTAL", "totalpc.csv"], ["cboe:PC_EQUITY", "equitypc.csv"]]) {
        const rows = parseCsv(await getText(CBOE_CSV + file, { headers: { "User-Agent": UA } }));
        await db.putBars(id, "1D", rows);
      }
      onBatch();
    }
    // 2) 2019-10-07부터 날짜별: 없는 평일만, 최근부터
    const have = new Set((await db.getBars("cboe:PC_TOTAL", "1D", { after: JSON_FROM, limit: 100000 })).map((k) => k.t));
    const missing = new Set((await db.metaGet("cboe|missing")) ?? []);
    const end = today("America/New_York");
    const todo = [];
    for (let d = end; d >= JSON_FROM; d -= DAY) {
      const wd = weekday(d);
      if (wd === 0 || wd === 6 || have.has(d) || missing.has(d)) continue;
      todo.push(d);
    }
    let n = 0;
    for (const d of todo) {
      const v = await cboeDay(d);
      if (v == null || !Object.keys(v).length) {
        if (d < end - 4 * DAY) missing.add(d); // 오래된 날인데 없으면 휴장일 → 다시 묻지 않는다
        continue;
      }
      for (const [id, val] of Object.entries(v)) await db.putBars(id, "1D", [pt(d, val)]);
      if (++n % 20 === 0) {
        await db.metaSet("cboe|missing", [...missing]);
        onBatch();
      }
    }
    await db.metaSet("cboe|missing", [...missing]);
    if (n) {
      logInfo(`[cboe] ${n}일 받음`);
      onBatch();
    }
    return n;
  })().finally(() => (cboeRunning = null));
  return cboeRunning;
}

/** CNN 공포·탐욕 최신으로 */
export async function updateCnn() {
  const id = "cnn:FEAR_GREED";
  const rng = await db.range(id, "1D");
  const start = rng ? ymd(rng.last - 10 * DAY) : "2021-01-01";
  try {
    const d = await getJson(`https://production.dataviz.cnn.io/index/fearandgreed/graphdata/${start}`, {
      headers: { "User-Agent": UA, Referer: "https://edition.cnn.com/", Accept: "application/json" },
    });
    const byDay = new Map();
    for (const x of d.fear_and_greed_historical?.data ?? []) {
      const day = Math.floor(x.x / 1000 / DAY) * DAY;
      byDay.set(day, Math.round(x.y * 10) / 10);
    }
    const rows = [...byDay].sort((a, b) => a[0] - b[0]).map(([t, v]) => pt(t, v));
    await db.putBars(id, "1D", rows);
    setSourceStatus("CNN", true);
    return { rows: rows.length, now: d.fear_and_greed ?? null };
  } catch (e) {
    setSourceStatus("CNN", false);
    throw e;
  }
}
