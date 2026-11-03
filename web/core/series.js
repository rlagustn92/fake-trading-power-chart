// 차트·백테스트가 쓰는 봉 만들기: 저장소에서 읽기 → 분할·배당 반영 → 정규장 거르기 → 봉 묶기
import * as db from "./db.js";
import { localDay } from "./tz.js";
import { TF_SEC, isDailyTf, splitList, dividendMultipliers, adjust, filterSession, aggregate, weekly, ratioBars } from "./bars.js";
import { baseTf } from "./intraday.js";

/**
 * @param info  describe(id) 결과
 * @param tf    화면 봉
 * @param o     {basis, ext(프리·애프터 포함), before(이 시각 이전만), limit(대략 봉 수)}
 * @returns {{bars, events, splits, more}} more=저장소에 더 오래된 봉이 남아 있음
 */
export async function loadSeries(info, tf, { basis = "split", ext = false, before = null, after = null, limit = 3000 } = {}) {
  if (info.kind === "ratio") {
    const [a, b] = await Promise.all(info.parts.map((p) => loadSeries(describeLite(p, info), tf, { basis, ext, before, after, limit })));
    return { bars: ratioBars(a.bars, b.bars), events: [], splits: [], more: a.more && b.more };
  }

  // 일봉·주봉: 저장된 일봉 전부 (7천~2만 개라 한 번에 읽어도 빠르다)
  if (isDailyTf(tf) && info.kind !== "perp") {
    let raw = await db.getBars(info.id, "1D", { limit: 200000 });
    if (info.tz === "Asia/Seoul") raw = dropHolidayFill(raw);
    const events = info.splits ? await db.getEvents(info.id) : [];
    const splits = splitList(events);
    const divMult = basis === "total" ? dividendMultipliers(raw, events) : null;
    let bars = adjust(raw, { splits, divMult, basis });
    if (tf === "1W") bars = weekly(bars);
    return { bars, events, splits, more: false };
  }

  if (info.kind === "perp") {
    if (after != null) {
      const bars = await db.getBars(info.id, tf, { after, limit });
      return { bars, events: [], splits: [], more: true, moreNewer: bars.length >= limit };
    }
    const bars = await db.getBars(info.id, tf, { before, limit });
    return { bars, events: [], splits: [], more: bars.length >= limit };
  }

  // 분봉: 저장 봉(1m·5m·1h)을 필요한 만큼만 읽어서 묶는다
  const base = baseTf(info, tf);
  if (!base) return { bars: [], events: [], splits: [], more: false };
  const ratio = TF_SEC[tf] / TF_SEC[base];
  const want = Math.ceil(limit * ratio);
  // after: 그 시각부터 앞으로 limit개 (날짜로 가기·오른쪽으로 이어 읽기), 아니면 before 앞으로 limit개
  const raw = after != null ? await db.getBars(info.id, base, { after, limit: want }) : await db.getBars(info.id, base, { before, limit: want });
  const more = after != null ? true : raw.length >= want;
  const moreNewer = after != null && raw.length >= want; // 그 뒤에 더 있음 (아직 지금까지 안 옴)
  const lastRawT = raw.length ? raw[raw.length - 1].t : null;
  const events = info.splits ? await db.getEvents(info.id) : [];
  const splits = splitList(events);
  let rows = adjust(raw, { splits, basis: basis === "total" ? "split" : basis, dayOf: (t) => localDay(info.dayTz, t) });
  if (!ext && info.rth) rows = filterSession(rows, info.tz, info.rth);
  if (ratio > 1) {
    rows = aggregate(rows, TF_SEC[tf], info.tz, ext ? info.extAnchor : info.anchor);
    if (after == null && more && rows.length) rows.shift(); // 가장 앞 봉은 앞부분이 잘렸을 수 있다
    if (moreNewer && rows.length) rows.pop(); // 뒤로 이어 읽을 때는 마지막 봉이 잘렸을 수 있다
  }
  return { bars: rows, events, splits, more, moreNewer, base, lastRawT };
}

/** 저장된 원본 봉 + 실시간 꼬리(저장 안 한 1분봉)를 합쳐 화면 봉으로 (마지막 몇 개만) */
export async function liveTail(info, tf, tail1m, { basis = "split", ext = false, splits = [], fromT }) {
  const base = baseTf(info, tf);
  const recent = await db.getBars(info.id, base, { after: fromT, limit: 5000 });
  const lastBase = recent.length ? recent[recent.length - 1].t + TF_SEC[base] : fromT;
  const rows = [...recent, ...tail1m.filter((k) => k.t >= lastBase)];
  if (!rows.length) return [];
  let out = adjust(rows, { splits, basis: basis === "total" ? "split" : basis, dayOf: (t) => localDay(info.dayTz, t) });
  if (!ext && info.rth) out = filterSession(out, info.tz, info.rth);
  return tf === "1m" ? out : aggregate(out, TF_SEC[tf], info.tz, ext ? info.extAnchor : info.anchor);
}

/**
 * Yahoo 국내 일봉은 휴장일(삼일절·어린이날 등)에 거래량 0 + 전날 종가 그대로인 봉을 끼워 준다 → 뺀다
 * (삼성전자 2000~2022년 126일). 진짜 거래일이면 거래량이 있거나 값이 움직인다.
 */
export function dropHolidayFill(rows) {
  return rows.filter((b, i) => !(i > 0 && !b.v && b.o === b.c && b.h === b.c && b.l === b.c && b.c === rows[i - 1].c));
}

/** 데이터 빈 날: 평일인데 봉이 없는 날 중 긴 구멍(평일 8일 넘게 — 명절 연휴보다 긴 것)만 센다 */
export function dataGaps(bars) {
  let days = 0;
  let longest = null;
  for (let i = 1; i < bars.length; i++) {
    const span = Math.round((bars[i].t - bars[i - 1].t) / 86400);
    if (span <= 9) continue;
    let wd = 0;
    for (let k = 1; k < span; k++) {
      const w = (Math.floor(bars[i - 1].t / 86400) + k + 4) % 7;
      if (w !== 0 && w !== 6) wd++;
    }
    if (wd <= 7) continue;
    days += wd;
    if (!longest || wd > longest.days) longest = { days: wd, from: bars[i - 1].t, to: bars[i].t };
  }
  return { days, longest };
}

/** 비율 차트의 각 종목 정보 (순환 import를 피하려고 describe를 넘겨받지 않고 info.partInfos 사용) */
function describeLite(id, ratioInfo) {
  return ratioInfo.partInfos?.find((p) => p.id === id);
}

