// 💰 모의매매 (기획서 §9 MVP를 §12대로 얇게): 리플레이 + 시장가 롱/숏 + 익절·손절선 끌기 + 자동 체결 + 손익.
// - 진짜 주문은 없다. 거래소 주문 API는 이 앱에 코드도 주소도 없다 (CLAUDE.md 보안 규칙)
// - 체결은 그 종목의 1분봉으로 판단한다 (칸이 5·15분·일봉이어도). 1분봉이 없는 종목만 칸의 봉으로
// - 레버리지(격리 증거금, 청산가선), 분할 매수(같은 방향으로 더), 원하는 양만 정리 (사용자 요청 2026-10-30)
// - 계좌·거래 기록은 이 PC에만: %APPDATA%\fake-trading-power-chart\trades.json
import { h, stepper, toggle as onOff } from "../ui/dom.js";
import { confirmBox } from "../ui/dialog.js";
import { num, signed, duration } from "../ui/format.js";
import * as E from "./engine.js";
import * as HIS from "./history.js";
import { createOrderLines } from "./orderlines.js";
import { createJournal, statTiles, tradeRow, whenText } from "./journal.js";
import { loadSeries } from "../core/series.js";
import { TF_NAME } from "../core/data.js";
import { ymd, DAY } from "../core/tz.js";
import { TF_SEC } from "../core/bars.js";
import { loadFile, saveFile } from "../platform.js";
import { upColor, downColor, tpColor } from "../core/colors.js";

const FILE = "trades.json";
// 롱(매수)·숏(매도)·익절 색은 차트 봉과 같이 한국식·미국식 설정을 따른다 (core/colors.js, 0.13.0): 한국식 롱 빨강·숏 파랑
const SL_C = "#ff8a3d";
const LIQ_C = "#e040fb"; // 청산가선: 롱 평단선(빨강)과 헷갈리지 않게 자홍색
const WARN_C = "#ffb020"; // 익절해도 손해
const OFF_C = "#8a919b"; // 꺼진 익절·손절선 (회색 점선)
const WHY = { tp: "익절", sl: "손절", close: "종료", end: "리플레이 끝", live: "실시간 끝", liq: "강제 청산" };
const LEVS = [1, 2, 3, 5, 10, 20];
const M1_LIMIT = 20000;
const HOLE = 30 * 60; // 24시간 종목에서 1분봉 사이가 이만큼 벌어지면 받아 둔 게 끊긴 것
const KEYS = { KeyB: 1, KeyS: -1, KeyX: 0 }; // 한글 입력 상태여도 같은 자리 키로

export async function createTrading(root, { cfg, grid, replay, toast, onToggle, journalRoot }) {
  cfg.trade = { ...E.DEFAULTS, ...(cfg.trade ?? {}) };
  const T = cfg.trade;
  const saved = (await loadFile(FILE)) ?? {};
  let acct = { start: saved.start ?? T.start_cash, cash: saved.cash ?? T.start_cash, trades: Array.isArray(saved.trades) ? saved.trades : [] };
  const orphan = saved.livePos?.pos ? saved.livePos : null; // 📡 실시간으로 들고 있다가 앱을 끈 포지션 (아래에서 정리)
  let isOpen = false;
  let ses = null; // 리플레이 한 판: {cell, info, endT, m1, m1More, i(다음에 볼 1분봉), lastBarT, marks}
  let pos = null;
  let dl = null; // 과거 봉 받는 중 {stop}
  const R = () => E.rules(T);

  const lines = createOrderLines({ list: lineList, onDrag: (key, price) => setLevel(key, price), onToggle: (key) => toggleLine(key) });
  const journal = createJournal(journalRoot, { getTrades: () => acct.trades, onReview: (tr) => review(tr), onChange: () => (save(), (listKey = ""), paint()), toast });
  let reviewCell = null; // 복기 표시(들어간 곳·나온 곳)를 붙인 칸

  // ── 계산 도우미 ──
  const decimals = () => ses?.cell.decimals ?? 2;
  const tick = () => 1 / 10 ** decimals();
  const px = (v) => num(v, decimals());
  const usd = (n) => `${n >= 0 ? "+" : "−"}$${num(Math.abs(n), 2)}`;
  const cls = (n) => (n > 0 ? "up" : n < 0 ? "down" : "flat");
  const levText = (v) => `${Number((v ?? 1).toFixed(2))}배`; // 소수점 두 자리까지 (3.75배, 10배)

  /** 지금 가격 = 지금 시각까지 끝난 마지막 1분봉 종가 (없으면 칸의 마지막 봉) */
  function cur() {
    if (!ses) return null;
    if (ses.live) return ses.price ?? null; // 📡 실시간: 마지막으로 본 가격 (종목을 바꿔도 그 종목 가격으로 정리)
    // 1분봉이 지금 시각 가까이까지 있을 때만 그 값. 1분봉 빈 곳에 들어와 있으면 칸에 보이는 가격
    // (0.11.1: 빈 곳에서 며칠 전 1분봉 값을 써서 대기선이 차트 한참 위에 깔렸다)
    if (ses.m1 && ses.i > 0 && ses.endT - (ses.m1[ses.i - 1].t + 60) <= HOLE) return ses.m1[ses.i - 1].c;
    const b = ses.cell.bars;
    return b.length ? b[b.length - 1].c : null;
  }
  const openNet = () => (pos && cur() != null ? E.netAt(pos, E.marketExit(pos, cur(), R()), "close", R()) : 0);
  /** 새로 넣을 수 있는 돈 = 잔고 − 지금 포지션에 묶인 증거금 */
  const avail = () => acct.cash - (pos?.margin ?? 0);
  /** 지금 익절선에서 나가도 수수료 때문에 손해인가 */
  const tpLossNow = () => !!pos && pos.tp != null && E.netAt(pos, pos.tp, "tp", R()) < 0;

  /**
   * 익절·손절선 켜기·끄기 (사용자 요청 2026-10-30): 빠르게 재생하면 모르는 사이에 정리돼 버려서,
   * 처음에는 꺼진 채로 깔고(설정 tpsl_on으로 바꿈) 보다가 오른쪽 클릭이나 💰 창 버튼으로 켠다. 꺼진 선은 체결되지 않는다.
   * 청산가는 늘 켜져 있다. 체결 판단에 넘기는 포지션 = 꺼진 선을 뺀 것
   */
  const armed = (p) => ({ ...p, tp: p.tpOn ? p.tp : null, sl: p.slOn ? p.sl : null });
  function toggleLine(key) {
    const target = key === "tp" || key === "sl" ? pos : key === "ptp" || key === "psl" ? pend : null;
    if (!target) return;
    const k = key.endsWith("tp") ? "tpOn" : "slOn";
    target[k] = !target[k];
    const name = k === "tpOn" ? "익절" : "손절";
    const c = cur();
    // 켰는데 가격이 이미 그 선을 지나 있으면 다음 봉에 바로 정리된다 → 알려 준다
    const crossed = target === pos && target[k] && c != null && (k === "tpOn" ? pos.side * (c - pos.tp) >= 0 : pos.side * (c - pos.sl) <= 0);
    toast(target[k] ? `${name}선 켬 — 가격이 닿으면 정리돼요${crossed ? "\n⚠ 이미 선을 지나 있어서 다음 봉에 바로 정리돼요" : ""}` : `${name}선 끔 — 닿아도 정리되지 않아요`, 3000);
    paint();
  }

  /**
   * 넣을 증거금. 금액 기준이면 적어 둔 증거금, 손절 기준이면 "손절(dist)에 닿을 때 계좌의 risk_pct%만 잃는" 크기 ÷ 배율.
   * 모자라면 주문 가능한 만큼으로 줄인다 → {margin, risk, capped}
   */
  function plannedMargin(lev, dist) {
    const r = R();
    const room = avail() / (1 + lev * r.taker); // 증거금 + 들어갈 때 수수료까지 낼 수 있는 만큼
    if (T.size_mode !== "risk") return { margin: Math.min(T.amount, room), capped: T.amount > room };
    const risk = (acct.cash * T.risk_pct) / 100;
    const want = E.sizeForRisk(risk, dist, r) / lev;
    return { margin: Math.min(want, room), risk, capped: want > room };
  }
  let pend = null; // 미리 깔아 둔 진입선 {side, price, type: "limit"|"stop", tp, sl, add(들고 있는 쪽으로 더)}

  // ── 리플레이에 붙기 (ui/replay.js가 부른다) ──
  /** 시작 전 (replay가 기다린다): Binance 종목은 그 시각 앞 하루 ~ 뒤 사흘 1분봉이 없으면 받아 온다 → 차트를 뒤로 밀어 고른 옛날 구간도 1분봉으로 체결 */
  async function prepare(cell, t) {
    if (!HIS.canBackfill(cell.info) || ["1D", "1W"].includes(cell.tf)) return;
    const slow = setTimeout(() => toast("그때 1분봉을 받는 중… (1~2초)", 2500), 300);
    try {
      await HIS.ensureMinutes(cell.info, t - DAY, t + 3 * DAY);
    } catch (e) {
      console.warn("[trade] 1분봉 받기 실패", e);
    } finally {
      clearTimeout(slow);
    }
  }

  function onBegin(cell, endT) {
    if (ses) onStop(ses.cell, ses.endT);
    if (reviewCell === cell) reviewCell = null; // 복기 표시는 이 판의 표시로 바뀐다
    const bars = cell.bars;
    // id·이름 = 일지의 "연습 판" (🎲·📍 시작 한 번이 한 판)
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    ses = { id: Date.now(), label: `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())} · ${cell.info.label.replace(/ 24h$/, "")} ${TF_NAME[cell.tf]}봉`, cell, info: cell.info, endT, m1: null, m1More: false, i: 0, lastBarT: bars.length ? bars[bars.length - 1].t : -Infinity, marks: [], loading: false };
    lines.attach(cell);
    loadM1(ses);
    paint();
  }

  function onStep(cell, endT) {
    if (!ses || ses.cell !== cell) return;
    ses.endT = endT;
    for (const b of newBars(endT)) if (judge(b, endT)) break;
    lines.resumeScale();
    paint();
  }

  /** 봉 하나로 체결 판단 (리플레이 1분봉 · 실시간 움직임). 다 나갔으면 true */
  function judge(b, endT) {
    // 1) 미리 깔아 둔 진입선이 체결되나. 체결된 봉에서는 손절·청산만 본다 (그 봉 안에서 들어간 뒤 익절까지 갔는지는 모르므로 보수적으로)
    if (pend) {
      const f = E.fillPending(pend, b, R());
      if (f) {
        fillPend(f, b);
        if (pos) {
          const x = E.exitOnBar(armed(pos), { o: f.price, h: b.h, l: b.l, c: b.c }, R());
          if (x && x.why !== "tp") {
            exit(x.price, x.why, ses.m1 ? b.t + 60 : endT, b.t);
            return true;
          }
        }
        return false;
      }
    }
    // 2) 들고 있는 포지션의 익절·손절·청산
    if (pos) {
      const x = E.exitOnBar(armed(pos), b, R());
      if (x) {
        exit(x.price, x.why, ses.m1 ? b.t + 60 : endT, b.t);
        return true;
      }
      E.track(pos, b);
    }
    return false;
  }

  function onStop(cell, endT) {
    if (!ses) return;
    if (ses.live) {
      clearInterval(liveTimer);
      liveTimer = 0;
    }
    if (pend) pend = null; // 대기선은 이 판에서만
    if (pos) exit(E.marketExit(pos, cur(), R()), ses.live ? "live" : "end", endT, endT);
    try {
      ses.cell.setTradeMarkers([]);
    } catch {}
    lines.detach();
    ses = null;
    paint();
  }

  // ── 📡 실시간 모의매매 (사용자 요청 2026-10-30, 기획서 5단계를 얇게) ──
  // 지금 보고 있는 칸의 실시간 시세로 사고판다. 진짜 주문은 없다. 0.5초마다 칸의 마지막 봉을 보고
  // "지난번 확인 뒤 움직인 범위"(지난 종가 → 지금 고가·저가·종가)를 한 봉처럼 만들어 리플레이와 같은 규칙으로 체결한다.
  // 시세가 오는 종목: 바이낸스·하이퍼리퀴드(24시간), 장중 국내(토스)·미국(알파카) 주식. 장이 닫히면 가격이 안 움직인다
  let liveTimer = 0;

  async function startLive(force = false) {
    const cell = grid.current;
    if (!cell?.cc.symbol) return toast("먼저 차트에서 종목을 고르세요");
    // 지금 판에서 들고 있거나 대기선을 깔아 뒀으면 먼저 묻는다 (0.13.0, main.js guardTrading과 같은 말)
    if (!force && ses && (pos || pend)) {
      const what = [`지금 ${ses.live ? "실시간 모의매매" : "리플레이"}가 끝나요.`, pos ? `들고 있는 ${ses.info.label.replace(/ 24h$/, "")} ${pos.side > 0 ? "롱" : "숏"}은 지금 가격으로 정리돼서 일지에 남아요.` : "", pend ? "깔아 둔 대기선은 없어져요." : ""];
      if (!(await confirmBox("⚠ 모의매매 중이에요", `📡 실시간으로 새로 시작하면 ${what.filter(Boolean).join(" ")}`, { ok: "그래도 할게요", danger: true }))) return;
    }
    if (replay.active) replay.stop();
    if (ses) onStop(ses.cell, ses.endT);
    if (cell.windowed) cell.goNow(); // 과거 구간을 보고 있었으면 지금으로 (실시간 갱신이 멈춰 있다)
    const bars = cell.bars;
    if (!bars.length) return toast("이 칸에 아직 봉이 없어요");
    if (reviewCell === cell) reviewCell = null;
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const now = Date.now() / 1000;
    ses = { id: Date.now(), live: true, label: `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())} · ${cell.info.label.replace(/ 24h$/, "")} 실시간`, cell, info: cell.info, endT: now, m1: null, i: 0, lastBarT: Infinity, marks: [], price: bars[bars.length - 1].c, snap: null, movedAt: Date.now(), savedAt: 0 };
    lines.attach(cell);
    clearInterval(liveTimer);
    liveTimer = setInterval(liveTick, 500);
    liveTick();
    toast("📡 실시간 모의매매 시작 · 지금 가격으로 사고팔아요 (진짜 주문 없음)\n끝내려면 💰 창 위 ■ 끝내기", 5000);
  }

  function stopLive(msg) {
    if (!ses?.live) return;
    onStop(ses.cell, Date.now() / 1000);
    if (msg) toast(msg, 5000);
  }

  function liveTick() {
    const s = ses;
    if (!s?.live) return;
    const c = s.cell;
    // 종목을 바꾸거나 칸이 없어지면 끝낸다 (들고 있던 것은 마지막으로 본 가격으로 정리)
    if (!grid.cells.includes(c) || c.info?.id !== s.info.id) return stopLive("종목이 바뀌어서 실시간 모의매매를 끝냈어요");
    const bars = c.bars;
    if (!bars.length) return;
    const b = bars[bars.length - 1];
    const now = Date.now() / 1000;
    s.endT = now;
    const prev = s.snap;
    s.snap = { t: b.t, tf: c.tf, h: b.h, l: b.l, c: b.c };
    if (b.c !== s.price) s.movedAt = Date.now();
    s.price = b.c;
    // 처음·봉을 바꿨을 때·봉이 다시 읽혔을 때는 기준만 잡는다 (그 전 움직임으로 체결하지 않게)
    if (!prev || prev.tf !== c.tf || b.t < prev.t) return paint();
    let hi = Math.max(prev.c, b.c);
    let lo = Math.min(prev.c, b.c);
    for (let i = bars.length - 1; i >= 0 && bars[i].t >= prev.t; i--) {
      const x = bars[i];
      // 지난번에 보던 봉은 그때보다 더 높아지거나 낮아진 것만, 그 뒤에 생긴 봉은 전부 지난 확인 뒤의 움직임
      if (x.t === prev.t) {
        if (x.h > prev.h) hi = Math.max(hi, x.h);
        if (x.l < prev.l) lo = Math.min(lo, x.l);
      } else {
        hi = Math.max(hi, x.h);
        lo = Math.min(lo, x.l);
      }
    }
    if (pos || pend) judge({ t: b.t, o: prev.c, h: hi, l: lo, c: b.c }, now);
    // 들고 있는 동안은 5초마다 계좌 파일에도 적어 둔다 (앱을 꺼도 기록이 사라지지 않게 → 다음에 켤 때 정리)
    if (pos && Date.now() - s.savedAt > 5000) {
      s.savedAt = Date.now();
      acct.livePos = { pos, sym: s.info.id, label: s.info.label, tf: c.tf, d: decimals(), ses: s.id, sesLabel: s.label, price: s.price, at: now };
      save();
    }
    lines.resumeScale();
    paint();
  }

  /** 지난번에 실시간으로 들고 있다가 앱을 꺼 버린 포지션 → 마지막으로 본 가격으로 정리해 기록 */
  function settleOrphan(o) {
    try {
      const r = R();
      const tr = E.close(o.pos, { price: E.marketExit(o.pos, o.price, r), why: "live", t: o.at, sym: o.sym, r });
      acct.cash += tr.last;
      delete tr.last;
      Object.assign(tr, { label: o.label, tf: o.tf, d: o.d, ses: o.ses, sesLabel: o.sesLabel, live: true, at: Date.now(), memo: [o.pos.memo, "앱을 꺼서 마지막으로 본 가격으로 정리"].filter(Boolean).join(" · ") });
      acct.trades.unshift(tr);
      save();
      setTimeout(() => toast(`지난번 📡 실시간 포지션은 앱을 끌 때 마지막으로 본 가격(${num(o.price, o.d ?? 2)})으로 정리했어요 · ${usd(tr.net)}`, 9000), 3000);
    } catch (e) {
      console.warn("[trade] 지난 실시간 포지션 정리 실패", e);
    }
  }

  /** 칸의 차트 시리즈가 새로 만들어졌다 (봉·차트 종류 바꿈) → 선을 새 시리즈에 */
  function onMain(cell) {
    if (reviewCell === cell) {
      reviewCell = null; // 종목·봉을 바꾸면 복기 표시는 지운다 (그 시각의 봉이 없을 수 있다)
      cell.setTradeMarkers([]);
    }
    if (ses?.cell !== cell) return;
    cell.setTradeMarkers([]);
    lines.attach(cell);
  }
  /** 리플레이가 (봉을 바꿔) 다시 그려졌다 → 표시 다시 */
  function onReplayStart(cell) {
    if (ses?.cell === cell) paint();
  }

  /** 체결 판단용 1분봉 (칸의 봉과 따로). 지금 시각 조금 앞부터 */
  async function loadM1(s) {
    if (!s.info.tfs.includes("1m")) return;
    try {
      // 칸의 마지막 봉부터 읽는다: 그 봉을 이루는 1분봉이 없으면 그때 1분봉이 없는 것 (미국 주식은 최근 12개월뿐)
      // → 칸의 봉으로 체결 (1분봉이 한참 뒤부터 있으면 그때까지 익절·손절을 못 보던 것을 막는다)
      const bars = s.cell.bars;
      const from = Math.min(s.endT - 6 * 3600, bars.length ? bars[bars.length - 1].t : s.endT);
      const res = await loadSeries(s.info, "1m", { basis: s.cell.cc.basis ?? cfg.chart.price_basis ?? "split", ext: !(cfg.chart.regular_hours_only ?? true), after: from, limit: M1_LIMIT });
      if (ses !== s || !res.bars.length) return;
      const tfSec = TF_SEC[s.cell.tf] ?? DAY;
      if (bars.length && res.bars[0].t > bars[bars.length - 1].t + tfSec) return;
      s.m1 = res.bars;
      s.m1More = !!res.moreNewer;
      s.i = firstEndingAfter(s.m1, s.endT);
      paint();
    } catch (e) {
      console.warn("[trade] 1분봉 읽기 실패", e);
    }
  }

  async function moreM1(s) {
    if (!s.m1 || s.loading || s.m1.length - s.i > 600) return;
    // 저장된 1분봉 끝에 왔으면 Binance 종목은 그 뒤 사흘을 더 받아 온다 (옛날 구간에서 시작한 판)
    const pull = !s.m1More && HIS.canBackfill(s.info) && Date.now() > (s.retryAt ?? 0);
    if (!s.m1More && !pull) return;
    s.loading = true;
    try {
      const last = s.m1[s.m1.length - 1].t;
      if (pull) await HIS.ensureMinutes(s.info, last + 60, last + 3 * DAY).catch((e) => console.warn("[trade] 1분봉 더 받기 실패", e));
      if (ses !== s) return;
      const res = await loadSeries(s.info, "1m", { basis: s.cell.cc.basis ?? cfg.chart.price_basis ?? "split", ext: !(cfg.chart.regular_hours_only ?? true), after: last + 1, limit: M1_LIMIT });
      if (ses !== s) return;
      const more = res.bars.filter((b) => b.t > last);
      s.m1 = s.m1.concat(more);
      s.m1More = !!res.moreNewer && more.length > 0;
      if (!more.length) s.retryAt = Date.now() + 15000; // 지금까지 왔거나 받지 못했다 → 잠깐 뒤에 다시
    } catch (e) {
      console.warn("[trade] 1분봉 더 읽기 실패", e);
    } finally {
      s.loading = false;
    }
  }

  /**
   * 리플레이 시각이 저장된 1분봉의 빈 곳에 들어왔다 (사용자 2026-11-01: BTC 옛날 구간에서 대기선이 하나도 체결 안 됨).
   * 옛날 구간은 시작 앞뒤 며칠만 받아 두므로 읽은 1분봉이 "2019-11-16~20 → 바로 2026" 처럼 이어져 있었고,
   * 그 뒤로는 체결을 보지 못했다(뒤에 2026 봉이 많이 남아 "더 받기"도 안 함). → 그 사이를 받아 다시 읽는다
   */
  async function fillHole(s) {
    if (s.loading || Date.now() < (s.retryAt ?? 0)) return;
    s.loading = true;
    const lastT = s.m1[s.i - 1].t;
    try {
      if (HIS.canBackfill(s.info)) await HIS.ensureMinutes(s.info, lastT + 60, Math.max(s.endT + DAY, lastT + 3 * DAY)).catch((e) => console.warn("[trade] 1분봉 빈 곳 받기 실패", e));
      if (ses !== s) return;
      const res = await loadSeries(s.info, "1m", { basis: s.cell.cc.basis ?? cfg.chart.price_basis ?? "split", ext: !(cfg.chart.regular_hours_only ?? true), after: lastT + 1, limit: M1_LIMIT });
      if (ses !== s) return;
      const more = res.bars.filter((b) => b.t > lastT);
      s.m1 = s.m1.slice(0, s.i).concat(more); // 이미 본 봉은 그대로, 그 뒤만 새로
      s.m1More = !!res.moreNewer;
      // 거래소에도 그 사이 봉이 없으면(점검 등) 잠깐 뒤에 다시
      if (!more.length || more[0].t - lastT > HOLE + 60) s.retryAt = Date.now() + 15000;
    } catch (e) {
      console.warn("[trade] 1분봉 빈 곳 읽기 실패", e);
    } finally {
      s.loading = false;
    }
  }

  /** 지난번 뒤로 새로 끝난 봉들 (1분봉, 없으면 칸의 봉) */
  function newBars(endT) {
    const s = ses;
    const out = [];
    if (s.m1) {
      while (s.i < s.m1.length && s.m1[s.i].t + 60 <= endT) out.push(s.m1[s.i++]);
      // 빈 곳 안에 들어와 있거나(봉 단위로 지나온 경우), 바로 앞이 빈 곳(리플레이 칸이 받는 동안 제자리)이면 받아서 다시 읽는다
      const inside = s.i > 0 && endT - (s.m1[s.i - 1].t + 60) > HOLE;
      const ahead = s.i > 0 && s.i < s.m1.length && s.m1[s.i].t - endT > HOLE;
      if (s.info.kind === "perp" && (inside || ahead)) fillHole(s);
      else moreM1(s);
    } else {
      for (const b of s.cell.bars) if (b.t > s.lastBarT) out.push(b);
      if (out.length) s.lastBarT = out[out.length - 1].t;
    }
    return out;
  }

  // ── 매매 ──
  /** 매수·매도: 포지션이 없으면 새로, 같은 방향이면 분할 매수(더 들어가기) */
  function enter(side) {
    if (!ses) return toast("리플레이나 실시간을 켜야 매매할 수 있어요\n💰 창의 🎲 아무 때나 시작 · 📍 시작점 고르기 · 📡 지금 실시간으로", 5000);
    if (pos && pos.side !== side) return toast(`${pos.side > 0 ? "롱" : "숏"}을 들고 있어요 · 줄이려면 아래 정리 버튼 (X = 전부)`, 4000);
    const price = cur();
    if (price == null) return;
    const r = R();
    const lev = pos ? pos.lev : T.lev;
    // 손절까지 거리: 새로 들어가면 처음 손절 위치(%), 더 들어가면 지금 가격에서 손절선까지
    const dist = pos ? Math.abs(price - pos.sl) / price : r.sl;
    const { margin, capped } = plannedMargin(lev, dist);
    if (margin < 1) return toast(pos ? "더 넣을 돈이 없어요 (증거금이 다 묶였어요)" : "잔고가 없어요 · ↺ 계좌 처음부터");
    if (capped && T.size_mode === "risk") toast("주문 가능한 돈이 모자라서 수량을 줄였어요 (레버리지를 올리면 계획대로 들어가요)", 4000);
    if (pos) {
      const q = E.add(pos, { price, margin, lev, tick: tick(), r });
      if (!q) return toast("주문 금액이 너무 작아요");
      ses.marks.push({ t: ses.endT - 1, kind: "add", side });
      toast(`${side > 0 ? "추가 매수" : "추가 매도"} ${q}주 · 평단 ${px(pos.entry)}${pos.liq ? ` · 청산가 ${px(pos.liq)}` : ""}`, 3000);
    } else {
      pos = E.open({ side, price, margin, lev, t: ses.endT, tick: tick(), r });
      if (!pos) return toast("주문 금액이 너무 작아요");
      pos.tpOn = pos.slOn = !!T.tpsl_on; // 처음엔 꺼진 채로 (설정에서 바꿈)
      ses.marks.push({ t: ses.endT - 1, kind: "in", side });
      if (!T.tpsl_on) toast("익절·손절선은 꺼진 채로 깔렸어요 · 끌어서 자리를 잡고 오른쪽 클릭으로 켜세요", 4000);
    }
    paint();
  }

  function closeNow() {
    if (!pos || !ses) return;
    exit(E.marketExit(pos, cur(), R()), "close", ses.endT, ses.endT - 1);
  }

  /**
   * 원하는 가격에 미리 진입선 깔기 (기획서 §4-2): 처음엔 현재가에서 pend_pct% 떨어진 곳(롱은 아래, 숏은 위 = 지정가).
   * 차트에서 선을 끌어 옮기면 현재가 위·아래에 따라 지정가 ↔ 돌파로 저절로 바뀐다.
   * 포지션이 없으면 익절·손절 선도 같이 미리 깐다. 들고 있는 쪽이면 "추가 대기"(지정가 분할 매수)
   */
  function placePending(side) {
    if (!ses) return toast("리플레이나 📡 실시간을 켜야 선을 깔 수 있어요");
    if (pos && pos.side !== side) return toast(`${pos.side > 0 ? "롱" : "숏"}을 들고 있어서 반대쪽 대기선은 못 깔아요`);
    const c = cur();
    if (c == null) return;
    const r = R();
    const k = tick();
    const price = E.roundTick(c * (1 - (side * T.pend_pct) / 100), k);
    pend = { side, price, type: E.pendingType(side, price, c), add: !!pos, tpOn: !!T.tpsl_on, slOn: !!T.tpsl_on };
    if (!pos) {
      pend.tp = E.roundTick(price * (1 + side * r.tp), k);
      pend.sl = E.roundTick(price * (1 - side * r.sl), k);
    }
    toast(`${side > 0 ? "롱" : "숏"} 대기선을 깔았어요 · 차트에서 선을 끌어 원하는 가격으로 옮기세요`, 3500);
    paint();
  }

  function cancelPending() {
    if (!pend) return;
    pend = null;
    paint();
  }

  /** 대기선 체결 → 새 포지션 또는 분할 매수 */
  function fillPend(f, b) {
    const o = pend;
    pend = null;
    const r = R();
    if (o.add && !pos) return; // 그사이 포지션이 정리됐다
    const lev = pos ? pos.lev : T.lev;
    const dist = Math.abs(o.price - (pos ? pos.sl : o.sl)) / o.price;
    const { margin } = plannedMargin(lev, dist);
    if (margin < 1) return toast("대기선에 닿았지만 넣을 돈이 없어서 취소했어요", 4000);
    const name = o.type === "limit" ? "지정가" : "돌파";
    if (pos) {
      const q = E.add(pos, { price: f.price, exact: true, maker: f.maker, margin, lev, tick: tick(), r });
      if (!q) return;
      ses.marks.push({ t: b.t, kind: "add", side: pos.side });
      toast(`${name} 추가 체결 ${px(f.price)} · ${q}주 · 평단 ${px(pos.entry)}`, 3500);
    } else {
      pos = E.open({ side: o.side, price: f.price, exact: true, maker: f.maker, margin, lev, t: b.t, tick: tick(), r, tp: o.tp, sl: o.sl });
      if (!pos) return;
      pos.tpOn = o.tpOn; // 대기선에서 켜 둔 것은 켜진 채로
      pos.slOn = o.slOn;
      ses.marks.push({ t: b.t, kind: "in", side: o.side });
      toast(`${name} ${o.side > 0 ? "롱" : "숏"} 체결 ${px(f.price)} · ${pos.qty}주`, 3500);
    }
  }

  /** 원하는 양만 정리 (수량. 남는 게 없으면 전부 종료) */
  function closePart(q) {
    if (!pos || !ses) return;
    q = Math.floor(q * 1000) / 1000;
    if (!(q > 0)) return toast("정리할 수량을 넣어 주세요");
    if (q >= pos.qty - 0.0005) return closeNow();
    const r = R();
    const price = E.marketExit(pos, cur(), r);
    const net = E.reduce(pos, q, price, "close", r);
    pos.liq = E.liqPrice(pos, r);
    acct.cash += net;
    ses.marks.push({ t: ses.endT - 1, kind: "part", side: pos.side });
    save();
    toast(`일부 정리 ${q}주 ${px(price)} · ${usd(net)} · 남은 ${pos.qty}주`, 3500);
    paint();
  }

  /** 다 나가기: 계좌에 반영하고 기록 (markT = 차트에 표시할 시각) */
  function exit(price, why, t, markT) {
    const tr = E.close(pos, { price, why, t, sym: ses.info.id, r: R() });
    acct.cash += tr.last; // 앞서 일부 정리한 몫은 그때 이미 넣었다
    delete tr.last;
    tr.label = ses.info.label;
    tr.tf = ses.cell.tf;
    tr.d = decimals();
    tr.ses = ses.id; // 일지의 연습 판
    tr.sesLabel = ses.label;
    if (ses.live) tr.live = true;
    tr.at = Date.now();
    delete acct.livePos;
    if (pos.memo) tr.memo = pos.memo; // 들고 있는 동안 적은 메모 (왜 들어갔나)
    acct.trades.unshift(tr);
    if (acct.trades.length > 3000) acct.trades.length = 3000;
    ses.marks.push({ t: markT, kind: "out", side: pos.side, why });
    pos = null;
    if (pend?.add) pend = null; // 추가 대기선은 포지션과 같이 없어진다
    memoIn.value = "";
    save();
    toast(`${WHY[why]} ${px(price)} · ${usd(tr.net)}${tr.lev > 1.001 && tr.roe != null ? ` (증거금 대비 ${signed(tr.roe, 1)}%)` : ` (${signed(tr.pct, 2)}%)`}`, why === "liq" ? 6000 : 3500);
    paint();
  }

  function setLevel(key, raw) {
    const c = cur();
    if (c == null || !Number.isFinite(raw)) return;
    const k = tick();
    if (key === "pend" && pend) {
      // 대기선을 옮기면 같이 깐 익절·손절도 같은 만큼 따라간다 (거리 유지). 현재가 위·아래로 지정가 ↔ 돌파
      const p = E.roundTick(raw, k);
      const d = p - pend.price;
      pend.price = p;
      if (pend.tp != null) pend.tp = E.roundTick(pend.tp + d, k);
      if (pend.sl != null) pend.sl = E.roundTick(pend.sl + d, k);
      pend.type = E.pendingType(pend.side, p, c);
      return paint();
    }
    if ((key === "ptp" || key === "psl") && pend) {
      // 대기선 기준으로 익절은 이익 쪽, 손절은 손해 쪽에만
      const real = key === "ptp" ? "tp" : "sl";
      pend[real] = E.clampLevel(real, raw, pend, pend.price, k);
      return paint();
    }
    if (!pos || !(key in pos)) return;
    pos[key] = E.clampLevel(key, raw, pos, c, k);
    paint();
  }

  let saveTimer = 0;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveFile(FILE, acct), 300);
  };

  // ── 차트 위 선·표시 ──
  function lineList() {
    if (!ses) return [];
    return [...posLines(), ...pendLines()];
  }

  /** 미리 깐 진입선 (+ 포지션이 없으면 그 진입의 익절·손절 선). 이름표 돈은 지금 정한 크기로 들어갔을 때 */
  function pendLines() {
    if (!pend) return [];
    const r = R();
    const o = pend;
    const name = `${o.side > 0 ? "롱" : "숏"}${o.add ? " 추가" : ""} 대기 · ${o.type === "limit" ? "지정가" : "돌파"}`;
    const lev = pos ? pos.lev : T.lev;
    const dist = Math.abs(o.price - (pos ? pos.sl : o.sl)) / o.price;
    const { margin } = plannedMargin(lev, dist);
    const out = [{ key: "pend", price: o.price, color: o.side > 0 ? upColor() : downColor(), style: 3, drag: true, text: `${name} · $${num(margin * lev, 0)}` }];
    if (!o.add && o.tp != null) {
      const sim = E.open({ side: o.side, price: o.price, exact: true, maker: o.type === "limit", margin, lev, t: 0, tick: tick(), r, tp: o.tp, sl: o.sl });
      if (sim) {
        const prr = E.rrOf({ entry: o.price, tp: o.tp, sl: o.sl });
        out.push({ key: "ptp", price: o.tp, color: o.tpOn ? tpColor() : OFF_C, style: o.tpOn ? 3 : 1, drag: true, toggle: true, text: `대기 익절${o.tpOn ? "" : " 꺼짐"} ${usd(E.netAt(sim, o.tp, "tp", r))}${prr ? ` 손익비 ${prr.toFixed(1)}` : ""}` });
        out.push({ key: "psl", price: o.sl, color: o.slOn ? SL_C : OFF_C, style: o.slOn ? 3 : 1, drag: true, toggle: true, text: `대기 손절${o.slOn ? "" : " 꺼짐"} ${usd(E.netAt(sim, o.sl * (1 - o.side * r.slip), "sl", r))}` });
      }
    }
    return out;
  }

  function posLines() {
    if (!pos) return [];
    const r = R();
    const c = cur();
    const mv = (p) => `${signed(((pos.side * (p - pos.entry)) / pos.entry) * 100, 2)}%`;
    const rr = E.rrOf(pos);
    const rrTxt = rr ? ` 손익비 ${rr.toFixed(1)}` : "";
    const lev = pos.lev > 1.001 ? ` ${levText(pos.lev)}` : "";
    // 가격은 눈금 쪽 꼬리표에 보이므로 이름표에는 "그 가격에 나가면 얼마" (수수료 뺀 돈)와 평단에서 몇 % 떨어졌나.
    // 꺼진 선에도 돈·%·손익비를 다 보여 준다 (0.8.1 사용자 요청: 선이 처음에 꺼진 채로 바뀐 뒤 손익비가 안 보였다)
    const tpMoney = `${usd(E.netAt(pos, pos.tp, "tp", r))} (${mv(pos.tp)})`;
    const slMoney = `${usd(E.netAt(pos, pos.sl * (1 - pos.side * r.slip), "sl", r))} (${mv(pos.sl)})`;
    const out = [
      { key: "entry", price: pos.entry, color: pos.side > 0 ? upColor() : downColor(), style: 0, text: `${pos.side > 0 ? "롱" : "숏"}${lev} 평단 ${usd(openNet())}` },
      // 익절선이 평단에 너무 붙어 수수료가 더 크면(분할 매수 뒤에 잘 생긴다) 노란색으로 알려 준다. 꺼진 선은 회색 점선
      !pos.tpOn
        ? { key: "tp", price: pos.tp, color: OFF_C, style: 1, drag: true, toggle: true, text: `익절 꺼짐 ${tpMoney}${rrTxt} · 우클릭 켜기` }
        : tpLossNow()
          ? { key: "tp", price: pos.tp, color: WARN_C, style: 2, drag: true, toggle: true, text: `익절 ${usd(E.netAt(pos, pos.tp, "tp", r))} ⚠ 익절해도 손해` }
          : { key: "tp", price: pos.tp, color: tpColor(), style: 2, drag: true, toggle: true, text: `익절 ${tpMoney}${rrTxt}` },
      pos.slOn
        ? { key: "sl", price: pos.sl, color: SL_C, style: 2, drag: true, toggle: true, text: `손절 ${slMoney}` }
        : { key: "sl", price: pos.sl, color: OFF_C, style: 1, drag: true, toggle: true, text: `손절 꺼짐 ${slMoney} · 우클릭 켜기` },
    ];
    // 청산가선: 멀리 있으면 그 선 때문에 차트가 납작해지지 않게 눈금 범위에는 가까울 때(3% 안)만 넣는다
    if (pos.liq != null) out.push({ key: "liq", price: pos.liq, color: LIQ_C, style: 1, scale: c != null && Math.abs(pos.liq / c - 1) < 0.03, text: `청산 ${usd(E.netAt(pos, pos.liq * (1 - pos.side * r.slip), "liq", r))} (${mv(pos.liq)})` });
    return out;
  }

  function paintMarkers() {
    const c = ses?.cell;
    if (!c) return;
    const bars = c.bars;
    const out = [];
    for (const m of ses.marks) {
      const i = lastAtOrBefore(bars, m.t);
      if (i < 0) continue;
      const time = c.time(bars[i].t);
      if (m.kind === "in" || m.kind === "add") out.push({ time, position: m.side > 0 ? "belowBar" : "aboveBar", shape: m.side > 0 ? "arrowUp" : "arrowDown", color: m.side > 0 ? upColor() : downColor(), text: m.kind === "add" ? "추가" : m.side > 0 ? "롱" : "숏" });
      else if (m.kind === "part") out.push({ time, position: m.side > 0 ? "aboveBar" : "belowBar", shape: "circle", color: "#c9ced6", text: "일부" });
      else out.push({ time, position: m.side > 0 ? "aboveBar" : "belowBar", shape: "circle", color: m.why === "tp" ? tpColor() : m.why === "sl" ? SL_C : m.why === "liq" ? LIQ_C : "#c9ced6", text: WHY[m.why] });
    }
    c.setTradeMarkers(out);
  }

  // ── 화면 ──
  const field = (o = {}) => h("input.tr-in", { type: "text", inputMode: "decimal", spellcheck: false, autocomplete: "off", ...o });
  const stopKeys = (el) => el.addEventListener("keydown", (e) => {
    e.stopPropagation(); // 숫자를 칠 때 차트 단축키가 먹지 않게
    if (e.key === "Enter") el.blur();
  });
  const row = (label, ...v) => h("div.tr-row", h("span.tr-label", label), ...v);

  const sesText = h("span");
  const liveStopBtn = h("button.tr-mini", { onclick: () => stopLive(), "data-tip-text": "실시간 모의매매 끝내기\n들고 있는 것은 지금 가격으로 정리돼요" }, "■ 끝내기");
  const sesLine = h("div.tr-ses", sesText, " ", liveStopBtn);
  const chartText = h("div.tr-cov");
  const chartBtns = h("div.tr-btns");
  const covText = h("div.tr-cov");
  const dlProg = h("div.tr-prog");
  const dlBtns = h("div.tr-btns");
  const startBox = h(
    "div.tr-start",
    h("p.tr-hint", "과거 차트를 다시 틀어 놓고 연습해요. 미래 봉은 가려져 있어요."),
    h("button.primary.tr-go", { onclick: () => replay.startRandom() }, "🎲 아무 때나 시작"),
    h("button.tr-go2", { onclick: () => replay.start() }, "📍 차트에서 시작점 고르기"),
    h("button.tr-go2", { onclick: () => startLive(), "data-tip-text": "지금 보고 있는 차트의 실시간 가격으로 연습해요 (진짜 주문 없음)\n바이낸스 종목은 24시간, 국내·미국 주식은 장중에만 가격이 움직여요" }, "📡 지금 실시간으로"),
    h("div.tr-data", h("b", "차트 봉 (5분·15분·30분·1시간·4시간)"), chartText, chartBtns, h("b", "과거 1분봉"), covText, dlBtns, dlProg)
  );

  const cashEl = h("span.tr-num");
  const usedEl = h("span.tr-num");
  const upnlEl = h("span.tr-num");
  const eqEl = h("span.tr-num.tr-big");
  const levSeg = h("span.tr-levs");
  // 원하는 배율을 직접 (사용자 요청 2026-10-30: 소수점 두 자리까지, 예 3.75)
  const levIn = field({ onchange: () => setLev(parseFloat(String(levIn.value).replace(/[^0-9.]/g, ""))), "data-tip-text": "원하는 배율을 직접 넣어요 (소수점 두 자리까지, 예: 3.75)\n1배부터 ⚙ 최대 레버리지까지" });
  stopKeys(levIn);
  const amtIn = field({ onchange: () => setAmount(parseFloat(String(amtIn.value).replace(/[,$]/g, ""))) });
  stopKeys(amtIn);
  const pctBtns = [0.25, 0.5, 1].map((p) => h("button.tr-pct", { onclick: () => setAmount(Math.floor(avail() * p)), "data-tip-text": `주문 가능한 돈의 ${p * 100}%` }, `${p * 100}%`));
  const sizeEl = h("div.tr-size");
  // 수량 정하기: 증거금을 직접 / 손절 기준 (손절에 닿으면 계좌의 몇 %만 잃을지 → 수량이 저절로)
  const modeSeg = h("span.tr-mode");
  const amtRow = h("div.tr-amt", h("span.tr-label", "증거금 $"), amtIn, ...pctBtns);
  const riskSeg = h("span.tr-levs");
  const riskRow = h("div.tr-amt", h("span.tr-label", "한 번에 잃을 돈"), riskSeg, h("span.tr-label", "(계좌의)"));
  // 미리 선 깔기 (지정가·돌파 대기 주문)
  const pendLongBtn = h("button.tr-part", { onclick: () => placePending(1), "data-tip-text": "원하는 가격에 롱 진입선을 미리 깔아요\n현재가 아래 = 지정가(내려오면 사기), 위 = 돌파(올라가면 사기)\n차트에서 선을 끌어 옮기세요" }, "롱 대기선");
  const pendShortBtn = h("button.tr-part", { onclick: () => placePending(-1), "data-tip-text": "원하는 가격에 숏 진입선을 미리 깔아요\n현재가 위 = 지정가(올라오면 팔기), 아래 = 돌파(내려가면 팔기)\n차트에서 선을 끌어 옮기세요" }, "숏 대기선");
  const pendCancelBtn = h("button.tr-part", { onclick: () => cancelPending() }, "대기 취소");
  const pendInfo = h("div.tr-size");
  const buyBtn = h("button.tr-buy", { onclick: () => enter(1), "data-tip-text": "지금 가격으로 사기 (B)\n오르면 이익 · 롱을 들고 있으면 더 사기(분할 매수)" }, "매수 (롱)");
  const sellBtn = h("button.tr-sell", { onclick: () => enter(-1), "data-tip-text": "지금 가격으로 팔기 (S)\n내리면 이익 · 숏을 들고 있으면 더 팔기(분할 매도)" }, "매도 (숏)");
  // 원하는 양만 정리: 25·50·75% 버튼은 바로, 수량을 쳐서 [정리]
  const partBtns = [0.25, 0.5, 0.75].map((p) => h("button.tr-part", { onclick: () => pos && closePart(pos.qty * p), "data-tip-text": `들고 있는 수량의 ${p * 100}%를 지금 가격으로 정리` }, `${p * 100}%`));
  const flatBtn = h("button.tr-flat", { onclick: () => closeNow(), "data-tip-text": "남은 것 전부 지금 가격으로 정리 (X)" }, "전부 종료");
  const partIn = field({ placeholder: "수량" });
  stopKeys(partIn);
  partIn.addEventListener("keydown", (e) => e.key === "Enter" && partGo());
  const partGo = () => {
    const q = parseFloat(String(partIn.value).replace(/,/g, ""));
    if (!Number.isFinite(q)) return toast("정리할 수량을 넣어 주세요");
    closePart(q);
    partIn.value = "";
  };
  const partOk = h("button.tr-part", { onclick: () => partGo() }, "정리");
  const sideEl = h("span.tr-num");
  const entryEl = h("span.tr-num");
  const marginEl = h("span.tr-num");
  const liqEl = h("span.tr-num.liq");
  const pnlEl = h("span.tr-num");
  const heldEl = h("span.tr-num");
  const rrEl = h("span.tr-num");
  const riskEl = h("span.tr-num");
  // 메모: 들고 있는 동안 "왜 들어갔나"를 적어 두면 거래 기록에 같이 남는다 (일지에서 고칠 수 있다)
  const memoIn = h("input.tr-memo", { type: "text", placeholder: "메모 — 왜 들어갔나 (기록에 남아요)", spellcheck: false, autocomplete: "off", maxLength: 200, oninput: () => pos && (pos.memo = memoIn.value.trim()) });
  memoIn.addEventListener("keydown", (e) => {
    e.stopPropagation(); // 글자를 칠 때 B·S·X 매매 단축키·종목 찾기가 먹지 않게
    if (e.key === "Enter") memoIn.blur();
  });
  const tpTog = h("button.tr-tog", { onclick: () => toggleLine("tp"), "data-tip-text": "익절선 켜기·끄기 (차트에서 선을 오른쪽 클릭해도 돼요)\n꺼져 있으면 가격이 닿아도 정리되지 않아요" });
  const slTog = h("button.tr-tog", { onclick: () => toggleLine("sl"), "data-tip-text": "손절선 켜기·끄기 (차트에서 선을 오른쪽 클릭해도 돼요)\n꺼져 있으면 가격이 닿아도 정리되지 않아요" });
  const tpIn = field({ onchange: () => setLevel("tp", parseFloat(tpIn.value)) });
  const slIn = field({ onchange: () => setLevel("sl", parseFloat(slIn.value)) });
  stopKeys(tpIn);
  stopKeys(slIn);
  const tpWarnEl = h("div.tr-warn", { hidden: true }, "⚠ 지금 익절선은 평단에 너무 가까워서 익절해도 수수료 때문에 손해예요. 익절선을 조금 더 멀리 끌어 주세요.");
  // 거래 기록 (시안 A): 숫자 칸 4개 + 최근 5개 두 줄 카드 + 📒 전체 일지
  const RECENT = 5;
  const tilesBox = h("div");
  const listEl = h("div.tr-list");
  const journalBtn = h("button.tr-journal", { onclick: () => journal.open(), "data-tip-text": "누적 손익 곡선 · 모든 거래 표 · 종목·방향·연습 판별로 걸러 보기" }, "📒 전체 일지 열기");
  let listKey = "";

  const setNum = (key, v) => {
    T[key] = v;
    if (key === "max_lev") {
      T.lev = Math.min(T.lev, v);
      if (pos) pos.liq = E.liqPrice(pos, R()); // 유지증거금이 바뀌면 청산가도
    }
    cfg.save();
    paint();
  };
  const settings = h(
    "details.tr-set",
    h("summary", "⚙ 수수료 · 처음 선 위치 · 최대 레버리지"),
    row("익절·손절선 처음에", onOff(() => !!T.tpsl_on, (v) => setNum("tpsl_on", v), "켜 두기")),
    h("p.tr-hint", "끔(기본): 들어가면 선이 회색 점선으로 깔리고 닿아도 정리되지 않아요. 끌어서 자리를 잡은 뒤 선을 오른쪽 클릭(또는 포지션 칸의 켜짐/꺼짐)으로 켜세요."),
    row("최대 레버리지", stepper(() => T.max_lev, (v) => setNum("max_lev", v), { step: 1, min: 1, max: 50, fmt: (v) => `${v}배`, parse: parseFloat })),
    h("p.tr-hint", "그 종목의 최대 배율이에요 (trade.xyz 주식: 대형주 20배, 대부분 10배). 청산 기준(유지증거금)이 최대 배율 증거금의 절반이라 20배면 2.5%, 10배면 5%."),
    row("처음 익절", stepper(() => T.tp_pct, (v) => setNum("tp_pct", v), { step: 0.05, min: 0.05, max: 20, fmt: (v) => `${v}%`, parse: parseFloat })),
    row("처음 손절", stepper(() => T.sl_pct, (v) => setNum("sl_pct", v), { step: 0.05, min: 0.05, max: 20, fmt: (v) => `${v}%`, parse: parseFloat })),
    row("시장가 수수료", stepper(() => T.fee_taker, (v) => setNum("fee_taker", v), { step: 0.01, min: 0, max: 1, fmt: (v) => `${v}%`, parse: parseFloat })),
    row("지정가 수수료", stepper(() => T.fee_maker, (v) => setNum("fee_maker", v), { step: 0.01, min: -0.1, max: 1, fmt: (v) => `${v}%`, parse: parseFloat })),
    row("미끄러짐", stepper(() => T.slip, (v) => setNum("slip", v), { step: 0.01, min: 0, max: 1, fmt: (v) => `${v}%`, parse: parseFloat })),
    row("시작 자금", stepper(() => T.start_cash, (v) => setNum("start_cash", v), { step: 1000, min: 100, max: 10000000, fmt: (v) => `$${num(v, 0)}`, parse: parseFloat })),
    h("p.tr-hint", "기본값은 trade.xyz(Hyperliquid 주식 토큰) 수수료를 가정한 값이에요. 미끄러짐 = 시장가로 사고팔 때 불리하게 밀리는 정도. 시작 자금은 '↺ 계좌 처음부터'를 누를 때 들어가요.")
  );

  root.replaceChildren(
    h("div.tr-head", h("b.tr-title", "💰 모의매매"), h("span.tr-sub", "가상 돈 · 진짜 주문 없음"), h("div.grow"), h("button.icon", { onclick: () => toggle(false), "data-tip-text": "모의매매 창 닫기" }, "✕")),
    sesLine,
    startBox,
    h("div.tr-card", h("div.tr-cap", "계좌 ", h("button.tr-mini", { onclick: () => resetAccount(), "data-tip-text": "잔고와 거래 기록을 처음으로" }, "↺ 처음부터")), row("잔고", cashEl), row("묶인 증거금", usedEl), row("평가 손익", upnlEl), row("합계", eqEl)),
    h("div.tr-lev", h("span.tr-label", "레버리지"), levSeg, h("span.tr-levc", levIn, "배")),
    h("div.tr-lev", h("span.tr-label", "수량 정하기"), modeSeg),
    amtRow,
    riskRow,
    sizeEl,
    h("div.tr-buysell", buyBtn, sellBtn),
    h("div.tr-close", h("span.tr-label", "미리 깔기"), pendLongBtn, pendShortBtn, pendCancelBtn),
    pendInfo,
    h("div.tr-close", h("span.tr-label", "정리"), ...partBtns, flatBtn),
    h("div.tr-close", h("span.tr-label", "원하는 양"), partIn, h("span.tr-label", "주"), partOk),
    h("div.tr-card", h("div.tr-cap", "포지션"), row("방향 · 수량", sideEl), row("평단", entryEl), row("증거금", marginEl), row(h("span.liq", "청산가"), liqEl), row("지금 손익", pnlEl), row(h("span.tp", "익절 가격"), h("span.tr-lv", tpIn, tpTog)), tpWarnEl, row(h("span.sl", "손절 가격"), h("span.tr-lv", slIn, slTog)), row("손절에 닿으면", riskEl), row("손익비", rrEl), row("들고 있은 시간", heldEl), memoIn),
    h("p.tr-hint", "매수·매도를 누르면 ", h("b.tp", "익절선"), "과 ", h("b.sl", "손절선"), "이 ", h("b", "꺼진 채(회색 점선)"), "로 생겨요. ", h("b", "선이나 이름표를 마우스로 잡고 위아래로 끌어"), " 자리를 잡고, ", h("b", "선을 오른쪽 클릭"), "하면 켜져요 (켜진 선만 닿으면 정리돼요). 숫자를 고쳐도 돼요. 들고 있는 쪽 버튼을 한 번 더 누르면 ", h("b", "분할 매수"), "(평단이 바뀌어요). ", h("b", "미리 깔기"), "는 원하는 가격에 진입선을 그어 두면 가격이 닿을 때 들어가요 (점선, 끌어서 옮김). 레버리지를 쓰면 ", h("b.liq", "청산가선"), "(자홍색)이 생기고, 가격이 닿으면 강제로 정리돼 증거금의 큰 부분을 잃어요 (20배면 약 절반, 10배면 약 ¾). 단축키: B 매수 · S 매도 · X 전부 종료 · Space 재생 · → 한 칸"),
    h("div.tr-card", h("div.tr-cap", "거래 기록"), tilesBox, listEl, journalBtn),
    settings,
    h("p.tr-hint", "체결 규칙: 그 종목 1분봉으로 판단 · 한 봉에서 익절·손절이 둘 다 닿으면 손절 먼저 · 익절(지정가)은 한 틱 넘게 지나가야 · 시가가 선을 건너뛰면 시가로 · 시장가는 미끄러짐 + 시장가 수수료 · 청산은 격리 증거금 기준 (Hyperliquid 방식)")
  );

  /** 배율 정하기: 버튼 또는 직접 입력 (소수점 두 자리로 반올림, 1배 ~ 최대 레버리지) */
  function setLev(v) {
    if (pos) {
      toast("포지션을 들고 있는 동안에는 배율을 못 바꿔요");
      return paint();
    }
    if (!Number.isFinite(v)) return paint();
    v = Math.round(v * 100) / 100;
    if (v < 1) {
      toast("레버리지는 1배부터예요");
      v = 1;
    } else if (v > T.max_lev) {
      toast(`최대 레버리지가 ${T.max_lev}배라서 ${T.max_lev}배로 했어요 · 더 높이려면 아래 ⚙에서 최대 레버리지를 올리세요`, 5000);
      v = T.max_lev;
    }
    T.lev = v;
    cfg.save();
    paint();
  }

  function setMode(k, v) {
    T[k] = v;
    cfg.save();
    paint();
  }

  function setAmount(v) {
    if (!Number.isFinite(v) || v <= 0) return paint();
    T.amount = Math.round(v);
    cfg.save();
    paint();
  }

  async function resetAccount() {
    if (!(await confirmBox("계좌를 처음부터 할까요?", `잔고가 $${num(T.start_cash, 0)}로 돌아가고 거래 기록 ${acct.trades.length}개가 지워져요.`, { ok: "처음부터", danger: true }))) return;
    pos = null;
    if (ses) ses.marks = [];
    acct = { start: T.start_cash, cash: T.start_cash, trades: [] };
    save();
    paint();
    journal.render();
  }

  function paint() {
    if (ses) {
      paintMarkers();
      lines.refresh();
    }
    if (!isOpen) return;
    const c = cur();
    const u = openNet();
    startBox.hidden = !!ses;
    sesLine.hidden = !ses;
    liveStopBtn.hidden = !ses?.live;
    if (ses?.live) {
      // 가격이 한참 안 움직이면 알려 준다 (장이 닫혔거나 실시간 시세가 없는 종목)
      const still = Math.round((Date.now() - ses.movedAt) / 1000);
      sesText.textContent = `📡 ${ses.info.label} 실시간${c != null ? ` · 현재가 ${px(c)}` : ""}${still >= 60 ? ` · ${still >= 120 ? `${Math.floor(still / 60)}분` : `${still}초`}째 가격 그대로 (장이 닫혔거나 실시간 시세가 없어요)` : ""}`;
    } else if (ses) sesText.textContent = `▶ ${ses.info.label} · ${TF_NAME[ses.cell.tf]}봉 리플레이 중${ses.m1 ? "" : " (1분봉 없음 → 봉으로 체결)"}${c != null ? ` · 현재가 ${px(c)}` : ""}`;
    cashEl.textContent = `$${num(acct.cash, 2)}`;
    usedEl.textContent = pos ? `$${num(pos.margin, 2)} (주문 가능 $${num(Math.max(0, avail()), 0)})` : "—";
    upnlEl.textContent = pos ? usd(u) : "—";
    upnlEl.className = `tr-num ${cls(u)}`;
    const eq = acct.cash + u;
    eqEl.textContent = `$${num(eq, 2)} (${signed((eq / acct.start - 1) * 100, 2)}%)`;
    eqEl.className = `tr-num tr-big ${cls(eq - acct.start)}`;
    // 레버리지: 포지션을 들고 있으면 그 배율로 고정 (최대 레버리지보다 큰 것은 못 고름)
    const levNow = Number((pos ? pos.lev : T.lev).toFixed(2));
    levIn.disabled = !!pos;
    if (document.activeElement !== levIn) levIn.value = String(levNow);
    const levKey = `${levNow}|${T.max_lev}|${!!pos}`;
    if (levSeg.dataset.k !== levKey) {
      // 바뀔 때만 다시 만든다 (재생 중 매 칸마다 만들면 누르는 사이에 버튼이 바뀌어 안 눌린다)
      levSeg.dataset.k = levKey;
      levSeg.replaceChildren(...LEVS.filter((v) => v <= T.max_lev).map((v) => h(`button.tr-levb${v === levNow ? ".on" : ""}`, { onclick: () => setLev(v), disabled: !!pos && v !== levNow }, `${v}배`)));
    }
    if (document.activeElement !== amtIn) amtIn.value = num(T.amount, 0);
    const lev = pos ? pos.lev : T.lev;
    // 수량 정하기 (바뀔 때만 버튼을 다시 만든다)
    const modeKey = `${T.size_mode}|${T.risk_pct}`;
    if (modeSeg.dataset.k !== modeKey) {
      modeSeg.dataset.k = modeKey;
      modeSeg.replaceChildren(
        h(`button.tr-levb${T.size_mode !== "risk" ? ".on" : ""}`, { onclick: () => setMode("size_mode", "amount"), "data-tip-text": "증거금(내 돈)을 직접 정해요" }, "증거금으로"),
        h(`button.tr-levb${T.size_mode === "risk" ? ".on" : ""}`, { onclick: () => setMode("size_mode", "risk"), "data-tip-text": "손절에 닿으면 계좌의 몇 %만 잃을지 정하면 수량이 저절로 정해져요\n손절이 가까우면 크게, 멀면 작게 들어가요" }, "손절 기준")
      );
      riskSeg.replaceChildren(...[0.5, 1, 2, 3].map((v) => h(`button.tr-levb${v === T.risk_pct ? ".on" : ""}`, { onclick: () => setMode("risk_pct", v) }, `${v}%`)));
    }
    amtRow.hidden = T.size_mode === "risk";
    riskRow.hidden = T.size_mode !== "risk";
    if (T.size_mode === "risk") {
      // 새로 들어갈 때: 처음 손절 위치(%) 기준. 들고 있으면: 지금 가격에서 손절선까지 (분할 매수할 때)
      const r = R();
      const dist = pos && c != null ? Math.abs(c - pos.sl) / c : r.sl;
      const pm = plannedMargin(lev, dist);
      sizeEl.textContent = `손절(${signed(-dist * 100, 2)}%)에 닿으면 −$${num(pm.risk, 2)} (계좌의 ${T.risk_pct}%) → 포지션 $${num(pm.margin * lev, 0)} · 증거금 $${num(pm.margin, 0)} (${levText(lev)})${pm.capped ? " · ⚠ 돈이 모자라 줄어요 (레버리지를 올리면 계획대로)" : ""}`;
    } else sizeEl.textContent = `포지션 크기 $${num(T.amount * lev, 0)} = 증거금 × ${levText(lev)}${c != null ? ` · 약 ${num((T.amount * lev) / c, 3)}주` : ""}`;
    // 미리 깔기
    pendLongBtn.disabled = !ses || (pos && pos.side < 0);
    pendShortBtn.disabled = !ses || (pos && pos.side > 0);
    pendCancelBtn.disabled = !pend;
    pendInfo.hidden = !pend;
    if (pend && c != null) pendInfo.textContent = `${pend.side > 0 ? "롱" : "숏"}${pend.add ? " 추가" : ""} 대기 ${px(pend.price)} (현재가 ${signed((pend.price / c - 1) * 100, 2)}%) · ${pend.type === "limit" ? "지정가: 가격이 선을 넘어오면 들어가요 (지정가 수수료)" : "돌파: 가격이 선에 닿으면 시장가로 들어가요"}`;
    // 들고 있는 쪽 버튼 = 분할 매수, 반대쪽은 막는다 (줄이기는 정리 버튼으로)
    buyBtn.textContent = pos?.side > 0 ? "추가 매수 (롱)" : "매수 (롱)";
    sellBtn.textContent = pos?.side < 0 ? "추가 매도 (숏)" : "매도 (숏)";
    buyBtn.disabled = pos?.side < 0;
    sellBtn.disabled = pos?.side > 0;
    for (const b of [...partBtns, flatBtn, partOk]) b.disabled = !pos;
    partIn.disabled = !pos;
    partIn.placeholder = pos ? `최대 ${pos.qty}` : "수량";
    sideEl.textContent = pos ? `${pos.side > 0 ? "롱" : "숏"} ${levText(pos.lev)} · ${pos.qty}주${pos.adds ? ` (추가 ${pos.adds}번)` : ""}` : "없음";
    sideEl.className = `tr-num ${pos ? (pos.side > 0 ? "up" : "down") : ""}`;
    entryEl.textContent = pos ? px(pos.entry) : "—";
    marginEl.textContent = pos ? `$${num(pos.margin, 2)}` : "—";
    liqEl.textContent = pos ? (pos.liq != null && c != null ? `${px(pos.liq)} (${signed((pos.liq / c - 1) * 100, 1)}%)` : "없음 (1배 롱)") : "—";
    // 지금 손익: 돈 + 증거금 대비 % (레버리지를 쓰면 이 %가 크게 움직인다)
    pnlEl.textContent = pos && c != null ? `${usd(u)} (${signed((u / pos.margin) * 100, 2)}%)` : "—";
    pnlEl.className = `tr-num ${cls(u)}`;
    const rr = pos ? E.rrOf(pos) : null;
    rrEl.textContent = rr ? rr.toFixed(2) : "—";
    // 손절에 닿으면 잃는 돈 (계좌 대비 %) — 손절선을 끌면 바로 바뀐다
    if (pos) {
      const r = R();
      const lossAtSl = E.netAt(pos, pos.sl * (1 - pos.side * r.slip), "sl", r);
      riskEl.textContent = `${usd(lossAtSl)} (계좌의 ${signed((lossAtSl / acct.cash) * 100, 2)}%)${pos.slOn ? "" : " · 손절 꺼짐"}`;
      riskEl.className = `tr-num ${cls(lossAtSl)}`;
    } else riskEl.textContent = "—";
    for (const [b, k] of [[tpTog, "tpOn"], [slTog, "slOn"]]) {
      b.disabled = !pos;
      b.textContent = pos?.[k] ? "켜짐" : "꺼짐";
      b.classList.toggle("on", !!pos?.[k]);
    }
    memoIn.disabled = !pos;
    if (document.activeElement !== memoIn) memoIn.value = pos?.memo ?? "";
    heldEl.textContent = pos && ses ? duration(Math.max(0, ses.endT - pos.t)) : "—";
    for (const [el, key] of [[tpIn, "tp"], [slIn, "sl"]]) {
      el.disabled = !pos;
      if (document.activeElement !== el) el.value = pos ? px(pos[key]).replace(/,/g, "") : "";
    }
    tpWarnEl.hidden = !tpLossNow();
    // 거래 기록은 거래가 바뀔 때만 다시 그린다 (재생 중 매 칸마다 그리면 누르는 사이에 바뀐다)
    const key = `${acct.trades.length}|${acct.trades[0]?.at ?? acct.trades[0]?.t1 ?? ""}`;
    if (key !== listKey) {
      listKey = key;
      tilesBox.replaceChildren(statTiles(acct.trades));
      listEl.replaceChildren(...(acct.trades.length ? acct.trades.slice(0, RECENT).map((tr) => tradeRow(tr, { onclick: () => review(tr) })) : [h("p.tr-hint", "아직 거래가 없어요")]));
      journalBtn.textContent = `📒 전체 일지 열기 (${acct.trades.length}번)`;
      journal.render();
    }
  }

  /**
   * 복기: 그 거래의 종목·봉으로 가서 들어간 날짜로 이동하고, 들어간 곳(화살표)·나온 곳(점)을 표시한다.
   * 리플레이 중이면 끝내고 간다 (들고 있는 포지션이 있으면 먼저 정리해야 한다)
   */
  async function review(tr) {
    if (pos) return toast("들고 있는 포지션을 먼저 정리해 주세요 (X)");
    if (replay.active) replay.stop();
    stopLive(); // 복기는 옛날 날짜로 가서 실시간 갱신이 멈춘다
    journal.close();
    if (grid.current?.cc.symbol !== tr.sym) grid.setSymbol(tr.sym);
    const c = grid.current;
    if (!c) return;
    const tf = tr.tf && c.info.tfs.includes(tr.tf) ? tr.tf : c.tf;
    const [date, time] = whenText(tr, tr.t0).split(" ");
    const r = await c.goToDate(date, time, tf, "local");
    if (!r?.ok || grid.current !== c) return toast("그 날짜의 봉을 읽지 못했어요");
    const bars = c.bars;
    const i0 = lastAtOrBefore(bars, tr.t0);
    const i1 = lastAtOrBefore(bars, tr.t1 - 1);
    const mk = [];
    if (i0 >= 0) mk.push({ time: c.time(bars[i0].t), position: tr.side > 0 ? "belowBar" : "aboveBar", shape: tr.side > 0 ? "arrowUp" : "arrowDown", color: tr.side > 0 ? upColor() : downColor(), text: `${tr.side > 0 ? "롱" : "숏"} ${px2(tr.entry, tr.d)}` });
    if (i1 >= 0) mk.push({ time: c.time(bars[i1].t), position: tr.side > 0 ? "aboveBar" : "belowBar", shape: "circle", color: tr.why === "tp" ? tpColor() : tr.why === "sl" ? SL_C : tr.why === "liq" ? LIQ_C : "#c9ced6", text: `${WHY[tr.why] ?? tr.why} ${usd(tr.net)}` });
    c.setTradeMarkers(mk);
    reviewCell = c;
    toast(`복기: ${tr.label ?? tr.sym} ${date} · 화살표 = 들어간 곳, 점 = 나온 곳\n여기서 🎲 대신 📍로 이 근처부터 다시 연습할 수도 있어요`, 7000);
  }
  const px2 = (v, d = 2) => num(v, d);

  /** 지금 칸 종목의 차트 봉·1분봉이 얼마나 있나 + 받기 버튼 */
  async function paintData() {
    if (!isOpen) return;
    const c = grid.current;
    const info = c?.cc.symbol ? c.info : null;
    if (!info) {
      chartText.textContent = "종목을 먼저 고르세요";
      chartBtns.replaceChildren();
      covText.textContent = "";
      dlBtns.replaceChildren();
      return;
    }
    const [ch, cov] = await Promise.all([HIS.chartCoverage(info).catch(() => null), HIS.coverage(info).catch(() => null)]);
    chartText.textContent = !ch ? "" : ch.first == null ? "5분봉: 아직 없어요" : `5분봉 ${ymd(ch.first)}부터 (${spanText(ch.years)}${ch.all ? (ch.src === "toss" ? " · 토스에 있는 만큼 전부" : " · 상장일부터 전부") : ""})`;
    covText.textContent = cov ? `${info.label}: ${ymd(cov.first)} ~ ${ymd(cov.last)} (${Math.floor(cov.days)}일${cov.all ? " · 상장일부터 전부" : ""})` : `${info.label}: 아직 없어요`;
    if (dl) return;
    if (dlProg.dataset.sym !== info.id) dlProg.textContent = ""; // 다른 종목의 "다 받았어요"는 지운다
    paintChart(info, ch);
    // 국내 주식 + 토스: 위 "차트 봉 받기"가 토스 1분봉으로 1분·5분·1시간봉을 같이 받는다
    if (HIS.canToss(info)) {
      dlBtns.replaceChildren(h("span.tr-hint", "위 차트 봉을 받으면 1분봉도 같이 받아요 (토스, 약 4년 전까지)."));
      return;
    }
    if (info.kind === "kr") {
      dlBtns.replaceChildren(h("span.tr-hint", "지금은 야후 1분봉 30일치뿐이에요. ⚙ 설정 → 데이터에 토스 키를 넣으면 약 4년치를 받을 수 있어요."));
      return;
    }
    if (!HIS.canBackfill(info)) {
      dlBtns.replaceChildren(h("span.tr-hint", info.kind === "perp" ? "Hyperliquid는 최근 3.5일치만 줘요. Binance 종목(bn:…)은 상장일부터 받을 수 있어요." : "원본 앱과 같은 방법으로 받아요 (미국 주식 1분봉은 알파카 키 → 최근 12개월)."));
      return;
    }
    const btn = (label, days, tip) => h("button", { onclick: () => download(info, { days }), "data-tip-text": tip }, label);
    dlBtns.replaceChildren(btn("30일 받기", 30, "최근 30일 1분봉 (약 15초)"), btn("90일", 90, "최근 90일 1분봉 (약 40초)"), btn("상장일부터", null, "상장일부터 전부 (최근 상장 종목 1~2분, BTC처럼 오래된 종목은 15분쯤·200MB 넘게)\n리플레이는 필요한 1분봉을 알아서 받아서 꼭 받을 필요는 없어요"));
  }

  const spanText = (years) => (years < 1 ? `${Math.max(1, Math.round(years * 365))}일` : `약 ${years.toFixed(1)}년`);

  /** 차트 봉 2년씩 받기 버튼 (사용자 요청 2026-10-30: 뒤로 당기고 당기는 대신 한 번에 2년치, 또 누르면 2년 더) */
  function paintChart(info, ch) {
    if (!ch) {
      const why =
        info.intraday === "alpaca"
          ? "미국 주식 5분봉은 알파카 키가 있으면 2016년부터 저절로 받아요 (15분·1시간·4시간봉은 5분봉으로 그려요)."
          : info.kind === "kr"
            ? "야후는 5분봉 60일·1시간봉 2년까지만 줘요. ⚙ 설정 → 데이터에 토스 키를 넣으면 2년씩 더 받을 수 있어요."
            : info.kind === "perp"
              ? "Hyperliquid는 봉마다 최근 5,000개뿐이에요. Binance 종목(bn:…)은 2년씩 받을 수 있어요."
              : "이 종목은 무료 데이터(야후)가 주는 만큼만 있어요 (5분봉 60일·1시간봉 2년).";
      return chartBtns.replaceChildren(h("span.tr-hint", why));
    }
    if (ch.all) return chartBtns.replaceChildren(h("span.tr-hint", "더 옛날 봉은 없어요."));
    const step = HIS.CHART_STEP;
    const until = ymd(Math.floor(Date.now() / 1000) - ch.next * HIS.YEAR);
    chartBtns.replaceChildren(
      h("button", { onclick: () => download(info, { src: "chart", years: ch.next }) }, ch.next <= step ? `📥 ${step}년치 받기` : `📥 ${step}년 더 받기 (${ch.next}년치까지)`),
      h("p.tr-hint", `누르면 ${until}까지 · ${ch.src === "toss" ? "토스, 약 3~5분" : "약 2~3분"} · 누를 때마다 ${step}년씩 더`)
    );
  }

  /** 받기: src "binance" = 1분봉(과 다른 봉) days일 전까지 · "chart" = 차트 봉 years년 전까지 (국내는 토스로) */
  async function download(info, { days = null, years = null, src = "binance" } = {}) {
    if (dl) return;
    dl = { stop: false };
    (src === "chart" ? chartBtns : dlBtns).replaceChildren(h("button", { onclick: () => dl && (dl.stop = true) }, "멈추기"));
    dlProg.textContent = "받는 중…";
    dlProg.dataset.sym = info.id;
    try {
      const opts = { onProgress: (f, text) => (dlProg.textContent = `${Math.round(f * 100)}% · ${text}`), stop: () => dl?.stop };
      const n = src === "chart" ? await HIS.backfillChart(info, { ...opts, years }) : await HIS.backfill(info, { ...opts, days });
      dlProg.textContent = dl.stop ? "멈췄어요 (다음에 이어서 받아요)" : `다 받았어요 ✓ ${num(n, 0)}봉`;
      // 그 종목 차트를 다시 읽어 받은 만큼 뒤로 보이게
      for (const c of grid.cells) if (c.cc.symbol === info.id && !c.replaying) c.reload?.();
      if (!dl.stop) toast(src === "chart" ? `${info.label.replace(/ 24h$/, "")} 차트 봉을 ${years}년 전까지 받았어요 · 차트를 뒤로 밀어 보세요` : "다 받았어요 · 🎲 아무 때나 시작을 눌러 보세요", 6000);
    } catch (e) {
      dlProg.textContent = `받지 못했어요 (${e?.message ?? e})`;
    } finally {
      dl = null;
      paintData();
    }
  }

  function toggle(on = !isOpen) {
    isOpen = on;
    root.hidden = !on;
    T.panel = on;
    cfg.save();
    onToggle?.(on);
    if (on) {
      paint();
      paintData();
    }
  }

  if (T.panel) toggle(true);
  else root.hidden = true;
  if (orphan) settleOrphan(orphan);

  /** 차트 봉 2년(더) 받기 (차트를 뒤로 당길 때 뜨는 알림의 버튼) → 💰 창을 열고 진행을 보여 준다 */
  async function downloadChart(info) {
    if (dl) return toast("다른 봉을 받는 중이에요 · 💰 창에서 진행을 볼 수 있어요");
    const ch = await HIS.chartCoverage(info).catch(() => null);
    if (!ch)
      return toast(
        info.intraday === "alpaca"
          ? "미국 주식 5분봉은 알파카 키가 있으면 처음 열 때 2016년부터 저절로 받아요"
          : info.kind === "kr"
            ? "토스 키가 없거나 다른 PC가 토스를 쓰는 중이에요 (야후는 5분봉 60일·1시간봉 2년까지만 줘요)"
            : "이 종목은 더 받을 수 없어요 (무료 데이터가 주는 만큼만 있어요)",
        6000
      );
    if (ch.all) return toast("더 옛날 봉은 없어요 (이미 다 받았어요)");
    toggle(true);
    download(info, { src: "chart", years: ch.next });
  }

  return {
    toggle,
    get isOpen() {
      return isOpen;
    },
    prepare,
    startLive,
    stopLive,
    get live() {
      return !!ses?.live;
    },
    /** 지금 판: 매매하는 칸·들고 있는 것·대기선 (main.js guardTrading이 "끝나요" 경고에 쓴다, 0.13.0) */
    get stake() {
      if (!ses) return null;
      return { cell: ses.cell, live: !!ses.live, holding: pos ? `${ses.info.label.replace(/ 24h$/, "")} ${pos.side > 0 ? "롱" : "숏"}` : null, pending: !!pend };
    },
    downloadChart,
    get downloading() {
      return !!dl;
    },
    onBegin,
    onStep,
    onStop,
    onMain,
    onReplayStart,
    paintData,
    /** 봉 색(한국식·미국식)을 바꾼 뒤 선·표시·일지를 새 색으로 (0.13.0) */
    repaint() {
      paint();
      journal.render();
    },
    journal,
    review,
    /** 단축키 B 매수 · S 매도 · X 종료 (창이 열려 있고 리플레이 중일 때만. 아니면 글자 → 종목 찾기 그대로) → 처리했으면 true */
    handleKey(e) {
      if (!isOpen || !ses || e.ctrlKey || e.altKey || e.metaKey || !(e.code in KEYS)) return false;
      e.preventDefault();
      const k = KEYS[e.code];
      if (k) enter(k);
      else closeNow();
      return true;
    },
    // 시험·확인용
    get pos() {
      return pos;
    },
    get account() {
      return acct;
    },
    get session() {
      return ses;
    },
    enter,
    closeNow,
    setLevel,
    lines,
  };
}

/** 정렬된 1분봉에서 t + 60 > endT인 첫 위치 (지금 시각 뒤에 끝나는 첫 봉) */
function firstEndingAfter(m1, endT) {
  let lo = 0;
  let hi = m1.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (m1[mid].t + 60 <= endT) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** bars에서 t 이하인 마지막 봉 위치 (없으면 -1) */
function lastAtOrBefore(bars, t) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
