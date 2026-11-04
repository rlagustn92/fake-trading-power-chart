// 📒 매매 일지 (기획서 §4-4, 사용자가 고른 시안 A + C, 2026-10-30)
// - 오른쪽 💰 창: 숫자 칸 4개 + 최근 거래 두 줄 카드 (tradeRow, statTiles를 panel.js가 쓴다)
// - 큰 일지 창(차트 위): 누적 손익 곡선 + 표 + 걸러 보기(종목·방향·연습 판). 줄을 누르면 그 시점 차트로 (복기)
// 색: 손익만 빨강(이익)·파랑(손실) — 차트 봉 색과 같게. 방향은 색 없이 ▲ ▼
// 메모(왜 들어갔나·배운 것)는 줄의 ✎로 고치고, 📄 CSV 저장 = 문서\FAKE TRADING POWER CHART\ (엑셀에서 바로 열림)
import { h, segment } from "../ui/dom.js";
import { ask } from "../ui/dialog.js";
import { num, signed, duration } from "../ui/format.js";
import { ymd } from "../core/tz.js";
import { invoke } from "../platform.js";
import * as E from "./engine.js";
import { upColor, downColor } from "../core/colors.js";

/** 결과 딱지: 짧은 이름 + 색 이름 */
export const RESULT = { tp: ["익절", "tp"], sl: ["손절", "sl"], liq: ["청산", "liq"], close: ["종료", "ex"], end: ["끝냄", "ex"], live: ["실시간 끝", "ex"] };
const OLD = "old"; // 판 표시가 없는 예전 기록

export const usd = (n) => `${n >= 0 ? "+" : "−"}$${num(Math.abs(n), 2)}`;
const cls = (n) => (n > 0 ? "up" : n < 0 ? "down" : "flat");
const levText = (v) => `${Number((v ?? 1).toFixed(2))}배`; // 소수점 두 자리까지 (3.75배, 10배)
const short = (tr) => String(tr.label ?? tr.sym ?? "").replace(/ 24h$/, "");
const daily = (tr) => tr.tf === "1D" || tr.tf === "1W";
/** 익절로 끝났는데 수수료 때문에 손해 (분할 매수로 평단이 익절선에 붙었을 때 생긴다) */
export const tpLoss = (tr) => tr.why === "tp" && tr.net < 0;

/** 리플레이 속 시각 (PC 시각, 연도까지. 일·주봉은 날짜만) */
export function whenText(tr, t = tr.t1) {
  if (daily(tr)) return ymd(t);
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 연습 판 목록 (새것부터): [{id, label, n, net, t}] — 🎲 시작 한 번 = 한 판 */
export function sessionsOf(trades) {
  const m = new Map();
  for (const tr of trades) {
    const id = tr.ses ?? OLD;
    let s = m.get(id);
    if (!s) m.set(id, (s = { id, label: id === OLD ? "예전 기록" : tr.sesLabel ?? "연습", n: 0, net: 0, at: tr.at ?? 0 }));
    s.n++;
    s.net += tr.net;
  }
  return [...m.values()];
}

/** 걸러 보기: {sym, side(1|-1|0), ses} */
export function filterTrades(trades, { sym = "", side = 0, ses = "" } = {}) {
  return trades.filter((tr) => (!sym || tr.sym === sym) && (!side || tr.side === side) && (!ses || String(tr.ses ?? OLD) === String(ses)));
}

/** 누적 손익 (매매한 차례대로 — 리플레이 속 날짜는 판마다 뒤섞이므로). trades는 새것부터 → [0, …, 합계] */
export function curve(trades) {
  const out = [0];
  for (let i = trades.length - 1; i >= 0; i--) out.push(out[out.length - 1] + trades[i].net);
  return out;
}

/** 거래 기록 → CSV 글자 (첫 줄 한글 머리, 엑셀용. 쉼표·따옴표·줄바꿈이 든 칸은 따옴표로 감싼다) */
export function toCsv(trades) {
  const q = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const r2 = (v) => (v == null || !Number.isFinite(v) ? "" : Math.round(v * 100) / 100);
  const r4 = (v) => (v == null || !Number.isFinite(v) ? "" : Math.round(v * 1e4) / 1e4); // 가격 (분할 매수 평단은 소수가 길다)
  const head = ["들어간 시각", "나온 시각", "종목", "봉", "방향", "배율", "수량", "평단", "나간 가격", "결과", "들고 있은 분", "손익($)", "수수료($)", "증거금 대비(%)", "포지션 대비(%)", "가장 유리(%)", "가장 불리(%)", "손익비", "추가 횟수", "나눠 정리", "연습 판", "메모"];
  const rows = trades.map((tr) => [
    whenText(tr, tr.t0),
    whenText(tr, tr.t1),
    short(tr),
    tr.tf ?? "",
    tr.side > 0 ? "롱" : "숏",
    r2(tr.lev ?? 1),
    Math.round(tr.qty * 1000) / 1000, // 예전 기록의 0.10200000000000001 같은 찌꺼기 (0.16.0)
    r4(tr.entry),
    r4(tr.exit),
    (RESULT[tr.why] ?? [tr.why])[0],
    Math.round((tr.t1 - tr.t0) / 60),
    r2(tr.net),
    r2(tr.fees),
    r2(tr.roe),
    r2(tr.pct),
    r2(tr.mfe),
    r2(tr.mae),
    r2(tr.rr),
    tr.adds ?? 0,
    tr.parts ?? 1,
    tr.sesLabel ?? "",
    tr.memo ?? "",
  ]);
  return [head, ...rows].map((r) => r.map(q).join(",")).join("\r\n");
}

/** 숫자 칸 4개: 거래 · 승률 · 합계 손익 · 평균 이익 ÷ 손실 */
export function statTiles(trades) {
  const st = E.stats(trades);
  const tile = (label, value, c = "", tip = "") => h("div.jr-tile", tip ? { "data-tip-text": tip } : null, h("span.jr-lab", label), h(`b.jr-big${c ? `.${c}` : ""}`, value));
  return h(
    "div.jr-tiles",
    tile("거래", `${st.n}번`),
    tile("승률", st.n ? `${Math.round(st.winRate * 100)}%` : "—", "", "이긴 거래 ÷ 전체 (수수료 뺀 손익이 0보다 크면 이김)"),
    tile("합계 손익", st.n ? usd(st.net) : "—", cls(st.net)),
    tile("평균 이익 ÷ 손실", st.payoff ? st.payoff.toFixed(2) : "—", "", "이긴 거래의 평균 이익 ÷ 진 거래의 평균 손실\n1보다 크면 이길 때 더 크게 벌어요")
  );
}

/** 오른쪽 창의 두 줄 카드: 윗줄 = 방향·종목·결과·손익, 아랫줄 = 가격·들고 있은 시간·날짜 */
export function tradeRow(tr, { onclick } = {}) {
  const [rname, rcls] = RESULT[tr.why] ?? [tr.why, "ex"];
  const d = tr.d ?? 2;
  const extra = [tr.adds ? `추가 ${tr.adds}번` : "", (tr.parts ?? 1) > 1 ? `나눠 정리 ${tr.parts}번` : ""].filter(Boolean).join(" · ");
  return h(
    "div.jr-row",
    { onclick, "data-tip-text": "누르면 그 시점 차트로 가서 다시 봐요 (복기)" },
    h(
      "div.jr-top",
      h("span.jr-side", `${tr.side > 0 ? "▲ 롱" : "▼ 숏"} ${levText(tr.lev)}`),
      h("b.jr-sym", short(tr)),
      h(`span.jr-pill.${rcls}`, rname),
      h(`b.jr-pnl.${cls(tr.net)}`, usd(tr.net))
    ),
    h(
      "div.jr-sub",
      `${num(tr.entry, d)} → ${num(tr.exit, d)} · ${duration(Math.max(0, tr.t1 - tr.t0))} · ${whenText(tr, tr.t0)}${extra ? ` · ${extra}` : ""}`,
      tpLoss(tr) ? h("span.jr-warn", " · 익절인데 수수료로 손해") : null
    ),
    tr.memo ? h("div.jr-memo", `📝 ${tr.memo}`) : null
  );
}

/** 큰 일지 창 (차트 위). onReview(tr) = 그 시점으로 가서 다시 보기, onChange() = 메모를 고쳤다 (저장) */
export function createJournal(root, { getTrades, onReview, onChange, toast }) {
  let f = { sym: "", side: 0, ses: "" };
  root.addEventListener("pointerdown", (e) => e.target === root && close());
  const body = h("div.jr-body");
  root.replaceChildren(body);

  function render() {
    const all = getTrades();
    const list = filterTrades(all, f);
    const st = E.stats(list);
    const syms = [...new Map(all.map((tr) => [tr.sym, short(tr)])).entries()];
    const sessions = sessionsOf(all);
    const sel = (opts, val, set) => {
      const s = h("select.set-sel.jr-sel", { onchange: () => set(s.value) });
      for (const [v, label] of opts) s.append(h("option", { value: v }, label));
      s.value = String(val);
      return s;
    };
    body.replaceChildren(
      h(
        "div.panel.jr-panel",
        h(
          "div.pick-head",
          h("h2", "📒 매매 일지"),
          h(
            "div.row",
            { style: "margin:0" },
            h("button", { onclick: () => saveCsv(list), disabled: !list.length, "data-tip-text": "지금 보이는 거래를 CSV로 저장 (엑셀에서 바로 열려요)\n문서\\FAKE TRADING POWER CHART 폴더" }, "📄 CSV 저장"),
            h("button", { onclick: () => close() }, "닫기")
          )
        ),
        h(
          "div.jr-filters",
          sel([["", "모든 종목"], ...syms], f.sym, (v) => ((f.sym = v), render())),
          segment([[0, "롱·숏"], [1, "롱만"], [-1, "숏만"]], () => f.side, (v) => ((f.side = v), render())),
          sel([["", "모든 연습 판"], ...sessions.map((s) => [String(s.id), `${s.label} · ${s.n}번 · ${usd(s.net)}`])], f.ses, (v) => ((f.ses = v), render()))
        ),
        h(
          "div.jr-summary",
          statTiles(list),
          h("div.jr-more", `가장 크게 잃은 구간 ${st.n ? usd(st.maxDD) : "—"} · 평균 이익 ${st.wins ? usd(st.avgWin) : "—"} · 평균 손실 ${st.n - st.wins ? usd(st.avgLoss) : "—"}`)
        ),
        curveEl(list),
        list.length
          ? h(
              "div.jr-table",
              h("div.jr-tr.jr-th", ...["리플레이 속 날짜", "종목", "방향", "들어감 → 나옴", "결과", "들고 있은 시간", "손익", "증거금 대비", "메모"].map((x) => h("span", x))),
              ...list.slice(0, 1000).map((tr) => {
                const [rname, rcls] = RESULT[tr.why] ?? [tr.why, "ex"];
                const d = tr.d ?? 2;
                return h(
                  "div.jr-tr",
                  { onclick: () => onReview?.(tr), "data-tip-text": "누르면 그 시점 차트로 가서 다시 봐요 (복기)" },
                  h("span", whenText(tr, tr.t0)),
                  h("b", short(tr)),
                  h("span.jr-side", `${tr.side > 0 ? "▲ 롱" : "▼ 숏"} ${levText(tr.lev)}`),
                  h("span", `${num(tr.entry, d)} → ${num(tr.exit, d)}`),
                  h("span", h(`span.jr-pill.${rcls}`, rname), tpLoss(tr) ? h("span.jr-warn", { "data-tip-text": "익절선에 닿았지만 수수료가 더 커서 손해였어요\n분할 매수로 평단이 익절선에 가까워졌을 때 생겨요" }, " ⚠") : null),
                  h("span", duration(Math.max(0, tr.t1 - tr.t0))),
                  h(`b.jr-num.${cls(tr.net)}`, usd(tr.net)),
                  h(`span.jr-num.${cls(tr.net)}`, tr.roe != null ? `${signed(tr.roe, 1)}%` : `${signed(tr.pct, 2)}%`),
                  h(
                    "span.jr-memo-cell",
                    h("button.jr-edit", { onclick: (e) => (e.stopPropagation(), editMemo(tr)), "data-tip-text": "메모 쓰기·고치기\n왜 들어갔나, 무엇을 배웠나" }, "✎"),
                    h("span.jr-memo-text", tr.memo ?? "")
                  )
                );
              })
            )
          : h("p.hint", "이 조건에 맞는 거래가 없어요"),
        h("p.hint", "날짜는 리플레이 속 시각(PC 시각)이에요. 곡선은 매매한 차례대로 손익을 더한 것. 줄을 누르면 그 종목·봉으로 가서 들어간 곳(화살표)과 나온 곳(점)을 보여 줘요.")
      )
    );
  }

  /** 누적 손익 곡선 (숫자만 쓰는 SVG) */
  function curveEl(list) {
    const pts = curve(list);
    const W = 1000;
    const H = 140;
    const lo = Math.min(0, ...pts);
    const hi = Math.max(0, ...pts);
    const span = hi - lo || 1;
    const x = (i) => (pts.length > 1 ? (i / (pts.length - 1)) * W : 0);
    const y = (v) => 10 + (1 - (v - lo) / span) * (H - 20);
    const last = pts[pts.length - 1];
    const color = last > 0 ? upColor() : last < 0 ? downColor() : "#a0a6ae"; // 한국식·미국식 (core/colors.js)
    const box = h("div.jr-curve");
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="누적 손익 곡선">
<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="#3a414b" stroke-dasharray="6 6" vector-effect="non-scaling-stroke"/>
<polyline fill="none" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke" points="${pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/></svg>`;
    box.append(h("span.jr-cl.top", hi > 0 ? usd(hi) : "$0"), h("span.jr-cl.bot", lo < 0 ? usd(lo) : "$0"), h("span.jr-cl.end", { style: `color:${color}` }, `지금 ${usd(last)}`));
    return box;
  }

  async function editMemo(tr) {
    const v = await ask(`메모 · ${short(tr)} ${tr.side > 0 ? "롱" : "숏"} ${whenText(tr, tr.t0)}`, { value: tr.memo ?? "", placeholder: "예: VWAP 지지 확인하고 들어감 · 손절이 너무 짧았다", ok: "저장" });
    if (v == null) return; // 취소 (빈칸으로 저장하면 null이 와서 지우지 않는다 → 지우려면 공백 하나)
    tr.memo = v.trim() || undefined;
    onChange?.();
    render();
  }

  async function saveCsv(list) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const name = `trades_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.csv`;
    try {
      const path = await invoke("save_export", { name, text: toCsv(list) });
      toast?.(`📄 거래 ${list.length}개를 저장했어요\n${path}`, 7000, { label: "폴더 열기", onclick: () => invoke("open_folder", { which: "exports" }).catch(() => {}) });
    } catch (e) {
      toast?.(`저장하지 못했어요 (${e?.message ?? e})`, 6000);
    }
  }

  function open(filter = {}) {
    f = { sym: "", side: 0, ses: "", ...filter };
    render();
    root.hidden = false;
  }
  function close() {
    root.hidden = true;
  }

  return {
    open,
    close,
    render: () => !root.hidden && render(),
    get isOpen() {
      return !root.hidden;
    },
  };
}
