// ✏️ 그리기 도구 막대 (SPEC §3.4): 아이콘 아래 원래 이름, 마우스를 올리면 쉬운 설명(§0.2-4)
import { h } from "./dom.js";
import { TOOLS } from "../drawings/layer.js";
import { confirmBox } from "./dialog.js";

const HOW = {
  trend: "시작점과 끝점을 찍으세요",
  info: "시작점과 끝점을 찍으세요",
  hline: "가격 한 곳을 찍으세요",
  hray: "시작할 곳을 찍으세요 → 오른쪽으로 쭉",
  triangle: "고점 → 저점 → 고점 → 저점 순서로 4번 찍으세요",
  fib: "고점(또는 저점)에서 반대쪽 끝까지 두 점을 찍으세요",
  avwap: "평균을 시작할 봉 하나를 찍으세요 (예: 급락 바닥, 실적 발표일)",
  brush: "마우스를 누른 채로 자유롭게 그리세요 (손을 떼면 끝 · 이 도구만 끌면 그려져요)",
  text: "글자를 쓸 곳을 누르세요",
};

export function createDrawbar(root, { cfg, grid, onToggle }) {
  const tool = (k, t) => h("button.dw-tool", { "data-tip": k, onclick: () => pick(k) }, h("span.dw-ico", t.icon), h("span.dw-name", t.name));
  const btns = Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, tool(k, t)]));
  const magnet = h(
    "button.dw-tool",
    {
      onclick: () => {
        cfg.chart.magnet = !(cfg.chart.magnet ?? true);
        cfg.save();
        paint();
      },
      "data-tip-text": "Magnet (자석)\n점을 찍을 때 가까운 봉의 시가·고가·저가·종가에 착 붙어요\nShift를 누르고 있으면 잠깐 꺼져요",
    },
    h("span.dw-ico", "🧲"),
    h("span.dw-name", "Magnet")
  );
  const keep = h(
    "button.dw-tool",
    {
      onclick: () => {
        cfg.chart.keep_draw_tool = !(cfg.chart.keep_draw_tool ?? true);
        cfg.save();
        paint();
      },
      "data-tip-text": "계속 그리기\n켜면: 하나를 다 그려도 도구가 그대로라 바로 다음 것을 그려요 (우클릭·Esc = 그만)\n끄면: 하나 그리면 도구가 꺼져요\n어느 쪽이든 누른 채 끌면 차트가 앞뒤로 움직여요",
    },
    h("span.dw-ico", "🔁"),
    h("span.dw-name", "계속 그리기")
  );
  const auto = h("button.dw-tool", { "data-tip": "triangle_auto", onclick: () => toggleAuto() }, h("span.dw-ico", "△"), h("span.dw-name", "Auto Triangle"));
  const clear = h("button.dw-tool", { "data-tip-text": "이 종목에 그린 것 모두 지우기", onclick: () => clearAll() }, h("span.dw-ico", "🗑"), h("span.dw-name", "모두 지우기"));
  const hint = h("span.dw-hint");
  const close = h("button.dw-tool", { onclick: () => toggle(false), "data-tip-text": "도구 막대 닫기" }, h("span.dw-ico", "✕"), h("span.dw-name", "닫기"));
  root.replaceChildren(...Object.values(btns), h("div.tb-sep"), magnet, keep, auto, h("div.tb-sep"), clear, hint, h("div.grow"), close);

  function pick(k) {
    const c = grid.current;
    if (!c) return;
    for (const o of grid.cells) if (o !== c) o.drawings.setTool(null);
    if (c.measure.on) c.measure.toggle(false); // 📏을 켠 채면 클릭이 측정으로 가서 그리기를 못 한다
    c.drawings.setTool(c.drawings.tool === k ? null : k);
  }

  function toggleAuto() {
    const c = grid.current;
    if (!c) return;
    const list = c.insts.map(({ uid, ...x }) => x);
    const has = list.some((x) => x.id === "triangle_auto");
    grid.setIndicators(has ? list.filter((x) => x.id !== "triangle_auto") : [...list, { id: "triangle_auto" }]);
    paint();
  }

  async function clearAll() {
    const c = grid.current;
    if (!c?.drawings.count()) return;
    if (await confirmBox(`${c.info.label}에 그린 것 ${c.drawings.count()}개를 모두 지울까요?`, null, { ok: "모두 지우기", danger: true })) c.drawings.clearAll();
    paint();
  }

  function paint() {
    const c = grid.current;
    const t = c?.drawings.tool;
    for (const [k, b] of Object.entries(btns)) b.classList.toggle("on", t === k);
    magnet.classList.toggle("on", cfg.chart.magnet ?? true);
    keep.classList.toggle("on", cfg.chart.keep_draw_tool ?? true);
    auto.classList.toggle("on", !!c?.insts.some((x) => x.id === "triangle_auto"));
    auto.disabled = !!c?.info.line;
    clear.disabled = !c?.drawings.count();
    hint.textContent = t ? `${TOOLS[t].name}: ${HOW[t]}${t === "brush" ? "" : " · 끌면 차트 이동"} · 우클릭/Esc = 그만` : "";
    hint.dataset.tipText = hint.textContent; // 좁아서 잘려도 마우스를 올리면 다 보인다
  }

  function toggle(on = root.hidden) {
    cfg.layout.drawbar_visible = on;
    cfg.save();
    root.hidden = !on;
    if (!on) for (const c of grid.cells) c.drawings.setTool(null);
    paint();
    onToggle?.(on);
  }

  root.hidden = !cfg.layout.drawbar_visible;
  paint();
  return {
    paint,
    toggle,
    get visible() {
      return !root.hidden;
    },
    pick,
  };
}
