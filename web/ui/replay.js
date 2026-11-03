// ▶ 바 리플레이 (SPEC §3.8): 차트에서 시작할 봉을 누르면 그 뒤 봉이 가려지고, 하나씩 다시 재생한다
// - 지표·자동 삼각수렴·매물대도 그 시점까지의 봉으로만 계산 (칸이 잘린 봉만 받으므로 저절로)
// - 분할 화면이면 모든 칸이 같은 시각까지 같이 (그때까지 "끝난" 봉만 보인다. 0.8.1부터 동기화 설정과 상관없이 늘)
// - 저장소 데이터만 쓴다 → 인터넷·API 요청 없음. 재생 중에는 그 칸의 실시간 갱신을 멈춘다
// FAKE TRADING에서 더한 것 (기획서 §4-1·§12):
// - 1분봉이 저장돼 있으면 1분씩 흘러간다 → 5·15분봉도 진행 중인 봉이 실제처럼 자란다 (cell.replayNextEnd)
// - 리플레이 중에 봉을 바꿔도 같은 시각부터 이어 간다 (cell.load keepReplay)
// - 🎲 아무 때나: 받아 둔 기간 중 아무 시각에서 시작 (날짜를 모르고 연습 → 외운 차트가 아니라 실력으로)
// - 모의매매는 onPrepare(시작 전 1분봉 받기)·onBegin·onStep·onStop으로 붙는다 (web/trade/panel.js)
import { h, segment } from "./dom.js";
import { ymd, DAY } from "../core/tz.js";
import * as db from "../core/db.js";
import { baseTf } from "../core/intraday.js";
import { isDailyTf } from "../core/bars.js";

const SPEEDS = [1, 2, 5, 10, 30];

export function createReplay(root, { cfg, grid, gridBox, toast, onChange, onPrepare, onBegin, onStep, onStop, confirmEnd }) {
  let picking = false;
  let active = false;
  let playing = false;
  let timer = null;
  let endT = null;
  let master = null;
  let cells = [];
  let speed = cfg.chart.replay_speed ?? 2;
  let unit = null;

  const status = h("span.rp-status");
  const playBtn = h("button.rp-play", { onclick: () => (playing ? pause() : play()), "data-tip-text": "재생 / 멈춤 (Space)" });
  // ⏭ 한 칸 = 보고 있는 봉 하나 (1시간봉이면 1시간). 전에는 1분봉이 있으면 1분씩이라 1시간봉에서 60번 눌러야 다음 봉이 나왔다 (사용자 2026-11-01, 0.14.1)
  const stepBtn = h("button", { onclick: () => (pause(), stepBar()), "data-tip-text": "봉 하나 앞으로 (→)\n지금 보는 봉만큼 (1시간봉이면 1시간, 5분봉이면 5분)\nShift+→ = 1분만" }, "⏭ 한 칸");
  const speedSeg = h("span.rp-speed");
  const randomBtn = h("button", { onclick: () => startRandom(), "data-tip-text": "받아 둔 기간 중 아무 때나에서 시작\n날짜를 모르고 연습하면 외운 차트가 아니라 실력으로 해요" }, "🎲 아무 때나");
  const repick = h("button", { onclick: () => start(), "data-tip-text": "시작할 곳을 차트에서 다시 고르기" }, "📍 시점 다시");
  const stopBtn = h("button", { onclick: () => requestStop(), "data-tip-text": "끝내고 지금으로 돌아가기 (Esc)" }, "✕ 끝내기");
  // 모의매매로 들고 있거나 대기선을 깔아 둔 채 끝내거나 새로 시작하면 먼저 묻는다 (main.js guardTrading, 0.13.0). true = 바로 해도 됨
  const mayEnd = (what, proceed) => !confirmEnd || confirmEnd(what, proceed); // 📡 실시간 판도 (리플레이를 시작하면 끝난다)
  function requestStop() {
    if (mayEnd("끝내면", () => stop())) stop();
  }
  root.replaceChildren(h("span.rp-title", { "data-tip": "replay" }, "▶ 리플레이"), status, playBtn, stepBtn, h("span.rp-label", "속도"), speedSeg, h("div.grow"), randomBtn, repick, stopBtn);

  function paint() {
    root.hidden = !picking && !active;
    playBtn.textContent = playing ? "⏸ 멈춤" : "▶ 재생";
    for (const b of [playBtn, stepBtn, repick]) b.disabled = !active;
    // 1분씩 흘러가면 "분/초", 아니면 "봉/초" (바뀔 때만 다시 그린다)
    const u = master?.replayMinutes ? "분" : "봉";
    if (u !== unit) {
      unit = u;
      speedSeg.replaceChildren(segment(SPEEDS.map((s) => [s, `${s}${u}/초`]), () => speed, (v) => setSpeed(v)));
    }
    if (picking) status.textContent = "차트에서 시작할 봉을 누르세요 → 그 뒤 봉은 가려져요";
    else if (active && master?.bars.length) {
      // 지금 시각 (일·주봉은 날짜, 분봉은 PC 시각)
      const WD = "일월화수목금토";
      if (["1D", "1W"].includes(master.tf)) {
        const t = master.bars[master.bars.length - 1].t;
        status.textContent = `지금: ${ymd(t)} (${WD[new Date(t * 1000).getUTCDay()]})`;
      } else {
        const d = new Date(endT * 1000);
        const p = (n) => String(n).padStart(2, "0");
        // 연도도 (사용자 요청 2026-11-01: 🎲로 옛날 구간에 가면 몇 년인지 몰랐다)
        status.textContent = `지금: ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} (${WD[d.getDay()]}) ${p(d.getHours())}:${p(d.getMinutes())}`;
      }
    }
    root.classList.toggle("picking", picking);
    gridBox.classList.toggle("rp-picking", picking);
    onChange?.();
  }

  function setSpeed(v) {
    speed = v;
    cfg.chart.replay_speed = v;
    cfg.save();
    if (playing) {
      pause();
      play();
    }
  }

  /** 시작: 시점 고르기 */
  function start(force = false) {
    if (!force && !mayEnd("새로 시작하면", () => start(true))) return;
    if (active) stopCells();
    picking = true;
    paint();
  }

  // 시점 고르기: 다음 한 번의 누름을 차트보다 먼저 가로챈다
  gridBox.addEventListener(
    "pointerdown",
    (e) => {
      if (!picking || e.button !== 0) return;
      const cellEl = e.target.closest(".cell");
      const body = cellEl?.querySelector(".cell-body");
      const cell = grid.cells.find((c) => c.root === cellEl);
      if (!cell || !body?.contains(e.target)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      const r = body.getBoundingClientRect();
      const t = cell.replayEndAt(e.clientX - r.left);
      if (t == null) return toast("이 칸에는 아직 봉이 없어요");
      begin(cell, t);
    },
    true
  );

  /** 🎲 받아 둔 기간 중 아무 시각에서 시작 */
  async function startRandom(cell = grid.current, force = false) {
    if (!cell?.cc.symbol) return toast("먼저 종목을 고르세요");
    if (!force && !mayEnd("새로 시작하면", () => startRandom(cell, true))) return;
    if (active) stopCells();
    picking = false;
    paint();
    const t = await randomTime(cell);
    if (t == null) return toast("받아 둔 봉이 너무 적어요\n💰 모의매매 창에서 '과거 1분봉 받기'를 눌러 주세요", 6000);
    const ok = await begin(cell, t, true);
    if (!ok) toast("그 시각의 봉을 읽지 못했어요 · 다시 눌러 주세요");
  }

  /** 받아 둔 기간 안의 아무 시각. 앞쪽 하루(보고 판단할 차트)와 뒤쪽 반나절(재생할 봉)은 남긴다.
   *  1분봉이 있으면 그 기간 안에서만 (체결을 1분봉으로 정확하게) */
  async function randomTime(cell) {
    const info = cell.info;
    const daily = isDailyTf(cell.tf);
    const base = daily ? "1D" : baseTf(info, cell.tf);
    if (!base) return null;
    const [a, m] = await Promise.all([db.range(info.id, base), daily ? null : db.range(info.id, "1m")]);
    if (!a) return null;
    let lo = a.first;
    let hi = a.last;
    if (m) {
      lo = Math.max(lo, m.first);
      hi = Math.min(hi, m.last);
    }
    lo += daily ? 200 * DAY : DAY;
    hi -= daily ? 30 * DAY : 12 * 3600;
    if (!(hi > lo)) return null;
    const unitSec = daily ? DAY : 60;
    return Math.floor((lo + Math.random() * (hi - lo)) / unitSec) * unitSec;
  }

  let beginSeq = 0;
  async function begin(cell, t, load = false) {
    picking = false;
    // 모의매매: 그 시각의 1분봉이 없으면 먼저 받아 온다 (차트를 뒤로 밀어 고른 옛날 구간. 1~2초)
    const my = ++beginSeq;
    // 분할 화면의 다른 칸도 늘 같은 시각까지 같이 간다 (0.8.1, 사용자 요청: 5분봉으로 매매하며 옆에 4시간봉·관련 종목).
    // 전에는 "줌·이동" 동기화를 켜야만 같이 가서, 꺼 두면 옆 칸에 지금 봉(= 미래)이 보였다
    const together = grid.cells.filter((c) => c === cell || c.cc.symbol);
    await onPrepare?.(cell, t, together);
    if (my !== beginSeq) return false; // 기다리는 사이에 다른 시작을 눌렀다
    master = cell;
    cells = together.filter((c) => grid.cells.includes(c));
    endT = t;
    let ok = true;
    for (const c of cells) {
      // 고른 칸 말고 같이 가는 칸은 그 시각이 아직 안 읽혀 있을 수 있다 → 저장소에서 읽어 시작
      if (load || c !== cell) {
        const r = await c.replayStartAt(endT);
        if (c === cell) ok = r; // 다른 칸이 못 읽어도(그 종목 봉이 그때 없음) 매매하는 칸은 시작한다
      } else c.replayStart(endT);
    }
    if (!master.replaying) {
      cells = [];
      master = null;
      paint();
      return false;
    }
    active = true;
    paint();
    onBegin?.(master, endT);
    return ok;
  }

  function step() {
    if (!active) return;
    const next = master.replayNextEnd(endT);
    if (next == null) {
      pause();
      toast("마지막 봉까지 왔어요 · ✕ 끝내기를 누르면 지금으로 돌아가요");
      return;
    }
    if (next <= endT) return; // 봉을 바꾸는 중·뒤를 읽는 중: 제자리
    const prev = endT;
    endT = next;
    for (const c of cells) c.replayTo(endT);
    paint();
    onStep?.(master, endT, prev);
  }

  /**
   * 봉 하나 앞으로: 매매하는 칸의 지금 봉이 끝나는 시각까지 1분씩 따라가되(1분봉 빈 곳에서는 거기서 멈춤 = 받는 중) 화면은 한 번만 그린다.
   * 체결은 모의매매가 그 사이 1분봉을 하나씩 다 본다 (onStep → panel.newBars)
   */
  function stepBar() {
    if (!active) return;
    const target = master.replayBarEnd(endT);
    if (target == null) return step(); // 마지막 봉 → step이 "끝"을 알린다
    let t = endT;
    for (let k = 0; k < 20000 && t < target; k++) {
      const nx = master.replayNextEnd(t);
      if (nx == null || nx <= t) break; // 끝 · 봉을 바꾸는 중 · 1분봉을 받는 중 → 거기까지만
      t = nx;
    }
    if (t <= endT) return;
    const prev = endT;
    endT = t;
    for (const c of cells) c.replayTo(endT);
    paint();
    onStep?.(master, endT, prev);
  }

  function play() {
    if (!active) return;
    playing = true;
    clearInterval(timer);
    timer = setInterval(step, 1000 / speed);
    paint();
  }

  function pause() {
    playing = false;
    clearInterval(timer);
    timer = null;
    paint();
  }

  function stopCells() {
    pause();
    if (active) onStop?.(master, endT);
    for (const c of cells) if (grid.cells.includes(c)) c.replayStop();
    cells = [];
    active = false;
    master = null;
  }

  function stop() {
    stopCells();
    picking = false;
    paint();
  }

  paint();
  return {
    start,
    startRandom,
    stop,
    requestStop,
    step,
    stepBar,
    pause,
    toggle: () => (playing ? pause() : play()),
    refresh: () => paint(),
    get active() {
      return active || picking;
    },
    /** 재생이 실제로 돌고 있는 중 (시점 고르는 중은 아님) */
    get running() {
      return active;
    },
    get playing() {
      return playing;
    },
    get master() {
      return master;
    },
    get endT() {
      return endT;
    },
    /** 분할을 바꿔서 칸이 새로 만들어졌으면 끝낸다 */
    checkCells() {
      if (!active) return;
      // 칸을 줄여 같이 가던 칸만 없어졌으면 그 칸만 뺀다. 매매하는 칸이 없어졌을 때만 끝 (0.13.0: 전에는 칸 수만 바꿔도 끝났다)
      if (!grid.cells.includes(master)) return stop();
      cells = cells.filter((c) => grid.cells.includes(c));
    },
    /** 칸을 늘려 새로 생긴 칸 → 지금 리플레이 시각으로 같이 간다 (grid.resize, 0.13.0). 붙였으면 true */
    join(cell) {
      if (!active || !cell.cc.symbol) return false;
      cells.push(cell);
      cell.joinReplay(endT);
      return true;
    },
    /** 리플레이 중 모의매매를 하는 칸 */
    get master() {
      return active ? master : null;
    },
    /** 같이 가는 칸인가 (매매하는 칸 말고) → 종목을 바꿔도 같은 시각에서 이어 간다 (cell.load) */
    follows(cell) {
      return active && cell !== master && cells.includes(cell);
    },
    /** 칸이 종목을 바꿔서 리플레이가 풀렸다 → 같이 재생하던 것도 끝낸다 */
    onCellReset(cell) {
      if (active && cells.includes(cell)) {
        cells = cells.filter((c) => c !== cell);
        if (cell === master) stop();
      }
    },
  };
}
