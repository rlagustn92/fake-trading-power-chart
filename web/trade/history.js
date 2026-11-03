// 리플레이 연습용 과거 봉 받기 (DATA_RESEARCH.md §3): Binance 주식 무기한선물은 1분봉을 상장일부터 다 준다 (키 없음, 읽기 전용).
// 원본 앱은 처음에 최근 4,500봉(1분봉 약 3일)만 받는다 → 여기서 정한 날짜(또는 상장일)까지 뒤로 채운다.
// - 1·5·15분·1·4시간봉을 같은 날짜까지 (칸의 봉이 무엇이든 같은 기간이 보이게)
// - 요청 1번 = 1,500봉, 무게 10. 거래소 한도는 분당 2,400 → 0.35초 간격(분당 약 170번 = 무게 1,700)으로 천천히
// - 메타 `종목|봉|replay_from` = "여기부터 지금까지는 빈틈없이 받았음" (0이면 상장일부터 전부) → 중간에 꺼도 이어서
import * as db from "../core/db.js";
import * as BN from "../sources/binance.js";
import * as TS from "../sources/toss.js";
import { TF_SEC } from "../core/bars.js";
import { DAY } from "../core/tz.js";
import { logInfo } from "../platform.js";

export const BACKFILL_TFS = ["1m", "5m", "15m", "30m", "1h", "4h"];
const PAGE = 1500;
const PAUSE_MS = 350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 이 종목을 과거로 더 받을 수 있나 (Binance만: Hyperliquid는 봉 종류마다 최근 5,000개뿐) */
export const canBackfill = (info) => info.kind === "perp" && info.daily === "binance";

/** 지금까지 빈틈없이 이어진 덩어리의 첫 봉 (gaps = db.gaps 결과, 오래된 순) */
export const blockStart = (gaps, first) => (gaps.length ? gaps[gaps.length - 1][1] : first);

/** 차트를 뒤로 밀거나 옛날 구간에서 리플레이하면 떨어진 덩어리가 생긴다 → 지금까지 이어진 부분의 시작만 센다 */
async function solidFrom(sym, tf, first) {
  const gaps = await db.gaps(sym, tf, Math.max(30 * 60, 3 * TF_SEC[tf])).catch(() => []);
  return blockStart(gaps, first);
}

/** 1분봉이 언제부터 언제까지 빈틈없이 있나 → {first, last, days, all(상장일부터 다 받음)} | null */
export async function coverage(info) {
  const r = await db.range(info.id, "1m");
  if (!r) return null;
  const from = await db.metaGet(`${info.id}|1m|replay_from`);
  // 빈 곳으로 자르는 것은 24시간 시장(Binance)만: 주식은 밤마다 장이 닫혀 봉 사이가 벌어진다
  const first = from === 0 || !canBackfill(info) ? r.first : await solidFrom(info.id, "1m", r.first);
  const toss = canToss(info) ? await db.metaGet(`${info.id}|toss_from`) : null;
  return { first, last: r.last, count: r.count, days: (r.last - first) / DAY, all: from === 0 || toss === 0 };
}

/**
 * 차트를 왼쪽 끝까지 밀었는데 저장된 봉이 끝났을 때 (사용자 요청 2026-10-30: 5분봉을 뒤로 밀어도 보름치뿐):
 * 저장된 가장 옛 봉 앞을 거래소에서 더 받는다. 한 번에 pages번(1,500봉씩, 5분봉이면 약 15일). 반환: 새로 받은 봉 수 (0 = 상장일까지 왔음)
 */
export async function fetchOlder(info, tf, pages = 3) {
  if (!canBackfill(info) || !BN.TF[tf]) return 0;
  const r = await db.range(info.id, tf);
  if (!r) return 0;
  let end = r.first;
  let added = 0;
  for (let i = 0; i < pages; i++) {
    const rows = (await BN.klines(info.symbol, tf, { endSec: end - 1, limit: PAGE })).filter((k) => k.t < end);
    if (rows.length) await db.putBars(info.id, tf, rows);
    added += rows.length;
    if (rows.length < PAGE) {
      await db.metaSet(`${info.id}|${tf}|listed`, 1); // 상장일까지 왔다 (💰 "2년 더 받기"가 더 받지 않게)
      break;
    }
    end = rows[0].t;
    await sleep(PAUSE_MS);
  }
  if (added) logInfo(`[trade] ${info.id} ${tf} 차트 뒤로 ${added}봉 더 받음`);
  return added;
}

/**
 * 리플레이 시각 t 앞 300봉까지 저장돼 있게 (Binance만): 저장된 맨 앞부터 이어서 뒤로 받는다 (구멍 없이).
 * 리플레이 중에 봉을 바꾸거나(15분 → 4시간) 분할 화면의 다른 칸이 같이 갈 때. 한 번에 4,500봉씩 최대 maxCalls번
 */
export async function reachBack(info, tf, t, { maxCalls = 30 } = {}) {
  if (!canBackfill(info) || !BN.TF[tf] || !TF_SEC[tf]) return 0;
  const want = t - 300 * TF_SEC[tf];
  let added = 0;
  for (let i = 0; i < maxCalls; i++) {
    const r = await db.range(info.id, tf);
    if (!r || r.first <= want) break;
    const n = await fetchOlder(info, tf);
    if (!n) break; // 상장일까지 왔다
    added += n;
  }
  return added;
}

/**
 * from~to 1분봉이 저장돼 있게 (Binance만): 차트를 뒤로 밀어 고른 옛날 구간에서 리플레이할 때, 재생하다 받아 둔 끝에 닿을 때.
 * 1분봉이 없으면 체결을 1분봉으로 볼 수 없다. 거의 다 있으면 받지 않는다. 반환: 새로 받은 봉 수
 */
const minuteJobs = new Map(); // 종목 → 받는 중. 리플레이 칸과 💰 창이 같은 빈 곳을 동시에 받지 않게 차례로 (뒤에 온 쪽은 이미 있으면 안 받는다)
export async function ensureMinutes(info, from, to) {
  const prev = minuteJobs.get(info.id);
  if (prev) await prev.catch(() => {});
  const p = ensureMinutesNow(info, from, to);
  minuteJobs.set(info.id, p);
  try {
    return await p;
  } finally {
    if (minuteJobs.get(info.id) === p) minuteJobs.delete(info.id);
  }
}
async function ensureMinutesNow(info, from, to) {
  if (!canBackfill(info)) return 0;
  from = Math.floor(from / 60) * 60;
  to = Math.min(to, Math.floor(Date.now() / 1000 / 60) * 60 - 60);
  if (!(to > from)) return 0;
  const have = await db.getBars(info.id, "1m", { after: from, before: to, limit: 20000 });
  if (have.length >= ((to - from) / 60) * 0.98) return 0;
  let start = from;
  let added = 0;
  while (start < to) {
    const rows = (await BN.klines(info.symbol, "1m", { startSec: start, limit: PAGE })).filter((k) => k.t >= start && k.t < to);
    if (!rows.length) break;
    await db.putBars(info.id, "1m", rows);
    added += rows.length;
    start = rows[rows.length - 1].t + 60;
    if (start < to) await sleep(PAUSE_MS);
  }
  if (added) logInfo(`[trade] ${info.id} 1분봉 ${new Date(from * 1000).toISOString().slice(0, 16)}부터 ${added}개 받음`);
  return added;
}

/**
 * days일 전(또는 null = 상장일)까지 뒤로 채우기.
 * onProgress(0~1, 글자). stop()이 true를 돌려주면 멈춘다(다음에 이어서). 반환: 새로 받은 봉 수
 */
export async function backfill(info, { days = 30, onProgress = () => {}, stop = () => false } = {}) {
  if (!canBackfill(info)) return 0;
  const now = Math.floor(Date.now() / 1000);
  const plan = [];
  for (const tf of BACKFILL_TFS) {
    const done = await db.metaGet(`${info.id}|${tf}|replay_from`);
    const listed = await listedAt(info, tf);
    const target = Math.max(days == null ? 0 : now - days * DAY, listed ?? 0);
    if (done != null && done <= target) continue;
    const r = await db.range(info.id, tf);
    const end = r ? await solidFrom(info.id, tf, r.first) : now; // 떨어진 옛 덩어리 말고, 지금까지 이어진 부분 앞부터
    plan.push({ tf, end, target, toListing: listed != null && target === listed });
  }
  const run = await spanPlan(info, plan, { onProgress, stop });
  for (const p of plan) {
    // "여기부터 지금까지 빈틈없음": 받아 둔 가장 옛 봉 (상장일까지 왔으면 0)
    if (p.done != null) await db.metaSet(`${info.id}|${p.tf}|replay_from`, p.done <= p.target && p.toListing ? 0 : p.done);
  }
  if (run.failed) throw run.failed;
  let added = run.added;
  if (!stop()) added += await fillHoles(info, onProgress);
  onProgress(1, stop() ? "멈췄어요 (다음에 이어서 받아요)" : "다 받았어요");
  if (added) logInfo(`[trade] ${info.id} 리플레이용 과거 봉 ${added}개 받음 (${run.secs}초)`);
  return added;
}

// ── 빠르게 받기 (0.12.1, 사용자 "과거 1분봉 받는 데 엄청 오래 걸리네" → 바이낸스 한도의 절반까지) ──
// 전에는 1,500봉씩 하나씩 0.35초 쉬며 (한도의 약 30%, BTC 1분봉 전부 30분 넘게).
// 이제 1,000봉 창(무게 5, 1,500봉의 절반)으로 나눠 3개씩 함께, 1분 무게는 sources/binance.js가 1,200(절반)까지만 → 약 2배
// 24시간 종목이라 창마다 봉 수가 정해져 있어 창을 미리 나눌 수 있다 (앞 쪽 결과를 기다리지 않음)
const WIN = 1000;
const WORKERS = 3;

/** 그 봉 종류의 첫 봉 시각 = 상장 (바이낸스에 처음부터 한 개만 물어봄, 무게 1). 진행률·끝을 정확히 알려고 */
async function listedAt(info, tf) {
  const key = `${info.id}|${tf}|first`;
  const m = await db.metaGet(key);
  if (m != null) return m;
  try {
    const t = (await BN.klines(info.symbol, tf, { startSec: 0, limit: 1 }))[0]?.t ?? null;
    if (t != null) await db.metaSet(key, t);
    return t;
  } catch {
    return null;
  }
}

/**
 * plan = [{tf, end, target}] 마다 end 앞에서 target까지 1,000봉 창으로 받는다 (전체 창 수로 진행률).
 * 각 p에 p.done(여기부터 end까지 빈틈없이 받음)을 적는다. 반환 {added, failed(오류), secs}
 */
async function spanPlan(info, plan, { onProgress = () => {}, stop = () => false } = {}) {
  const t0 = Date.now();
  for (const p of plan) {
    p.wins = [];
    for (let e = p.end; e > p.target; e -= WIN * TF_SEC[p.tf]) p.wins.push({ s: Math.max(p.target, e - WIN * TF_SEC[p.tf]), e, ok: false });
  }
  const total = plan.reduce((s, p) => s + p.wins.length, 0) || 1;
  let n = 0;
  let added = 0;
  let failed = null;
  for (const p of plan) {
    if (stop() || failed) break;
    let next = 0;
    let oldest = p.end;
    const worker = async () => {
      while (!failed && !stop() && next < p.wins.length) {
        const w = p.wins[next++];
        try {
          const rows = (await BN.klines(info.symbol, p.tf, { startSec: w.s, endSec: w.e - 1, limit: WIN, bulk: true })).filter((k) => k.t >= w.s && k.t < w.e);
          if (rows.length) await db.putBars(info.id, p.tf, rows);
          added += rows.length;
          w.ok = true;
          oldest = Math.min(oldest, w.s);
          onProgress(Math.min(0.99, ++n / total), `${TF_KO[p.tf] ?? p.tf} ${new Date(oldest * 1000).toISOString().slice(0, 10)}까지`);
        } catch (e) {
          failed = e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, p.wins.length) }, worker));
    // 지금 쪽부터 끊김 없이 받은 곳 (멈추거나 실패하면 거기까지만 → 다음에 이어서)
    p.done = p.end;
    for (const w of p.wins) {
      if (!w.ok) break;
      p.done = w.s;
    }
  }
  return { added, failed, secs: Math.round((Date.now() - t0) / 1000) };
}

// ── 차트 봉 2년씩 받기 (사용자 요청 2026-10-30: "5분봉을 뒤로 당기고 당기고 받는데 한 번에" → "끝까지 말고 2년치씩") ──
// 한 번 누르면 지금부터 2년 전까지, 다시 누르면 4년·6년 전까지. 5분·15분·1시간·4시간봉을 같은 날짜까지 (1분봉은 리플레이 때 그 근처만)

export const CHART_TFS = ["5m", "15m", "30m", "1h", "4h"];
export const YEAR = 365 * DAY;
export const CHART_STEP = 2; // 한 번에 받는 해
const TF_KO = { "1m": "1분봉", "5m": "5분봉", "15m": "15분봉", "30m": "30분봉", "1h": "1시간봉", "4h": "4시간봉" };

/** 지금 first(가장 옛 봉)까지 있으면 다음에 받을 곳 = 지금부터 2·4·6…년 전 중 first보다 앞인 첫 곳 (거의 다 찬 2년은 다 찬 것으로) */
export function nextYears(first, now, step = CHART_STEP) {
  const have = Math.max(0, (now - first) / YEAR);
  return (Math.floor(have / step + 0.05) + 1) * step;
}

/** 차트 봉이 얼마나 뒤까지 있나 → {first(없으면 null), years(있는 해), next(다음에 받을 해), all(더 옛날이 없음), src} | null(받을 수 없는 종목) */
export async function chartCoverage(info) {
  const now = Math.floor(Date.now() / 1000);
  let first;
  let all;
  let src;
  if (canBackfill(info)) {
    first = (await db.range(info.id, "5m"))?.first ?? null; // 처음 여는 종목은 차트가 읽히기 전이라 아직 없다
    all = (await db.metaGet(`${info.id}|5m|listed`)) === 1;
    src = "binance";
  } else if (canToss(info)) {
    // 국내 주식: 토스 1분봉으로 1분·5분·1시간봉을 만든다 (4시간봉은 1시간봉, 15분봉은 5분봉을 묶어서)
    const from = await db.metaGet(`${info.id}|toss_from`);
    first = Math.min(from || Infinity, (await db.range(info.id, "1m"))?.first ?? now);
    all = from === 0;
    src = "toss";
  } else return null;
  return { first, years: first == null ? 0 : (now - first) / YEAR, next: nextYears(first ?? now, now), all, src };
}

/** 차트 봉을 지금부터 years년 전까지 (이미 있는 가장 옛 봉 앞부터 이어서). onProgress(0~1, 글자), stop() → 멈춤. 반환: 새로 받은 봉 수 */
export async function backfillChart(info, { years = CHART_STEP, onProgress = () => {}, stop = () => false } = {}) {
  if (canToss(info)) return backfillToss(info, { days: years * 365, onProgress, stop });
  if (!canBackfill(info)) return 0;
  const want = Math.floor(Date.now() / 1000) - years * YEAR;
  const plan = [];
  for (const tf of CHART_TFS) {
    if ((await db.metaGet(`${info.id}|${tf}|listed`)) === 1) continue;
    const listed = await listedAt(info, tf);
    const target = Math.max(want, listed ?? 0);
    const end = (await db.range(info.id, tf))?.first ?? Math.floor(Date.now() / 1000);
    if (end > target) plan.push({ tf, end, target, toListing: listed != null && target === listed });
    else if (listed != null && end <= listed) await db.metaSet(`${info.id}|${tf}|listed`, 1);
  }
  const run = await spanPlan(info, plan, { onProgress, stop });
  for (const p of plan) if (p.toListing && p.done != null && p.done <= p.target) await db.metaSet(`${info.id}|${p.tf}|listed`, 1); // 상장일까지 왔다
  if (run.failed) throw run.failed;
  let added = run.added;
  // 그 사이에 빈 곳(앱을 오래 꺼 둔 때 등)이 있으면 메운다
  if (!stop()) added += await fillHoles(info, onProgress, CHART_TFS, want);
  onProgress(1, stop() ? "멈췄어요 (다시 누르면 이어서 받아요)" : "다 받았어요");
  if (added) logInfo(`[trade] ${info.id} 차트 봉 ${years}년치까지 ${added}봉 받음 (${run.secs}초)`);
  return added;
}

// ── 토스 국내 1분봉 깊이 (사용자 요청 2026-10-30: 삼성전자 4시간봉이 야후 2년치뿐 → 토스로 더 옛날을 받을 수 있나) ──
// 토스 문서에는 얼마나 옛날까지 주는지가 없다 → 직접 물어본다. 받아 쌓는 기능은 결과를 보고 정한다 (아직 저장 안 함)

/**
 * 있는 곳·없는 곳 찾기: 7일·30일·…·10년 전을 차례로 → 처음 "없음"이 나오면 그 사이를 반씩 좁힌다.
 * has(t) = t 근처(7일 안)에 봉이 있나. 반환 {oldest(있는 가장 옛 시각 근처, 없으면 null), beyond(10년 전까지 다 있음), checked}
 */
export async function findDepth(has, now, { backs = [7, 30, 90, 180, 365, 730, 1095, 1825, 3650], steps = 8 } = {}) {
  const checked = [];
  let yes = null;
  let no = null;
  for (const d of backs) {
    const t = now - d * DAY;
    const ok = await has(t);
    checked.push({ t, ok });
    if (!ok) {
      no = t;
      break;
    }
    yes = t;
  }
  if (yes == null) return { oldest: null, checked };
  if (no == null) return { oldest: yes, beyond: true, checked };
  for (let i = 0; i < steps && yes - no > 2 * DAY; i++) {
    const mid = Math.round((yes + no) / 2);
    const ok = await has(mid);
    checked.push({ t: mid, ok });
    if (ok) yes = mid;
    else no = mid;
  }
  return { oldest: yes, checked };
}

// 확인 결과 (2026-10-30 EXE): 삼성전자 1분봉이 2022-11-23까지 (약 4년) — 야후 1시간봉 2년의 두 배

/** 토스로 국내 1분봉을 받을 수 있나 (국내 주식·ETF + 토스 키) */
export const canToss = (info) => info.kind === "kr" && TS.tossable(info.id) && TS.hasKey() && !TS.isStandby();

/** 1분봉 → sec초 봉 (묶음 시작 = sec로 나눈 시각. 한국 시각 정시 = UTC 정시라 야후 1시간·5분봉과 같은 자리) */
export function bucketRows(rows, sec) {
  const out = [];
  let cur = null;
  for (const k of rows) {
    const t = Math.floor(k.t / sec) * sec;
    if (!cur || cur.t !== t) {
      cur = { t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v ?? 0 };
      out.push(cur);
    } else {
      if (k.h > cur.h) cur.h = k.h;
      if (k.l < cur.l) cur.l = k.l;
      cur.c = k.c;
      cur.v += k.v ?? 0;
    }
  }
  return out;
}

/** 정규장(09:00~15:30 한국 시각)만: 야후 국내 분봉과 맞춘다 (토스가 넥스트레이드 시간도 줄 수 있어서) */
export const krRegular = (k) => {
  const m = Math.floor(((k.t + 9 * 3600) % DAY) / 60);
  return m >= 9 * 60 && m <= 15 * 60 + 30;
};

/**
 * 토스로 국내 1분봉을 days일 전(null = 받을 수 있는 만큼, 약 4년)까지 뒤로 받아 1분·5분·1시간봉으로 저장한다.
 * (사용자 요청 2026-10-30: "4시간봉도 뒤로") 4시간봉은 1시간봉, 15분봉은 5분봉을 묶어 그린다.
 * - 이미 있는 봉(야후: 1분 30일·5분 60일·1시간 2년)보다 옛날 것만 넣는다 → 야후 봉과 섞이지 않게
 * - 한 번에 200개(반나절), 0.05초씩 더 쉬어 Market Board와 토스 한도를 나눠 쓴다. 4년이면 2,000번 넘게 → 5~10분
 * - 메타 `종목|toss_from` = 여기부터 지금까지 받았음 (0 = 토스에 있는 맨 앞까지) → 중간에 멈춰도 이어서
 */
export async function backfillToss(info, { days = null, onProgress = () => {}, stop = () => false } = {}) {
  if (!canToss(info)) return 0;
  const now = Math.floor(Date.now() / 1000);
  const target = days == null ? 0 : now - days * DAY;
  const done = await db.metaGet(`${info.id}|toss_from`);
  if (done === 0 || (done != null && done <= target)) return onProgress(1, "다 받았어요"), 0;
  const first = {};
  for (const tf of ["1m", "5m", "1h"]) first[tf] = (await db.range(info.id, tf))?.first ?? Infinity;
  const span = now - (target || now - 4 * 365 * DAY);
  let before = done ?? now;
  let saved = before; // 여기부터 지금까지는 저장했음
  let buf = []; // 아직 1시간이 다 차지 않은 앞쪽 1분봉
  let added = 0;
  let pages = 0;
  let reached = false;
  const flush = async (cut) => {
    const ready = buf.filter((k) => k.t >= cut);
    buf = buf.filter((k) => k.t < cut);
    if (ready.length) {
      const m1 = ready.filter((k) => k.t < first["1m"]);
      const m5 = bucketRows(ready, 300).filter((k) => k.t < first["5m"]);
      const h1 = bucketRows(ready, 3600).filter((k) => k.t < first["1h"]);
      if (m1.length) await db.putBars(info.id, "1m", m1);
      if (m5.length) await db.putBars(info.id, "5m", m5);
      if (h1.length) await db.putBars(info.id, "1h", h1);
      added += m1.length;
    }
    if (cut < saved) saved = cut;
  };
  while (before > target && !stop()) {
    // 요청 사이는 Rust 관문이 0.072초씩 띄운다 + 응답 기다리는 시간 → 초당 6번쯤 (토스 한도의 3분의 1, Market Board 몫을 남긴다)
    const { rows } = await TS.candlesPage(info.id, { interval: "1m", count: 200, before });
    const page = rows.filter((k) => k.t <= before);
    if (!page.length) {
      reached = true; // 토스에 있는 맨 앞까지 왔다
      break;
    }
    buf = [...page.filter(krRegular), ...buf];
    before = page[0].t - 60;
    // 1시간이 다 찬 부분만 저장 (그 앞 1분봉은 다음 쪽에서 더 온다)
    await flush(Math.ceil(page[0].t / 3600) * 3600);
    if (++pages % 20 === 0) await db.metaSet(`${info.id}|toss_from`, saved);
    onProgress(Math.min(0.99, (now - page[0].t) / span), `${new Date((page[0].t + 9 * 3600) * 1000).toISOString().slice(0, 10)}까지`);
  }
  // 맨 앞까지 왔으면 남은 것도 저장 · 정한 날짜에서 멈췄으면 덜 찬 1시간은 버린다 (다음에 더 옛날을 받을 때 다시 온다)
  if (reached) await flush(-Infinity);
  await db.metaSet(`${info.id}|toss_from`, reached ? 0 : saved);
  onProgress(1, stop() ? "멈췄어요 (다음에 이어서 받아요)" : "다 받았어요");
  if (added) logInfo(`[trade] ${info.id} 토스 1분봉 ${added}개 받음 (${pages}번)`);
  return added;
}

/** 토스에 이 종목 1분봉을 얼마나 옛날까지 있나 물어본다 (요청 약 15~20번, 2초쯤). onProgress(글자) */
export async function probeToss(info, onProgress = () => {}) {
  const has = async (t) => {
    onProgress(`${new Date(t * 1000).toISOString().slice(0, 10)} 확인 중…`);
    try {
      const { rows } = await TS.candlesPage(info.id, { interval: "1m", count: 3, before: t });
      return rows.length > 0 && t - rows[rows.length - 1].t < 7 * DAY;
    } catch (e) {
      if (/HTTP 40[04]/.test(String(e?.message ?? e))) return false; // 너무 옛날이라 거절 = 없음
      throw e; // 대기·한도·인터넷 문제는 "없음"이 아니다
    }
  };
  const r = await findDepth(has, Math.floor(Date.now() / 1000));
  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  logInfo(`[trade] 토스 1분봉 깊이 ${info.id}: ${r.oldest == null ? "없음" : `${day(r.oldest)}${r.beyond ? " (10년 전까지 다 있음)" : ""}`} · ${r.checked.map((c) => `${day(c.t)}${c.ok ? "○" : "×"}`).join(" ")}`);
  return r;
}

/** 껐다 켠 사이에 생긴 빈 곳 메우기 (24시간 시장이라 봉 사이가 벌어지면 빠진 것). after = 이 시각 뒤의 빈 곳만 */
async function fillHoles(info, onProgress, tfs = BACKFILL_TFS, after = 0) {
  let added = 0;
  for (const tf of tfs) {
    const gaps = (await db.gaps(info.id, tf, Math.max(30 * 60, 3 * TF_SEC[tf])).catch(() => [])).filter(([, b]) => b > after);
    for (const [a, b] of gaps.slice(0, 40)) {
      let start = a + TF_SEC[tf];
      for (let i = 0; i < 30 && start < b; i++) {
        const rows = (await BN.klines(info.symbol, tf, { startSec: start, limit: PAGE, bulk: true })).filter((k) => k.t < b);
        if (!rows.length) break;
        await db.putBars(info.id, tf, rows);
        added += rows.length;
        start = rows[rows.length - 1].t + TF_SEC[tf];
        onProgress(0.99, `빈 곳 메우는 중 (${tf})`);
        await sleep(PAUSE_MS);
      }
    }
  }
  return added;
}
