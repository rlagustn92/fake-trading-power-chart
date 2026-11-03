// 📅 날짜로 가기: 선택한 칸(또는 보이는 칸 모두 / Ctrl+클릭으로 고른 칸)을 그 날짜·시각으로 한 번에.
// 봉도 같이 바꿀 수 있다 (예: 2024-08-05를 5분봉으로).
import { h, segment } from "./dom.js";
import { TIMEFRAMES } from "../core/bars.js";
import { TF_NAME } from "../core/data.js";

let last = { date: "", time: "", tf: "", scope: "one", zone: "local" }; // 지난번에 친 값 (다시 열면 그대로)
const p2 = (x) => String(x).padStart(2, "0");
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};

export function openGoto({ grid, toast }) {
  const n = grid.cells.length;
  const np = grid.picked;
  if (last.scope === "picked" && !np) last.scope = "one";
  if (last.scope === "all" && n < 2) last.scope = "one";
  const date = h("input.bt-date", { type: "date", value: last.date, max: localToday() }); // PC 날짜 기준 (UTC로 하면 오전 9시 전에 오늘을 못 고름)
  const time = h("input.bt-date", { type: "time", value: last.time, style: "width:150px" });
  const zoneSeg = segment([["local", "한국 시각"], ["ny", "뉴욕 시각"]], () => last.zone, (v) => (last.zone = v));
  const tfSeg = segment([["", "지금 그대로"], ...TIMEFRAMES.map((t) => [t, TF_NAME[t]])], () => last.tf, (v) => (last.tf = v));
  const scopes = [["one", "이 칸만"], ...(n > 1 ? [["all", `보이는 칸 모두 (${n}칸)`]] : []), ...(np ? [["picked", `고른 칸 (${np + 1}칸)`]] : [])];
  const scopeSeg = segment(scopes, () => last.scope, (v) => (last.scope = v));
  const out = h("p.hint");

  const go = async () => {
    if (!date.value) return (out.textContent = "날짜를 골라 주세요");
    last = { ...last, date: date.value, time: time.value };
    wrap.remove();
    const r = await grid.goToDate(last.scope, date.value, time.value, last.tf || null, last.zone);
    const when = `${date.value}${time.value ? ` ${time.value}` : ""}`;
    toast(r.early ? `${when}: 그 날짜 데이터가 없는 칸은 가장 오래된 날로 갔어요 (1분봉은 최근 12개월)` : `${when}(으)로 갔어요 · 주황 화살표가 그 봉이에요`, 5000);
  };
  const row = (label, ...c) => h("div.bt-row", h("span.bt-label", label), h("div.bt-ctrl", ...c));
  const wrap = h(
    "div.overlay.dialog",
    { onpointerdown: (e) => e.target === wrap && wrap.remove() },
    h(
      "div.panel.center.goto",
      h("h2", "📅 날짜로 가기"),
      row("날짜", date),
      row("시각 (안 쓰면 그날 장 시작)", time, zoneSeg, h("span.hint", "분봉에서만 · 뉴욕 시각이면 서머타임도 알아서")),
      row("봉", tfSeg),
      row("어느 칸", scopeSeg, n > 1 && !np ? h("span.hint", "Ctrl+클릭으로 칸을 고르면 '고른 칸'이 생겨요") : null),
      out,
      h("div.row", h("button.primary", { onclick: go }, "가기"), h("button", { onclick: () => wrap.remove() }, "닫기"))
    )
  );
  wrap.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") go();
    if (e.key === "Escape") wrap.remove();
  });
  document.body.append(wrap);
  date.focus();
}
