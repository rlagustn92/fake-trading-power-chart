// 🔔 알림 확인 (SPEC §3.6)
// - 앱이 켜져 있을 때만 (창이 뒤에 있어도 됨). 트레이 상주 없음
// - 기본은 봉이 마감될 때만 확인 → 잠깐 찔렀다 돌아오는 것에 울리지 않게. 바꾸면 실시간
// - 기본은 한 번 울리면 꺼짐, 바꾸면 넘을 때마다
// 알림 = {id, sym, tf, kind, op, value, ind, drawingId, log, stage, live, once, on, lastBarT, fired}
//   kind: price(가격 선) | ind(지표 선) | rsi(RSI 기준선) | line(그린 선) | stage(심리 지표 단계)
//         pct(전일 종가 대비 ±%) | vwapdist(VWAP에서 ±% 벌어짐) | dayhigh(당일 신고가) | daylow(당일 신저가)
//   op:   up(위로) | down(아래로) | cross(어느 쪽이든)
import { describe } from "../core/symbols.js";
import { loadSeries, liveTail } from "../core/series.js";
import { TF_SEC, isDailyTf, mergeRows, mondayOf } from "../core/bars.js";
import { DAY, today, localSec, localDay, tzOffset } from "../core/tz.js";
import { TF_NAME } from "../core/data.js";
import * as C from "../indicators/calc.js";
import { stageOf, SENTIMENT } from "../indicators/sentiment.js";
import { createMapper } from "../drawings/geom.js";
import { mapHtf } from "../indicators/index.js";
import { drawingValueAt, TOOLS } from "../drawings/layer.js";
import { findDrawing } from "../drawings/store.js";
import { notify, chime, logInfo } from "../platform.js";
import { num } from "../ui/format.js";

export const IND_NAME = { sma: "SMA", ema: "EMA", vwma: "VWMA", vwap: "VWAP", orbh: "ORH", orbl: "ORL", bb_up: "BB", bb_dn: "BB", vwbb_up: "VWBB", vwbb_dn: "VWBB" };
/** 밴드 선 알림 (볼린저·VWBB의 위·아래 밴드) */
const isBand = (id) => /^(vw)?bb_(up|dn)$/.test(id ?? "");

/** 알림 한 줄 설명: "AMD 5분봉 · 가격이 VWMA 100 위로 뚫으면" */
export function alertText(a) {
  const info = describe(a.sym);
  const head = `${info.label} ${TF_NAME[a.tf]}봉`;
  const dirWord = a.op === "up" ? "위로" : a.op === "down" ? "아래로" : "위·아래로";
  let what = "";
  if (a.kind === "price") what = `가격이 ${num(a.value, 4).replace(/\.?0+$/, "")} ${a.op === "up" ? "위로 올라가면" : a.op === "down" ? "아래로 내려가면" : "을 넘으면"}`;
  else if (a.kind === "ind") what = `가격이 ${indLabel(a.ind)} ${dirWord} 뚫으면${isOrb(a) ? " (그날 첫 돌파, 하루 한 번)" : ""}`;
  else if (a.kind === "rsi") what = `RSI ${a.ind?.length ?? 14}가 ${a.value} ${a.op === "down" ? "아래로" : "위로"} 가면`;
  else if (a.kind === "pct") what = `전일 종가보다 ${a.op === "down" ? "−" : "+"}${a.value}% ${a.op === "down" ? "넘게 내리면" : "넘게 오르면"}`;
  else if (a.kind === "vwapdist") what = `가격이 VWAP보다 ${a.value}% 넘게 ${a.op === "down" ? "아래로" : "위로"} 벌어지면`;
  else if (a.kind === "dayhigh") what = "장 시작 15분 뒤 처음으로 당일 신고가를 쓰면 (하루 한 번)";
  else if (a.kind === "daylow") what = "장 시작 15분 뒤 처음으로 당일 신저가를 쓰면 (하루 한 번)";
  else if (a.kind === "stage") what = `${SENTIMENT[a.sym]?.title.split(":")[0] ?? info.label}가 "${a.stage}" 단계에 들어가면`;
  else if (a.kind === "line") {
    const dw = findDrawing(a.sym, a.drawingId);
    const name = dw ? TOOLS[dw.type].name : "지운 선";
    what = dw?.type === "triangle" ? `가격이 ${name} 밖으로 나가면` : `가격이 ${name}${dw?.type === "avwap" ? "" : "을"} ${dirWord} 넘으면`;
  }
  return `${head} · ${what}`;
}

const indLabel = (ind) =>
  isBand(ind.id)
    ? `${IND_NAME[ind.id]} ${ind.params?.length ?? 20}${ind.params?.tf ? ` (${TF_NAME[ind.params.tf]}봉)` : ""} ${ind.id.endsWith("_up") ? "위" : "아래"} 밴드(${ind.params?.mult ?? 2}σ${ind.params?.tvLower && ind.id.endsWith("_dn") ? ", TV 방식" : ""})`
    : indLabelBase(ind);
const indLabelBase = (ind) => (ind.id === "orbh" || ind.id === "orbl" ? `${ind.id === "orbh" ? "ORH(장 시작" : "ORL(장 시작"} ${ind.params?.minutes ?? 15}분 ${ind.id === "orbh" ? "고가)" : "저가)"}` : ind.id === "vwap" ? "VWAP" : `${IND_NAME[ind.id] ?? ind.id} ${ind.params?.length ?? ""}${ind.params?.src && ind.params.src !== "c" ? ` ${C.SOURCES.find(([k]) => k === ind.params.src)?.[1] ?? ind.params.src}` : ""}${ind.params?.tf ? ` (${TF_NAME[ind.params.tf]}봉)` : ""}`.trim());

/** ORB(장 시작 N분 고가·저가) 돌파 알림인지 */
const isOrb = (a) => a.kind === "ind" && (a.ind?.id === "orbh" || a.ind?.id === "orbl") && (a.op === "up" || a.op === "down");
/** "그날 처음 넘은 봉"으로 보는 알림 (신고가·신저가·ORB): 앞 봉과 비교하는 교차로는 첫 돌파를 놓친다 (QA N4) */
export const isFirstBreak = (a) => a.kind === "dayhigh" || a.kind === "daylow" || isOrb(a);

/**
 * 그날 처음으로 기준을 넘은 봉인지: i번째 봉이 넘었고, 같은 날 앞 봉들은 한 번도 넘지 않았으면.
 * S = {x, lv(i), day[i]} · 기준이 아직 없는 봉(장 시작 직후)은 "안 넘음"으로 본다
 */
export function firstBreakAt(a, S, i) {
  const beyond = (k) => {
    const x = S.x[k];
    const l = S.lv(k);
    if (x == null || l == null) return false;
    const up = a.kind === "dayhigh" || (a.kind !== "daylow" && a.op === "up");
    return up ? x > l : x < l;
  };
  if (!beyond(i)) return false;
  for (let k = i - 1; k >= 0 && S.day[k] === S.day[i]; k--) if (beyond(k)) return false;
  return true;
}

/** 다른 봉 기준 지표 알림인지 (예: 5분봉 차트에서 15분봉 VWMA) */
const htfOf = (a) => (a.kind === "ind" && a.ind?.params?.tf && TF_SEC[a.ind.params.tf] > TF_SEC[a.tf] ? a.ind.params.tf : null);

/**
 * @param o {cfg, data, onFire(alert, text), onChange()}
 */
export function createAlerts({ cfg, data, onFire, onChange }) {
  const subs = new Map(); // `${sym}|${tf}` → 해제 함수 (실시간 갱신 받기)
  const lastSide = new Map(); // 실시간 확인: id → 지난번 위치
  let busy = false;

  const list = () => (cfg.alerts ??= []);
  const active = () => list().filter((a) => a.on);

  /** 켜진 알림의 종목·봉은 칸에 안 보여도 계속 이어 받는다 */
  function syncSubs() {
    const want = new Set(active().map((a) => `${a.sym}|${a.tf}`));
    for (const [k, off] of subs) if (!want.has(k)) (off(), subs.delete(k));
    for (const k of want) {
      if (subs.has(k)) continue;
      const [sym, tf] = [k.slice(0, k.lastIndexOf("|")), k.slice(k.lastIndexOf("|") + 1)];
      subs.set(k, data.subscribeLive(describe(sym), tf, () => schedule()));
    }
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(check, 800);
  }

  /** 봉 목록 (저장소 + 알파카 실시간 꼬리 + 일봉은 현재가) */
  async function barsFor(info, tf) {
    const basis = cfg.chart.price_basis ?? "split";
    const ext = !(cfg.chart.regular_hours_only ?? true);
    const s = await loadSeries(info, tf, { basis, ext, limit: isDailyTf(tf) ? undefined : 1500 });
    let bars = s.bars;
    if (!bars.length) return bars;
    const tail = data.tail(info.id);
    if (!isDailyTf(tf) && tail?.length) {
      const extra = await liveTail(info, tf, tail, { basis, ext, splits: s.splits, fromT: bars[bars.length - 1].t });
      bars = mergeRows(bars, extra.filter((b) => b.t >= bars[bars.length - 1].t));
    }
    const q = data.quote(info.id);
    if (isDailyTf(tf) && q?.ts && info.kind !== "sentiment") {
      let day = localDay(info.dayTz, q.ts);
      if (tf === "1W") day = mondayOf(day);
      const last = bars[bars.length - 1];
      if (day === last.t) bars = [...bars.slice(0, -1), { ...last, c: q.price, h: Math.max(last.h, q.price), l: Math.min(last.l, q.price) }];
      else if (day > last.t && day - last.t < 10 * DAY) bars = [...bars, { t: day, o: q.price, h: q.price, l: q.price, c: q.price, v: 0 }];
    }
    return bars;
  }

  /** 봉이 끝났는지 */
  function closed(info, tf, bar, now) {
    if (!isDailyTf(tf)) return now >= bar.t + TF_SEC[tf];
    if (info.kind === "sentiment") return true;
    const d = today(info.dayTz);
    if (tf === "1W") return mondayOf(d) > bar.t;
    if (d > bar.t) return true;
    const end = info.rth?.[1] ?? (info.kind === "kr" || info.tz === "Asia/Seoul" ? 15.5 * 3600 : null);
    return end != null && localSec(info.tz, now) >= end;
  }

  /** i번째 봉에서 비교할 값 x와 기준 lv (lv가 {up, dn}이면 삼각수렴). htf = 다른 봉 기준 지표의 상위 봉 */
  function series(a, info, bars, htf = null) {
    const close = bars.map((b) => b.c);
    switch (a.kind) {
      case "price":
        return { x: close, lv: () => a.value };
      case "rsi": {
        const r = C.rsi(bars, a.ind?.length ?? 14);
        return { x: r, lv: () => a.value };
      }
      case "ind": {
        const p = a.ind.params?.length ?? 20;
        const calc = (src) => {
          const c = C.source(src, a.ind.params?.src); // SMA·EMA 소스 (종가 기본, 고가·저가… 0.14.0)
          const dayKey = (t) => Math.floor((t + tzOffset(info.tz, t)) / DAY);
          if (isBand(a.ind.id)) {
            const m = a.ind.params?.mult ?? 2;
            const r = a.ind.id.startsWith("vwbb") ? C.vwbb(src, p, m, !!a.ind.params?.tvLower) : C.bollinger(src, p, m);
            return a.ind.id.endsWith("_up") ? r.upper : r.lower;
          }
          if (a.ind.id === "orbh" || a.ind.id === "orbl") {
            const tod = (t) => t + tzOffset(info.tz, t) - dayKey(t) * DAY;
            const r = C.openingRange(src, a.ind.params?.minutes ?? 15, dayKey, tod, info.rth ? info.rth[0] : info.anchor ?? 0);
            return a.ind.id === "orbh" ? r.hi : r.lo;
          }
          return a.ind.id === "sma" ? C.sma(c, p) : a.ind.id === "ema" ? C.ema(c, p) : a.ind.id === "vwma" ? C.vwma(src, p) : C.vwap(src, dayKey).vwap;
        };
        let vals;
        if (htf) {
          // 상위 봉은 끝난 것만 (차트와 같은 규칙, 미래 값 안 씀)
          const t2 = htfOf(a);
          const key = isDailyTf(t2) && !isDailyTf(a.tf) ? (t) => (t2 === "1W" ? mondayOf(localDay(info.dayTz, t)) : localDay(info.dayTz, t)) : (t) => t;
          vals = mapHtf(bars, htf, calc(htf), { htfKey: key, replaying: false });
        } else vals = calc(bars);
        const out = { x: close, lv: (i) => vals[i] };
        if (isOrb(a)) out.day = bars.map((b) => Math.floor((b.t + tzOffset(info.tz, b.t)) / DAY));
        return out;
      }
      case "line": {
        const dw = findDrawing(a.sym, a.drawingId);
        if (!dw) return null;
        const m = createMapper({ bars, tf: a.tf, info, ext: !(cfg.chart.regular_hours_only ?? true), log: !!a.log });
        return { x: close, lv: (i) => drawingValueAt(dw, m, bars, i, info) };
      }
      case "stage":
        return { x: close, stage: (i) => stageOf(a.sym, close[i])?.name };
      case "pct": {
        // 전일 종가: 일봉이면 앞 봉, 분봉이면 앞 날(거래소 날짜)의 마지막 종가
        const prev = new Array(bars.length).fill(null);
        if (isDailyTf(a.tf)) for (let i = 1; i < bars.length; i++) prev[i] = bars[i - 1].c;
        else {
          const dk = (t) => Math.floor((t + tzOffset(info.tz, t)) / DAY);
          let lastClose = null;
          let day = null;
          let dayClose = null;
          for (let i = 0; i < bars.length; i++) {
            const d = dk(bars[i].t);
            if (d !== day) {
              lastClose = dayClose;
              day = d;
            }
            prev[i] = lastClose;
            dayClose = bars[i].c;
          }
        }
        const k = (a.op === "down" ? -1 : 1) * (+a.value || 0) / 100;
        return { x: close, lv: (i) => (prev[i] == null ? null : prev[i] * (1 + k)) };
      }
      case "vwapdist": {
        const v = C.vwap(bars, (t) => Math.floor((t + tzOffset(info.tz, t)) / DAY)).vwap;
        const k = (a.op === "down" ? -1 : 1) * (+a.value || 0) / 100;
        return { x: close, lv: (i) => (v[i] == null ? null : v[i] * (1 + k)) };
      }
      case "dayhigh":
      case "daylow": {
        // 그날 앞 봉들의 최고가(최저가)를 넘으면. 장 시작 15분 동안은 매 봉이 신고가라 건너뛴다
        const hi = a.kind === "dayhigh";
        const dk = (t) => Math.floor((t + tzOffset(info.tz, t)) / DAY);
        const start = info.rth ? info.rth[0] : info.anchor ?? 0;
        const lv = new Array(bars.length).fill(null);
        let day = null;
        let ext = null;
        for (let i = 0; i < bars.length; i++) {
          const b = bars[i];
          const d = dk(b.t);
          if (d !== day) {
            day = d;
            ext = null;
          }
          const sod = b.t + tzOffset(info.tz, b.t) - d * DAY;
          if (ext != null && sod >= start + 15 * 60) lv[i] = ext;
          if (sod >= start) ext = ext == null ? (hi ? b.h : b.l) : hi ? Math.max(ext, b.h) : Math.min(ext, b.l);
        }
        return { x: bars.map((b) => (hi ? b.h : b.l)), lv: (i) => lv[i], day: bars.map((b) => dk(b.t)) };
      }
    }
    return null;
  }

  /** prev → cur 사이에 조건이 일어났는지 */
  function happened(a, S, i0, i1) {
    if (a.kind === "stage") return S.stage(i1) === a.stage && S.stage(i0) !== a.stage;
    if (isFirstBreak(a) && S.day) return firstBreakAt(a, S, i1);
    const x0 = S.x[i0];
    const x1 = S.x[i1];
    const l0 = S.lv(i0);
    const l1 = S.lv(i1);
    if (x0 == null || x1 == null || l0 == null || l1 == null) return false;
    if (typeof l1 === "object") return (x0 <= l0.up && x1 > l1.up) || (x0 >= l0.dn && x1 < l1.dn); // 삼각수렴 이탈
    const up = x0 <= l0 && x1 > l1;
    const down = x0 >= l0 && x1 < l1;
    return a.op === "up" ? up : a.op === "down" ? down : up || down;
  }

  async function check() {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now() / 1000;
      const groups = new Map();
      for (const a of active()) {
        const k = `${a.sym}|${a.tf}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(a);
      }
      for (const [, alerts] of groups) {
        const { sym, tf } = alerts[0];
        const info = describe(sym);
        let bars;
        try {
          bars = await barsFor(info, tf);
        } catch (e) {
          console.warn("[alert] 봉 읽기 실패", sym, tf, e);
          continue;
        }
        if (bars.length < 3) continue;
        const n = bars.length;
        const htfBars = new Map(); // 다른 봉 기준 지표 알림용 상위 봉
        for (const a of alerts) {
          const t2 = htfOf(a);
          if (t2 && !htfBars.has(t2)) {
            const basis = cfg.chart.price_basis ?? "split";
            htfBars.set(t2, (await loadSeries(info, t2, { basis, ext: !(cfg.chart.regular_hours_only ?? true), limit: isDailyTf(t2) ? undefined : 1500 }).catch(() => ({ bars: [] }))).bars);
          }
        }
        for (const a of alerts) {
          const t2 = htfOf(a);
          if (t2 && !htfBars.get(t2)?.length) continue;
          const S = series(a, info, bars, t2 ? htfBars.get(t2) : null);
          if (!S) {
            if (a.kind === "line") {
              a.on = false; // 선을 지웠으면 알림도 끈다
              changed();
            }
            continue;
          }
          if (a.live && isFirstBreak(a) && S.day) {
            // 실시간 신고가·신저가·ORB: 지금 봉이 그날 처음 넘은 봉이면 (같은 날 두 번 안 울림)
            if (firstBreakAt(a, S, n - 1) && a.firedDay !== S.day[n - 1]) {
              a.firedDay = S.day[n - 1];
              fire(a, info, bars[n - 1], S, n - 1);
            }
          } else if (a.live) {
            // 실시간: 지난번 확인 때 위치와 지금 비교
            const cur = { x: S.x[n - 1], lv: S.lv ? S.lv(n - 1) : null, st: S.stage?.(n - 1) };
            const prev = lastSide.get(a.id);
            lastSide.set(a.id, cur);
            if (!prev) continue;
            const fake = { x: [prev.x, cur.x], lv: (i) => (i ? cur.lv : prev.lv), stage: (i) => (i ? cur.st : prev.st) };
            if (happened(a, fake, 0, 1)) fire(a, info, bars[n - 1], S, n - 1);
          } else {
            const c = closed(info, tf, bars[n - 1], now) ? n - 1 : n - 2;
            if (c < 1) continue;
            if (a.lastBarT == null) {
              // 처음: 지금까지는 지난 일 → 다음 봉부터
              a.lastBarT = bars[c].t;
              changed();
              continue;
            }
            if (bars[c].t <= a.lastBarT) continue;
            const from = Math.max(1, bars.findIndex((b) => b.t > a.lastBarT));
            a.lastBarT = bars[c].t;
            changed();
            for (let i = from; i <= c; i++) {
              if (happened(a, S, i - 1, i) && !(isFirstBreak(a) && a.firedDay === S.day?.[i])) {
                if (isFirstBreak(a)) a.firedDay = S.day?.[i];
                fire(a, info, bars[i], S, i);
                break;
              }
            }
          }
        }
      }
    } finally {
      busy = false;
    }
  }

  function fire(a, info, bar, S, i) {
    const v = S.x?.[i];
    const val = v == null ? "" : a.kind === "rsi" ? ` (RSI ${v.toFixed(1)})` : ` (${num(v, 2)})`;
    // 봉 시각을 같이: 앱이 꺼져 있던 사이에 일어난 것이면 "(지난 일 · 10-23 14:05)"
    const d = new Date(bar.t * 1000);
    const p2 = (x) => String(x).padStart(2, "0");
    const when = isDailyTf(a.tf) ? `${d.getUTCMonth() + 1}-${p2(d.getUTCDate())}` : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    const stale = Date.now() / 1000 - (bar.t + (isDailyTf(a.tf) ? DAY : TF_SEC[a.tf])) > (isDailyTf(a.tf) ? 2 * DAY : 3 * TF_SEC[a.tf] + 120);
    const text = `${stale ? "(앱 꺼진 사이 · " + when + ") " : ""}${alertText(a)}${stale ? "" : ` · ${when}`}`;
    a.fired = [{ at: Date.now(), bar: bar.t, value: v ?? null }, ...(a.fired ?? [])].slice(0, 20);
    if (a.once) a.on = false;
    changed();
    logInfo(`[alert] ${text}${val}`);
    notify("🔔 FAKE TRADING 알림", `${text}${val}`);
    if (cfg.alert_sound ?? true) chime();
    onFire?.(a, `${text}${val}`);
  }

  let saveT = null;
  function changed() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      cfg.save();
      syncSubs();
      onChange?.();
    }, 50);
  }

  data.on("bars", ({ id }) => {
    if (active().some((a) => a.sym === id || describe(a.sym).parts?.includes(id))) schedule();
  });
  data.on("quote", ({ id }) => {
    if (active().some((a) => a.sym === id && (a.live || isDailyTf(a.tf)))) schedule();
  });
  setInterval(check, 10e3);
  syncSubs();
  setTimeout(check, 3000);

  return {
    list,
    add(a) {
      const al = { id: Math.random().toString(36).slice(2, 10), on: true, once: true, live: false, created: Date.now(), ...a };
      list().push(al);
      changed();
      schedule();
      return al;
    },
    update(id, patch) {
      const a = list().find((x) => x.id === id);
      if (!a) return;
      Object.assign(a, patch);
      if ("on" in patch && patch.on) {
        a.lastBarT = null; // 다시 켜면 지금부터
        lastSide.delete(id);
      }
      changed();
      schedule();
    },
    remove(id) {
      cfg.alerts = list().filter((x) => x.id !== id);
      lastSide.delete(id);
      changed();
    },
    countFor: (sym) => active().filter((a) => a.sym === sym).length,
    check,
  };
}
