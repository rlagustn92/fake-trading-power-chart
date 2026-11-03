// 하단 상태줄 (SPEC §3.1): 기간 버튼 · 받는 중인 작업 · 마지막 갱신 · 연결 상태 · 🔄 지금 업데이트
import { h } from "./dom.js";
import { clock, setText } from "./format.js";
import { onSourceStatus } from "../sources/status.js";
import { tzOffset } from "../core/tz.js";

import { econWeek, macroOutlook, forceEconRefresh } from "../core/events.js";

const pad = (n) => String(n).padStart(2, "0");
const hm = (sec) => {
  const d = Math.floor(sec / 86400);
  const rest = sec - d * 86400;
  return `${d ? `${d}일 ` : ""}${Math.floor(rest / 3600)}:${pad(Math.floor((rest % 3600) / 60))}`;
};
const WD = ["일", "월", "화", "수", "목", "금", "토"];

/** 뉴욕 현지 {wd, sec} */
function nyNow(t = Date.now() / 1000) {
  const l = t + tzOffset("America/New_York", t);
  const day = Math.floor(l / 86400);
  return { wd: (day + 4) % 7, sec: l - day * 86400 };
}

/** 미국 정규장(09:30~16:00 뉴욕) 기준 "마감까지 / 개장까지" (휴장일은 모름 → 평일로만) */
export function usMarketText(t = Date.now() / 1000) {
  const { wd, sec } = nyNow(t);
  const open = 9.5 * 3600;
  const close = 16 * 3600;
  if (wd >= 1 && wd <= 5 && sec >= open && sec < close) return `미국 정규장 · 마감까지 ${hm(close - sec)}`;
  let wait = sec < open && wd >= 1 && wd <= 5 ? open - sec : 86400 - sec + open;
  let d = sec < open && wd >= 1 && wd <= 5 ? wd : (wd + 1) % 7;
  while (d === 0 || d === 6) {
    wait += 86400;
    d = (d + 1) % 7;
  }
  return `미국 개장까지 ${hm(wait)}`;
}

const DAILY = [["1M", "1M"], ["3M", "3M"], ["6M", "6M"], ["YTD", "YTD"], ["1Y", "1Y"], ["3Y", "3Y"], ["5Y", "5Y"], ["10Y", "10Y"], ["all", "전체"]];
const INTRA = [["1D", "1일"], ["5D", "5일"], ["1M", "1M"], ["3M", "3M"]];

export function createStatusbar(root, { data, onRange, onRefresh }) {
  const ranges = h("div.sb-ranges");
  const jobs = h("span.st-jobs");
  const last = h("span.st-last");
  const sources = h("span.st-sources");
  const offline = h("span.st-offline", { hidden: true }, "오프라인 · 저장된 데이터로 보여주는 중");
  const refresh = h(
    "button.st-refresh",
    {
      onclick: () => {
        onRefresh();
        forceEconRefresh(); // FOMC·CPI 자료도 (받은 지 1시간 넘었으면)
        paintNext();
      },
      "data-tip-text": "지금 업데이트\n빠진 부분만 이어서 받아요 (켤 때도 자동으로 해요)\nFOMC·CPI 자료도 새로 받아요",
    },
    "🔄"
  );
  const clockEl = h("span.st-clock");
  const fomcEl = h("span.st-macro.fomc");
  const cpiEl = h("span.st-macro.cpi");
  const nextEl = h("span.st-next");
  root.replaceChildren(ranges, clockEl, fomcEl, cpiEl, nextEl, h("span.st-grow"), offline, jobs, last, sources, refresh);

  // 좁으면 덜 중요한 것부터 줄인다 (받는 중 글자는 늘 줄어들 수 있음):
  // 1 = "📅 다른 지표" 숨김 → 2 = 시계 짧게 → 3 = "마지막 갱신" 숨김 → 4 = FOMC·CPI 시각 빼기 → 5 = 시계 숨김
  let level = 0;

  // 시계: 뉴욕·한국 시각 + 미국 정규장 마감/개장까지 (서머타임 바뀌는 주에 헷갈리지 않게)
  const tickClock = () => {
    const now = new Date();
    const ny = nyNow();
    const nyT = `${pad(Math.floor(ny.sec / 3600))}:${pad(Math.floor((ny.sec % 3600) / 60))}`;
    setText(clockEl, level >= 2 ? `🕘 뉴욕 ${nyT} · ${usMarketText().replace("미국 ", "")}` : `🕘 뉴욕 ${nyT} · 한국 ${pad(now.getHours())}:${pad(now.getMinutes())} · ${usMarketText()}`);
  };
  // 넘치거나, 받는 중 글자가 너무 짧게 잘리면 "좁다"
  const cut = () => root.scrollWidth > root.clientWidth + 1 || (!!jobs.textContent && jobs.clientWidth < Math.min(jobs.scrollWidth, 150));
  let macro = { F: null, C: null };
  const apply = () => {
    nextEl.hidden = level >= 1 || !nextEl.textContent;
    last.hidden = level >= 3;
    clockEl.hidden = level >= 5;
    tickClock();
    paintMacro();
  };
  function fit() {
    level = 0;
    apply();
    while (level < 5 && cut()) {
      level++;
      apply();
    }
  }
  let lastW = 0;
  new ResizeObserver(() => {
    if (root.clientWidth === lastW) return;
    lastW = root.clientWidth;
    fit();
  }).observe(root);
  tickClock();
  setInterval(tickClock, 20e3);

  // 이번 주 미국 주요 지표·FOMC 중 다음 것 (마우스를 올리면 이번 주 전체)
  const fmt = (t) => {
    const d = new Date(t * 1000);
    return `${d.getMonth() + 1}-${pad(d.getDate())}(${WD[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const md = (s) => (s ? `${+s.slice(5, 7)}-${s.slice(8, 10)}` : "");
  const p1 = (v) => `${v.toFixed(1)}%`;
  // 🏦 FOMC 10-29(목) 03:00 (예상 동결, 직전 인상) · 📈 CPI 11-10(화) 22:30 (예상 3.8%, 직전 3.7%) — 좁으면 시각을 뺀다
  function paintMacro() {
    const { F, C } = macro;
    const when = (t) => (level >= 4 ? fmt(t).slice(0, -6) : fmt(t));
    const fIn = F ? [F.expect && `예상 ${F.expect}`, F.last && `직전 ${F.last.text}`].filter(Boolean).join(", ") : "";
    setText(fomcEl, F ? `🏦 FOMC ${when(F.t)}${fIn ? ` (${fIn})` : ""}` : "");
    const cIn = C ? [C.expect != null && `예상 ${p1(C.expect)}`, C.prev != null && `직전 ${p1(C.prev)}`].filter(Boolean).join(", ") : "";
    setText(cpiEl, C ? `📈 CPI ${C.t ? when(C.t) : C.approx}${cIn ? ` (${cIn})` : ""}` : "");
  }
  const paintNext = async () => {
    const now = Date.now() / 1000;
    const [list, out] = await Promise.all([econWeek(), macroOutlook().catch(() => ({}))]);
    const week = list.length ? `\n\n이번 주 미국 주요 일정 (한국 시각)\n${list.map((e) => `${fmt(e.t)} ${e.ko}${e.forecast ? ` · 예상 ${e.forecast}` : ""}${e.previous ? ` · 이전 ${e.previous}` : ""}`).join("\n")}\n발표 30분 전에 알려 드려요 (⚙ 설정 → 차트 → 주요 지표 알림)` : "";

    // 🏦 다음 FOMC (예상 동결, 직전 인상)
    const F = out.fomc;
    const C = out.cpi;
    macro = { F, C };
    fomcEl.dataset.tipText = F
      ? [
          `다음 FOMC 금리 결정: 한국 시각 ${fmt(F.t)} (뉴욕 ${md(F.meeting)} 14:00)`,
          F.expect ? `예상: ${F.expect} — ${F.expectFrom}` : "예상: 아직 몰라요 (금리 선물을 못 받았어요)",
          F.alt ? `같이 보기: ${F.alt}` : "",
          F.last ? `직전(${md(F.lastMeeting)}): ${F.last.text} · 목표 금리 상단 ${F.last.from.toFixed(2)}% → ${F.last.to.toFixed(2)}%` : F.lastMeeting ? `직전(${md(F.lastMeeting)}): 결과 집계 중` : "",
          F.upper != null ? `지금 기준금리: ${F.lower != null ? `${F.lower.toFixed(2)}~` : ""}${F.upper.toFixed(2)}% · 실제 시장 금리(실효) ${F.effr?.toFixed(2) ?? "—"}%` : "",
          "자료: 뉴욕 연준(금리) · 연준 홈페이지(회의 날짜, 자동) · Yahoo 금리 선물 · ForexFactory",
          "켤 때 · 🔄 누를 때 · 발표 직후에만 새로 받아요",
        ].filter(Boolean).join("\n") + week
      : "";

    // 📈 다음 CPI (예상 3.8%, 직전 3.6%) — 전년 같은 달 대비
    cpiEl.dataset.tipText = C
      ? [
          C.t ? `다음 미국 CPI 물가 발표: 한국 시각 ${fmt(C.t)} (${C.refM}월 치)` : `다음 미국 CPI 물가 발표: ${C.approx}쯤 (${C.refM}월 치)\n노동통계국이 날짜를 아직 안 냈어요. 발표하는 주가 되면 정확한 날짜·시각이 자동으로 나와요`,
          "숫자는 작년 같은 달보다 물가가 몇 % 올랐는지예요",
          C.expect != null ? `예상: ${p1(C.expect)}${C.expectCore != null ? ` · 근원(식품·에너지 뺀) ${p1(C.expectCore)}` : ""} — ${C.expectFrom}` : "예상: 아직 몰라요",
          C.alt ? `같이 보기: ${C.alt}` : "",
          C.prev != null ? `직전${C.prevM ? `(${C.prevM}월)` : ""}: ${p1(C.prev)}${C.prevCore != null ? ` · 근원 ${p1(C.prevCore)}` : ""}` : "",
          "시장 예상(컨센서스)은 발표하는 주에 나와요. 그 전에는 클리블랜드 연준 예측을 보여 줘요",
          C.needYear ? `📝 ${C.needYear}년 CPI 발표 날짜를 아직 안 넣었어요 (해마다 한 번)\n프로그램 폴더 MAINTENANCE.md의 "CPI 발표 날짜 넣기" — AI에게 "MAINTENANCE.md 보고 ${C.needYear}년 CPI 날짜 넣어줘"` : "",
          "자료: 클리블랜드 연준(실제 값·예측) · ForexFactory",
          "켤 때 · 🔄 누를 때 · 발표 직후에만 새로 받아요",
        ].filter(Boolean).join("\n") + week
      : "";

    // 📅 그 밖의 다음 주요 지표 (FOMC·CPI가 아닌 것, 이번 주만)
    const next = list.find((e) => e.t > now - 1800 && !/FOMC|CPI/.test(e.ko));
    setText(nextEl, next ? `📅 ${fmt(next.t)} ${next.ko}` : "");
    nextEl.dataset.tipText = week.trim();
    fit();
  };
  paintNext();
  setInterval(paintNext, 10 * 60e3);

  let daily = true;
  let cur = null;
  function setMode(isDaily, current) {
    daily = isDaily;
    cur = current ?? null;
    const list = daily ? DAILY : INTRA;
    ranges.replaceChildren(...list.map(([k, label]) => h(`button.rg${k === cur ? ".on" : ""}`, { onclick: () => (onRange(k), setMode(daily, k)) }, label)));
    fit(); // 일봉(9개)·분봉(4개) 버튼 수가 달라 폭이 바뀐다
  }

  data.on("jobs", (list) => {
    const had = !!jobs.textContent;
    setText(jobs, list.length ? `${list[list.length - 1]}${list.length > 1 ? ` 외 ${list.length - 1}개` : ""}` : "");
    if (had !== !!jobs.textContent) fit(); // 받는 중 글자가 생기거나 없어질 때만 다시 맞춘다
    refresh.classList.toggle("spin", list.length > 0);
  });
  data.on("updated", (t) => {
    const first = !last.textContent;
    setText(last, `마지막 갱신 ${clock(t)}`);
    if (first) fit();
  });

  const dots = {};
  onSourceStatus((name, ok) => {
    let s = dots[name];
    if (!s) {
      s = dots[name] = h("span.src", name);
      sources.append(s);
      fit();
    }
    s.className = `src ${ok ? "ok" : "bad"}`;
  });

  const net = () => {
    offline.hidden = navigator.onLine;
    fit();
  };
  addEventListener("online", net);
  addEventListener("offline", net);
  net();

  return { setMode };
}
