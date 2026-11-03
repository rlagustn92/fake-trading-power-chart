// 🔔 알림 목록·만들기 (SPEC §3.6)
// - 선이나 지표를 오른쪽 클릭 → 알림 만들기, 또는 여기서 ＋
// - 켜고 끄기·지우기, 최근 울린 알림
import { h, segment, toggle } from "./dom.js";
import { describe } from "../core/symbols.js";
import { TF_NAME } from "../core/data.js";
import { TIMEFRAMES } from "../core/bars.js";
import { SENTIMENT } from "../indicators/sentiment.js";
import { alertText } from "../alerts/engine.js";
import { clock } from "./format.js";
import { toast } from "./dialog.js";

const CONDS = [
  ["price_up", "가격이 이 값 위로 올라가면"],
  ["price_down", "가격이 이 값 아래로 내려가면"],
  ["ind_up", "가격이 지표 선을 위로 뚫으면"],
  ["ind_down", "가격이 지표 선을 아래로 뚫으면"],
  ["rsi_down", "RSI가 이 값 아래로 내려가면"],
  ["rsi_up", "RSI가 이 값 위로 올라가면"],
  ["pct_up", "전일 종가보다 이 % 넘게 오르면"],
  ["pct_down", "전일 종가보다 이 % 넘게 내리면"],
  ["vwapdist_up", "VWAP보다 이 % 넘게 위로 벌어지면 (분봉)"],
  ["vwapdist_down", "VWAP보다 이 % 넘게 아래로 벌어지면 (분봉)"],
  ["dayhigh_up", "당일 신고가를 새로 쓰면 (분봉)"],
  ["daylow_down", "당일 신저가를 새로 쓰면 (분봉)"],
  ["stage", "심리 지표가 이 단계에 들어가면"],
];

export function createAlertPanel(root, { cfg, alerts, getCell, pickSymbol }) {
  let form = null; // 만드는 중인 알림
  let focus = null;
  root.addEventListener("pointerdown", (e) => e.target === root && close());
  const body = h("div.set-body");
  root.replaceChildren(
    h(
      "div.panel.settings.alerts",
      h("div.pick-head", h("h2", "🔔 알림"), h("div.row", { style: "margin:0" }, h("button.primary", { onclick: () => newForm() }, "＋ 새 알림"), h("button", { onclick: () => close() }, "닫기"))),
      body
    )
  );

  function newForm(preset = {}) {
    const c = getCell();
    const sym = preset.sym ?? c?.cc.symbol ?? cfg.watchlist[0];
    const last = c?.bars?.[c.bars.length - 1]?.c;
    form = { sym, tf: preset.tf ?? c?.tf ?? "1D", cond: SENTIMENT[sym] ? "stage" : "price_up", value: last ? +last.toPrecision(5) : 0, ind: { id: "sma", params: { length: 20 } }, rsi: 30, stage: SENTIMENT[sym]?.stages.at(-1).name, live: false, once: true, ...preset };
    render();
  }

  function create() {
    const f = form;
    const [kind, op] = f.cond.split("_");
    const a = { sym: f.sym, tf: f.tf, kind, op: op ?? "cross", live: f.live, once: f.once };
    if (kind === "price") a.value = +f.value;
    if (kind === "ind") a.ind = structuredClone(f.ind);
    if (kind === "rsi") Object.assign(a, { value: +f.rsi, ind: { id: "rsi", length: Math.max(2, Math.round(+f.rsiLen || 14)) } });
    if (kind === "stage") a.stage = f.stage;
    if (kind === "pct" || kind === "vwapdist") a.value = Math.abs(+f.pct || 0);
    if ((kind === "pct" || kind === "vwapdist") && !(a.value > 0)) return toast("%를 확인해 주세요");
    if ((kind === "vwapdist" || kind === "dayhigh" || kind === "daylow") && ["1D", "1W"].includes(f.tf)) return toast("이 조건은 분봉에서만 돼요 (봉을 5분봉 등으로)");
    if ((kind === "price" && !(a.value > 0)) || (kind === "rsi" && !(a.value >= 0 && a.value <= 100))) return toast("값을 확인해 주세요");
    const al = alerts.add(a);
    focus = al.id;
    form = null;
    toast(`🔔 만들었어요 · ${alertText(al)}`);
    render();
  }

  function formView() {
    const f = form;
    const info = describe(f.sym);
    const sent = SENTIMENT[f.sym];
    const row = (label, ...ctrl) => h("div.set-row", h("span.set-label", label), ...ctrl);
    const input = (get, set, o = {}) => h("input", { type: "number", step: "any", value: get(), oninput: (e) => set(e.target.value), style: "max-width:200px", ...o });
    const conds = CONDS.filter(([k]) => (k === "stage" ? !!sent : true)).filter(([k]) => !((k.startsWith("ind") || k.startsWith("vwap") || k.startsWith("day")) && info.line));
    const kind = f.cond.split("_")[0];
    return h(
      "div.al-form",
      h("h3", "새 알림"),
      row("종목", h("button", { onclick: () => pickSymbol((id) => ((form.sym = id), (form.tf = describe(id).tfs.includes(form.tf) ? form.tf : "1D"), render())) }, `${info.label} ${info.sub ? `· ${info.sub}` : ""} ▾`)),
      row("봉", segment(TIMEFRAMES.filter((t) => info.tfs.includes(t)).map((t) => [t, TF_NAME[t]]), () => f.tf, (v) => ((f.tf = v), render()))),
      row("조건", h("select.set-sel", { onchange: (e) => ((f.cond = e.target.value), render()) }, conds.map(([k, label]) => h("option", { value: k, selected: k === f.cond }, label)))),
      kind === "price" ? row("가격", input(() => f.value, (v) => (f.value = v))) : null,
      kind === "ind"
        ? row(
            "지표",
            segment([["sma", "SMA"], ["ema", "EMA"], ["vwma", "VWMA"], ["vwap", "VWAP"]], () => f.ind.id, (v) => ((f.ind.id = v), render())),
            f.ind.id !== "vwap" ? h("span.ind-param", "기간", input(() => f.ind.params.length, (v) => (f.ind.params.length = Math.max(1, Math.round(+v || 1))), { style: "max-width:110px" })) : null
          )
        : null,
      kind === "rsi" ? row("RSI 기간", input(() => f.rsiLen ?? 14, (v) => (f.rsiLen = v), { style: "max-width:90px" })) : null,
      kind === "rsi" ? row("RSI 값", input(() => f.rsi, (v) => (f.rsi = v), { style: "max-width:110px" }), h("span.hint", "보통 30 아래 = 많이 떨어짐, 70 위 = 많이 오름")) : null,
      kind === "pct" || kind === "vwapdist" ? row("%", input(() => f.pct ?? 3, (v) => (f.pct = v), { style: "max-width:110px" }), h("span.hint", kind === "pct" ? "예: 3 → 전일 종가보다 3% 넘게 움직이면" : "예: 2 → VWAP에서 2% 넘게 떨어지면")) : null,
      kind === "stage" && sent ? row("단계", segment(sent.stages.map((s) => [s.name, s.name]), () => f.stage, (v) => (f.stage = v))) : null,
      row("확인", segment([[false, "봉이 끝날 때만"], [true, "실시간"]], () => f.live, (v) => (f.live = v)), h("span.hint", "봉이 끝날 때만 = 잠깐 찔렀다 돌아오면 안 울려요")),
      row("울림", segment([[true, "한 번만"], [false, "넘을 때마다"]], () => f.once, (v) => (f.once = v))),
      h("div.row", h("button.primary", { onclick: create }, "만들기"), h("button", { onclick: () => ((form = null), render()) }, "취소"))
    );
  }

  function render() {
    const list = alerts.list();
    const items = list.map((a) =>
      h(
        `div.al-row${a.id === focus ? ".focus" : ""}${a.on ? "" : ".off"}`,
        toggle(() => a.on, (v) => (alerts.update(a.id, { on: v }), render())),
        h("div.al-main", h("div.al-text", alertText(a)), h("div.al-sub", `${a.live ? "실시간" : "봉이 끝날 때"} · ${a.once ? "한 번만" : "넘을 때마다"}${a.fired?.length ? ` · 마지막 ${clock(a.fired[0].at)}` : ""}`)),
        h("button", { onclick: () => (alerts.update(a.id, { live: !a.live }), render()), "data-tip-text": "봉이 끝날 때만 ↔ 실시간" }, a.live ? "실시간" : "봉 마감"),
        h("button", { onclick: () => (alerts.update(a.id, { once: !a.once }), render()), "data-tip-text": "한 번만 ↔ 넘을 때마다" }, a.once ? "한 번" : "매번"),
        h("button", { onclick: () => (alerts.remove(a.id), render()), "data-tip-text": "지우기" }, "🗑")
      )
    );
    const fired = list
      .flatMap((a) => (a.fired ?? []).map((f) => ({ ...f, a })))
      .sort((x, y) => y.at - x.at)
      .slice(0, 15)
      .map((f) => h("div.al-fired", h("span.muted", `${new Date(f.at).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}  `), alertText(f.a)));
    const parts = [
      form ? formView() : null,
      h("div.set-row", h("span.set-label", "소리"), toggle(() => cfg.alert_sound ?? true, (v) => ((cfg.alert_sound = v), cfg.save())), h("span.hint", "Windows 알림과 함께 '딩-동'")),
      h("h3", `알림 ${list.length}개`),
      items.length ? items : h("p.hint", "아직 없어요. ＋ 새 알림, 또는 차트에서 그린 선·지표 이름을 오른쪽 클릭 → 알림 만들기"),
      fired.length ? [h("h3", "최근 울린 알림"), fired] : null,
      h("p.hint", "앱이 켜져 있을 때만 확인해요 (창이 다른 창 뒤에 있어도 돼요). 앱을 끄면 멈춰요."),
    ];
    body.replaceChildren(...parts.flat(2).filter(Boolean));
  }

  function open(o = {}) {
    focus = o.focus ?? null;
    if (o.newForm) newForm(o.newForm);
    else if (!o.keepForm) form = null;
    render();
    root.hidden = false;
  }
  function close() {
    root.hidden = true;
  }

  return {
    open,
    close,
    render,
    get isOpen() {
      return !root.hidden;
    },
  };
}
