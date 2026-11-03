// 데이터 관리자: 저장소 채우기·이어 받기, 현재가, 실시간 갱신을 한곳에서 (SPEC §2.4, §6.1)
// - 같은 것을 동시에 두 번 받지 않는다(진행 중이면 그 약속을 같이 기다림)
// - 방금 받은 것은 다시 받지 않는다(종류별 "신선한 시간")
// - 받은 게 있으면 "bars" 이벤트 → 그 종목을 보는 칸이 다시 읽는다
import { describe } from "./symbols.js";
import { updateDaily } from "./daily.js";
import * as I from "./intraday.js";
import * as S from "../sources/sentiment.js";
import * as A from "../sources/alpaca.js";
import * as Y from "../sources/yahoo.js";
import * as HL from "../sources/hyperliquid.js";
import * as BN from "../sources/binance.js";
import * as TS from "../sources/toss.js";
import * as db from "./db.js";
import { isDailyTf, TIMEFRAMES } from "./bars.js";
import { DAY, tzOffset } from "./tz.js";
import { logInfo, listen, invoke, inTauri } from "../platform.js";
import { marketOpen, noteLastBar } from "./session.js";

const FRESH = { daily: 10 * 60e3, sentiment: 30 * 60e3, intraday: 55e3, yahooIntraday: 60e3, perp: 55e3 };
const PERP_TFS = TIMEFRAMES;

export function createData(cfg) {
  const bus = new EventTarget();
  const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  const on = (type, fn) => {
    const h = (e) => fn(e.detail);
    bus.addEventListener(type, h);
    return () => bus.removeEventListener(type, h);
  };

  // ── 상태줄용 작업 목록 ──
  const jobs = new Map();
  let jobSeq = 0;
  let lastUpdate = 0;
  const emitJobs = () => emit("jobs", [...jobs.values()]);
  function job(text) {
    const id = ++jobSeq;
    jobs.set(id, text);
    emitJobs();
    return {
      set: (t) => {
        jobs.set(id, t);
        emitJobs();
      },
      done: () => {
        jobs.delete(id);
        emitJobs();
      },
    };
  }

  // ── 저장소 채우기 ──
  const fresh = new Map(); // key → 마지막으로 받은 시각
  const inflight = new Map(); // key → Promise
  let needKeyShown = false;

  function run(key, freshMs, force, work) {
    if (inflight.has(key)) return inflight.get(key);
    if (!force && Date.now() - (fresh.get(key) ?? 0) < freshMs) return Promise.resolve(0);
    const p = (async () => {
      try {
        const n = await work();
        fresh.set(key, Date.now());
        lastUpdate = Date.now();
        emit("updated", lastUpdate);
        return n;
      } catch (e) {
        fresh.set(key, Date.now() - freshMs + 15e3); // 실패하면 15초 뒤에 다시
        console.warn(`[data] ${key}`, e?.message ?? e);
        emit("error", { key, error: String(e?.message ?? e) });
        return 0;
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  const label = (info) => info.label;

  /** 이 칸이 그릴 데이터를 저장소에 준비 (없으면 받고, 오래됐으면 이어 받기) */
  function ensure(info, tf, { force = false, front = false } = {}) {
    if (info.kind === "ratio") return Promise.all(info.partInfos.map((p) => ensure(p, tf, { force, front }))).then((ns) => ns.reduce((a, b) => a + b, 0));
    if (info.kind === "perp") {
      const key = `${info.id}|${tf}`;
      return run(key, FRESH.perp, force, async () => {
        const j = job(`받는 중 ${label(info)} ${tfName(tf)}`);
        try {
          const n = await I.ensurePerp(info, tf);
          if (n) emit("bars", { id: info.id, tf });
          return n;
        } finally {
          j.done();
        }
      });
    }
    if (isDailyTf(tf)) {
      const key = `${info.id}|1D`;
      if (info.daily === "cboe") {
        return run("cboe", FRESH.sentiment, force, async () => {
          const j = job("받는 중 풋/콜 비율 (CBOE)");
          const tell = () => ["cboe:PC_TOTAL", "cboe:PC_EQUITY", "cboe:PC_INDEX"].forEach((id) => emit("bars", { id, tf: "1D" }));
          try {
            return await S.updateCboe(tell);
          } finally {
            j.done();
            tell();
          }
        });
      }
      if (info.daily === "cnn") {
        return run(key, FRESH.sentiment, force, async () => {
          const r = await S.updateCnn();
          emit("bars", { id: info.id, tf: "1D" });
          return r.rows;
        });
      }
      return run(key, FRESH.daily, force, async () => {
        const j = job(`받는 중 ${label(info)} 일봉`);
        try {
          const r = await updateDaily(info, { front });
          emit("bars", { id: info.id, tf: "1D" });
          if (r.meta) emit("meta", { id: info.id, meta: r.meta });
          return r.added;
        } finally {
          j.done();
        }
      });
    }
    const base = I.baseTf(info, tf);
    if (!base) return Promise.resolve(0);
    const key = `${info.id}|${base}`;
    if (info.intraday === "alpaca") {
      if (!A.hasKey()) {
        if (!needKeyShown) emit("need-key", info.id);
        needKeyShown = true;
        return Promise.resolve(0);
      }
      return run(key, FRESH.intraday, force, async () => {
        const j = job(`받는 중 ${label(info)} ${tfName(base)}`);
        try {
          let shown = 0;
          const n = await I.ensureAlpaca(info, base, cfg, (frac) => {
            const pct = Math.max(0, Math.min(99, Math.round(frac * 100)));
            j.set(`받는 중 ${label(info)} ${tfName(base)} ${pct}%`);
            // 차트 다시 그리기는 2초에 한 번만 (동시에 여러 덩어리를 받아서 자주 온다)
            if (Date.now() - shown > 2000) {
              shown = Date.now();
              emit("bars", { id: info.id, tf: base, partial: true });
            }
          });
          if (n) emit("bars", { id: info.id, tf: base });
          return n;
        } finally {
          j.done();
        }
      });
    }
    if (info.intraday === "yahoo") {
      return run(key, FRESH.yahooIntraday, force, async () => {
        const n = await I.ensureYahooIntraday(info, base);
        if (n) emit("bars", { id: info.id, tf: base });
        noteLastBar(info, (await db.range(info.id, base))?.last);
        return n;
      });
    }
    return Promise.resolve(0);
  }

  // ── 켤 때 이어 받기 (SPEC §2.4: 이틀 뒤에 켜면 빠진 이틀치만) ──
  async function catchUpAll(ids) {
    const infos = [...new Set(ids)].map(describe);
    const j = job("이어 받는 중…");
    try {
      let i = 0;
      for (const info of infos) {
        j.set(`이어 받는 중 ${++i}/${infos.length} · ${info.label}`);
        // 풋/콜은 처음 채우기가 몇 분 걸려서 기다리지 않는다 (따로 줄 서서 받는다)
        if (info.kind === "sentiment") ensure(info, "1D");
        else await ensure(info, "1D");
      }
      // 분봉: 이미 받아 둔 것만 이어서 (처음 받기는 그 차트를 열 때나 "관심종목 전체 받기")
      const us = infos.filter((x) => x.intraday === "alpaca");
      if (A.hasKey() && us.length) {
        for (const tf of ["5m", "1m"]) {
          const changed = await I.catchUpAlpacaMany(us, tf).catch((e) => (console.warn("[alpaca] 이어 받기", e.message), []));
          for (const id of changed) emit("bars", { id, tf });
        }
      }
      // 예전에 받다가 끊긴 미국 분봉(끝부분·과거 채우기·빈 곳)은 뒤에서 조용히 이어 받기 (QA #12: SPY 5분봉이 2023-03에서 멈춰 있던 일)
      if (A.hasKey() && us.length) setTimeout(() => resumeUnfinished(us), 5000);
      for (const info of infos) {
        if (info.intraday === "yahoo") {
          for (const tf of ["1h", "5m", "1m"]) if (await db.range(info.id, tf)) await ensure(info, tf);
        } else if (info.kind === "perp") {
          for (const tf of PERP_TFS) if (tf !== "1D" && (await db.range(info.id, tf))) await ensure(info, tf);
        }
      }
    } finally {
      j.done();
    }
  }

  /** 이미 받기 시작한 미국 분봉만 (새로 큰 받기를 시작하지는 않는다). ensureAlpaca가 끝부분·과거·빈 곳을 알아서 채운다 */
  async function resumeUnfinished(infos) {
    for (const info of infos) {
      for (const tf of ["5m", "1m"]) {
        if (!(await db.range(info.id, tf))) continue;
        try {
          await ensure(info, tf);
        } catch (e) {
          console.warn("[alpaca] 이어 받기", info.id, tf, e.message);
        }
      }
    }
  }

  /** 설정 → 저장된 데이터의 "빈 곳 채우기": 빈 곳 다시 찾기 표시를 지우고 다시 받기 */
  async function fillGaps(id, tf) {
    await db.metaSet(`${id}|${tf}|holes`, null);
    return ensure(describe(id), tf, { force: true });
  }

  /** "관심종목 전체 받기": 분봉까지 전부 (중간에 꺼도 다음에 이어서) */
  async function downloadAll(ids, onProgress = () => {}) {
    const infos = [...new Set(ids)].map(describe).filter((x) => x.kind !== "sentiment" && x.kind !== "ratio");
    let i = 0;
    for (const info of infos) {
      onProgress(++i, infos.length, info);
      await ensure(info, "1D", { force: true });
      if (info.intraday === "alpaca") {
        await ensure(info, "5m", { force: true });
        await ensure(info, "1m", { force: true });
      } else if (info.intraday === "yahoo") {
        for (const tf of ["1h", "5m", "1m"]) await ensure(info, tf, { force: true });
      } else if (info.kind === "perp") {
        for (const tf of PERP_TFS) await ensure(info, tf, { force: true });
      }
    }
  }

  // ── 실시간 (보이는 칸) ──
  const live = new Map(); // key → {info, tf, cbs:Set, off}
  const tails = new Map(); // id → IEX 1분봉 (알파카)
  let tailLogAt = 0;

  /** 칸이 보는 동안 갱신 받기 → 해제 함수. cb({type:"bar", row}) | cb({type:"tail", rows}) */
  function subscribeLive(info, tf, cb) {
    const key = `${info.id}|${tf}`;
    let s = live.get(key);
    if (!s) {
      s = { info, tf, cbs: new Set(), off: null };
      if (info.kind === "perp") s.off = I.subscribePerp(info, tf, (row) => s.cbs.forEach((f) => f({ type: "bar", row })));
      live.set(key, s);
    }
    s.cbs.add(cb);
    updateStream();
    return () => {
      s.cbs.delete(cb);
      if (!s.cbs.size) {
        s.off?.();
        live.delete(key);
        updateStream();
      }
    };
  }

  // ── 알파카 실시간 체결 (웹소켓, Rust alpaca_stream.rs): 보이는 미국 분봉 칸 먼저, 그다음 관심종목 (최대 30개) ──
  let streamOn = false;
  let streamSig = null;
  function updateStream() {
    if (!inTauri || !A.hasKey()) return;
    const charts = [...live.values()].filter((s) => s.info.intraday === "alpaca").map((s) => s.info.id);
    const ids = [...new Set([...charts, ...[...watch].filter((id) => describe(id).intraday === "alpaca")])].slice(0, 30);
    const sig = ids.join(",");
    if (sig === streamSig) return;
    streamSig = sig;
    invoke("alpaca_stream_set", { symbols: ids.map((id) => id.replace(/-/g, ".")) }).catch((e) => console.warn("[alpaca] stream", e?.message ?? e));
  }
  listen("alpaca-stream", (st) => {
    if (st.ok !== streamOn || !st.ok) logInfo(`[alpaca] 실시간 체결 ${st.ok ? "연결됨" : `끊김 (${st.msg})`}`);
    streamOn = !!st.ok;
  });
  listen("alpaca-trades", (ticks) => {
    for (const k of ticks) {
      const id = k.s.replace(/\./g, "-");
      const old = quotes.get(id);
      const ts = Date.parse(String(k.t).replace(/(\.\d{3})\d+/, "$1")) / 1000;
      setQuote(id, { price: k.p, prevClose: old?.prevClose ?? null, ts: Number.isFinite(ts) ? ts : Date.now() / 1000, live: true, hi: k.hi, lo: k.lo, dayOpen: old?.dayOpen });
    }
  });

  // 15초마다: 보이는 칸의 데이터를 이어 받기 (신선한 시간 안이면 아무것도 안 함)
  // Yahoo 분봉(국내·지수·환율·선물)은 장중에만 1분마다 — 장 밖·휴장일에는 멈춘다
  setInterval(() => {
    for (const s of live.values()) {
      if (s.info.kind === "perp") continue;
      if (s.info.intraday === "yahoo" && !isDailyTf(s.tf) && !marketOpen(s.info)) continue;
      ensure(s.info, s.tf);
    }
  }, 15e3);

  // 무기한선물: 관심종목에 있는 것은 1시간마다 받아 둔 봉 전부 이어서 (1분봉은 거래소가 3.5일치만 줌, SPEC §2.9)
  setInterval(async () => {
    for (const id of watch) {
      const info = describe(id);
      if (info.kind !== "perp") continue;
      for (const tf of PERP_TFS) if (await db.range(id, tf)) ensure(info, tf);
    }
  }, 60 * 60e3);

  // 알파카 최근 15분 (IEX): 보이는 미국 분봉 칸만, 5초마다 한 번에
  async function pollTail() {
    const ids = [...new Set([...live.values()].filter((s) => s.info.intraday === "alpaca" && !isDailyTf(s.tf)).map((s) => s.info.id))];
    if (ids.length && A.hasKey()) {
      try {
        const m = await I.alpacaTail(ids);
        // 10분에 한 번 기록: 실시간 꼬리가 들어오는지 (문제 생기면 app.log로 확인)
        if (Date.now() - tailLogAt > 10 * 60e3) {
          tailLogAt = Date.now();
          logInfo(`[alpaca] 실시간(IEX) ${[...m].map(([id, r]) => `${id} ${r.length}봉${r.length ? ` ~${new Date(r[r.length - 1].t * 1000).toTimeString().slice(0, 5)}` : ""}`).join(", ")}`);
        }
        for (const [id, rows] of m) {
          tails.set(id, rows);
          for (const s of live.values()) if (s.info.id === id && !isDailyTf(s.tf)) s.cbs.forEach((f) => f({ type: "tail", rows }));
        }
      } catch (e) {
        console.warn("[alpaca] tail", e.message);
      }
    }
    setTimeout(pollTail, (cfg.alpaca.poll_sec ?? 5) * 1000);
  }
  setTimeout(pollTail, 3000);

  // ── 현재가 ──
  const quotes = new Map(); // id → {price, prevClose, ts}
  let watch = new Set();
  const quoteOffs = new Map(); // 무기한선물 구독 해제
  let idle = 0;
  let lastSig = "";

  function setQuote(id, q) {
    if (!q || !(q.price > 0)) return;
    const old = quotes.get(id);
    // 현재가 1순위는 토스: 토스 값이 15초 안에 왔으면 다른 곳(알파카·Yahoo) 값은 전일 종가만 받는다
    if (old?.src === "Toss" && q.src !== "Toss" && Date.now() / 1000 - old.ts < 15) {
      if (q.prevClose && q.prevClose !== old.prevClose) {
        quotes.set(id, { ...old, prevClose: q.prevClose, dayOpen: q.dayOpen ?? old.dayOpen });
        emit("quote", { id, q: quotes.get(id) });
      }
      return;
    }
    if (old?.live && q.live && q.ts < old.ts) {
      // 1초 조회 값이 스트림의 마지막 체결보다 오래됐으면 가격은 그대로 두고 전일 종가만 받는다
      if (q.prevClose && q.prevClose !== old.prevClose) {
        quotes.set(id, { ...old, prevClose: q.prevClose, dayOpen: q.dayOpen ?? old.dayOpen });
        emit("quote", { id, q: quotes.get(id) });
      }
      return;
    }
    quotes.set(id, q);
    if (old && old.price === q.price && old.prevClose === q.prevClose && !(q.ts - old.ts >= 60)) return;
    emit("quote", { id, q });
  }

  /** 관심종목 + 보이는 칸 = 현재가를 받을 종목 */
  function setWatch(ids) {
    watch = new Set(ids);
    queueMicrotask(updateStream);
    for (const [id, off] of quoteOffs) {
      if (!watch.has(id)) {
        off();
        quoteOffs.delete(id);
      }
    }
    for (const id of watch) {
      const info = describe(id);
      if (info.kind === "perp" && !quoteOffs.has(id)) {
        const f = (q) => setQuote(id, q);
        quoteOffs.set(id, info.daily === "hyperliquid" ? HL.subscribeQuote(info.symbol, f) : BN.subscribeQuote(info.symbol, f));
      } else if (info.kind === "sentiment" || info.kind === "ratio") {
        quoteFromStore(info);
      }
    }
  }

  /** 실시간 값이 없는 종목(심리 지표)은 저장된 마지막 두 값 */
  async function quoteFromStore(info) {
    if (info.kind === "ratio") return;
    const rows = await db.getBars(info.id, "1D", { limit: 2 });
    if (rows.length) setQuote(info.id, { price: rows[rows.length - 1].c, prevClose: rows[rows.length - 2]?.c ?? null, ts: rows[rows.length - 1].t, daily: true });
  }
  on("bars", ({ id }) => {
    const info = describe(id);
    if (info.kind === "sentiment" && watch.has(id)) quoteFromStore(info);
  });

  async function pollYahooQuotes() {
    const ids = [...watch].filter((id) => {
      const k = describe(id).kind;
      if (k === "perp" || k === "sentiment" || k === "ratio") return false;
      return !(k === "us" && A.hasKey()); // 알파카 키가 있으면 미국 종목은 알파카로
    });
    if (ids.length) {
      const m = await Y.spark(ids.map((id) => describe(id).yahoo)).catch(() => new Map());
      let sig = "";
      for (const id of ids) {
        const q = m.get(describe(id).yahoo);
        if (!q) continue;
        sig += `${id}${q.price}|`;
        const old = quotes.get(id);
        if (old?.src === "Toss" && Date.now() / 1000 - old.ts < 30) {
          if (q.prevClose && q.prevClose !== old.prevClose) setQuote(id, { ...old, prevClose: q.prevClose });
          continue;
        }
        setQuote(id, q);
      }
      idle = sig === lastSig ? idle + 1 : 0;
      lastSig = sig;
    }
    // 값이 1분 넘게 그대로면(장 마감·주말) 2분에 한 번만
    const sec = idle >= 4 ? 120 : cfg.data.quote_poll_sec ?? 15;
    setTimeout(pollYahooQuotes, sec * 1000);
  }
  setTimeout(pollYahooQuotes, 500);

  async function pollAlpacaQuotes() {
    const ids = [...watch].filter((id) => describe(id).kind === "us");
    if (ids.length && A.hasKey()) {
      try {
        const m = await A.snapshots(ids.map((id) => id.replace(/-/g, ".")));
        for (const id of ids) setQuote(id, m.get(id.replace(/-/g, ".")));
      } catch (e) {
        console.warn("[alpaca] snapshots", e.message);
      }
    }
    // 미국 분봉 차트가 보이면 1초마다 (봉이 1초마다 움직인다), 아니면 5초마다
    const fast = !streamOn && [...live.values()].some((s) => s.info.intraday === "alpaca" && !isDailyTf(s.tf));
    setTimeout(pollAlpacaQuotes, fast ? (cfg.alpaca.fast_poll_sec ?? 1) * 1000 : (cfg.alpaca.poll_sec ?? 5) * 1000);
  }
  setTimeout(pollAlpacaQuotes, 1000);

  // ── 토스 (국내 실시간, Market Board와 같은 키·토큰): 장중에만 2초마다 현재가, 보이는 국내 분봉 칸은 5초마다 최근 1분봉 ──
  let tossTailAt = 0;
  // 토스는 미국 주식을 한국 낮(주간거래)·프리·정규·애프터까지 거의 하루 종일 준다 → 미국 평일(뉴욕 일 20시 ~ 금 20시)에 받는다
  function usTossHours(t = Date.now() / 1000) {
    const l = t + tzOffset("America/New_York", t);
    const day = Math.floor(l / DAY);
    const wd = (day + 4) % 7;
    const hr = (l - day * DAY) / 3600;
    return wd === 6 ? false : wd === 0 ? hr >= 20 : wd === 5 ? hr < 20 : true;
  }
  const tossNow = (id) => {
    const info = describe(id);
    return info.kind === "us" ? usTossHours() : TS.tossable(id) && marketOpen(info);
  };
  async function pollToss() {
    let wait = 2000;
    try {
      if (TS.hasKey() && !TS.isStandby()) {
        const shown = [...live.values()].map((s) => s.info.id);
        const ids = [...new Set([...watch, ...shown])].filter(tossNow);
        // 분봉 차트가 보이면 1초마다 (봉이 1초마다 움직인다)
        if ([...live.values()].some((s) => !isDailyTf(s.tf) && ids.includes(s.info.id))) wait = 1000;
        if (ids.length) {
          const m = await TS.prices(ids);
          for (const [id, q] of m) {
            const old = quotes.get(id);
            setQuote(id, { price: q.price, prevClose: old?.prevClose ?? null, ts: q.ts, live: true, src: "Toss" });
          }
        } else wait = 30000; // 장 밖: 30초마다 장이 열렸는지만 본다
        if (Date.now() - tossTailAt > 5000) {
          tossTailAt = Date.now();
          for (const s of live.values()) {
            if (s.info.kind !== "kr" || isDailyTf(s.tf) || !marketOpen(s.info)) continue;
            // 정규장 09:00~15:30만 (넥스트레이드 프리·애프터 체결은 빼고 — 저장된 Yahoo 분봉과 같은 시간대)
            const rows = (await TS.candles1m(s.info.id, 60)).filter((k) => {
              const l = (k.t + 9 * 3600) % 86400;
              return l >= 9 * 3600 && l < 15.5 * 3600;
            });
            if (rows.length) s.cbs.forEach((f) => f({ type: "tail", rows }));
          }
        }
      } else if (TS.isStandby()) wait = 60000; // 다른 PC가 쓰는 중: 1분마다 돌아왔는지만
      else wait = 60000;
    } catch (e) {
      if (!String(e.message).startsWith("standby")) console.warn("[toss]", e.message);
      wait = 10000;
    }
    setTimeout(pollToss, wait);
  }
  TS.keyStatus().then(() => setTimeout(pollToss, 800));

  logInfo("data manager ready");
  return {
    on,
    restartStream: () => ((streamSig = null), updateStream()),
    tossKey: () => TS.keyStatus(),
    fillGaps,
    ensure,
    catchUpAll,
    downloadAll,
    subscribeLive,
    setWatch,
    job, // 모의매매: 차트를 뒤로 밀어 옛날 봉을 받을 때 아래 상태줄에 "받는 중" (main.js fetchOlder)
    quote: (id) => quotes.get(id),
    tail: (id) => tails.get(id),
    get lastUpdate() {
      return lastUpdate;
    },
    get busy() {
      return jobs.size > 0;
    },
  };
}

export const TF_NAME = { "1m": "1분", "5m": "5분", "15m": "15분", "30m": "30분", "1h": "1시간", "4h": "4시간", "1D": "일", "1W": "주" };
const tfName = (tf) => `${TF_NAME[tf]}봉`;
