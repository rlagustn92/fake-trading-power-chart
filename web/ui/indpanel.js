// 지표 패널 (SPEC §3.2): 왼쪽 = 넣을 수 있는 지표(교과서 이름 + 한글 이름, 마우스 올리면 설명),
// 오른쪽 = 이 칸에 들어간 지표 (파라미터·색·두께·숨기기·빼기·순서). 바꾸면 바로 반영.
import { h, stepper, colorPick } from "./dom.js";
import { INDICATORS, ORDER, PALETTE, SWATCHES, withDefaults } from "../indicators/index.js";
import { EXPLAIN } from "../indicators/explain.js";
import { TF_NAME } from "../core/data.js";
import { TF_SEC } from "../core/bars.js";
import { ask } from "./dialog.js";

const TFS = ["", "5m", "15m", "30m", "1h", "4h", "1D", "1W"];

export function createIndicatorPanel(root, { getCell, apply, cfg }) {
  let focusUid = null;
  root.addEventListener("pointerdown", (e) => e.target === root && close());

  function current() {
    const cell = getCell();
    return cell ? cell.insts.map((x) => ({ ...x, params: { ...x.params } })) : [];
  }

  function commit(list) {
    apply(list);
    render();
  }

  function render() {
    const cell = getCell();
    if (!cell) return;
    const list = current();
    const info = cell.info;
    const avail = ORDER.map((id) => {
      const d = INDICATORS[id];
      const e = EXPLAIN[id];
      const off = (d.needsVolume && !info.volume) || (d.intradayOnly && ["1D", "1W"].includes(cell.tf)) || (d.dailyOnly && !["1D", "1W"].includes(cell.tf));
      const note = d.needsVolume && !info.volume ? "거래량이 없는 종목" : d.intradayOnly && off ? "분봉에서만" : d.dailyOnly && off ? "일·주봉에서만" : "";
      return h(
        `button.ind-add${off ? ".off" : ""}`,
        {
          "data-tip": id,
          onclick: () => {
            const k = list.filter((x) => x.id === id).length;
            const inst = withDefaults({ id, color: k ? PALETTE[(list.length + 1) % PALETTE.length] : undefined }, k);
            focusUid = inst.uid;
            showFocus = true; // 새로 넣은 지표(맨 아래)가 보이게
            commit([...list, inst]);
          },
        },
        h("span.ind-name", e?.name ?? id),
        h("span.ind-ko", `${e?.ko ?? ""}${note ? ` · ${note}` : ""}`),
        h("span.ind-plus", "＋")
      );
    });

    const mine = list.map((inst, i) => {
      const d = INDICATORS[inst.id];
      const e = EXPLAIN[inst.id];
      const set = (patch) => {
        list[i] = { ...list[i], ...patch };
        commit(list);
      };
      const setP = (k, v) => {
        list[i].params = { ...list[i].params, [k]: v };
        commit(list);
      };
      const params = d.params.map((p) => {
        if (p.type === "bool") {
          const on = !!inst.params[p.key];
          return h(`button.ind-bool${on ? ".on" : ""}`, { onclick: () => setP(p.key, !on), "data-tip-text": p.tip ?? "" }, `${on ? "✓ " : ""}${p.label}`);
        }
        // 고르기 (이동평균 소스: 종가·고가·저가…, 듀얼 이평 종류) — 0.14.0
        if (p.type === "select") {
          return h(
            "label.ind-param",
            { "data-tip-text": p.tip ?? "" },
            p.label,
            h("select.set-sel", { onchange: (ev) => setP(p.key, ev.target.value) }, p.options.map(([v, l]) => h("option", { value: v, selected: (inst.params[p.key] ?? p.def) === v }, l)))
          );
        }
        if (p.type === "tf") {
          return h(
            "label.ind-param",
            p.label,
            h(
              "select.set-sel",
              { onchange: (ev) => setP(p.key, ev.target.value) },
              TFS.filter((t) => !t || t === inst.params[p.key] || TF_SEC[t] > TF_SEC[cell.tf]).map((t) => h("option", { value: t, selected: (inst.params[p.key] ?? "") === t }, t ? `${TF_NAME[t]}봉${TF_SEC[t] < TF_SEC[cell.tf] ? " (이 봉에선 숨김)" : ""}` : "차트와 같음"))
            )
          );
        }
        return h("span.ind-param", p.label, stepper(() => inst.params[p.key], (v) => setP(p.key, v), { step: p.step ?? 1, min: p.min ?? 0, max: p.max ?? 9999 }));
      });
      // 같은 group(멀티 이평의 한 줄: [✓ 1시간봉] [기간 20])은 한 상자로 묶는다 (0.16.0). 차트보다 작은 봉 줄은 흐리게
      const boxes = [];
      d.params.forEach((p, k) => {
        const prev = boxes[boxes.length - 1];
        if (p.group && prev?.group === p.group) prev.els.push(params[k]);
        else boxes.push({ group: p.group, els: [params[k]] });
      });
      const paramEls = boxes.map((b) => {
        if (!b.group) return b.els[0];
        const small = TF_SEC[b.group] < TF_SEC[cell.tf];
        return h(`span.ind-group${small ? ".dim" : ""}`, { "data-tip-text": small ? `차트가 ${TF_NAME[cell.tf]}봉이라 이 줄(${TF_NAME[b.group]}봉)은 안 보여요\n차트보다 크거나 같은 봉만 그려요` : "" }, b.els);
      });
      const colors = h(
        "span.ind-colors",
        SWATCHES.map((c) => h(`button.swatch${c === inst.color ? ".on" : ""}`, { style: `background:${c}`, onclick: () => set({ color: c }), "aria-label": c })),
        colorPick(inst.color, (c) => set({ color: c }))
      );
      return h(
        `div.ind-row${inst.uid === focusUid ? ".focus" : ""}`,
        h(
          "div.ind-row-head",
          h("span.ind-name", { "data-tip": inst.id, style: `color:${inst.color}` }, e?.name ?? inst.id),
          h("span.ind-ko", e?.ko ?? ""),
          h("span.grow"),
          h("button", { onclick: () => i > 0 && commit(swap(list, i, i - 1)), disabled: i === 0, "data-tip-text": "위로" }, "▲"),
          h("button", { onclick: () => i < list.length - 1 && commit(swap(list, i, i + 1)), disabled: i === list.length - 1, "data-tip-text": "아래로" }, "▼"),
          h(`button${inst.hidden ? "" : ".on"}`, { onclick: () => set({ hidden: !inst.hidden }) }, inst.hidden ? "숨김" : "보임"),
          h("button", { onclick: () => commit(list.filter((_, k) => k !== i)) }, "빼기")
        ),
        h("div.ind-params", paramEls, (d.pane === "price" && !d.noColor) || inst.id === "rsi" || inst.id === "rsi_div" ? colors : null, h("span.ind-param", "두께", stepper(() => inst.width ?? 1, (v) => set({ width: v }), { step: 1, min: 1, max: 4 })))
      );
    });

    const presets = cfg.indicator_presets ?? {};
    const presetBar = h(
      "div.ind-presets",
      h("span.muted", "프리셋"),
      Object.keys(presets).map((name) =>
        h("span.preset", h("button", { onclick: () => commit(presets[name].map((x, k) => withDefaults(x, k))) }, name), h("button.x", { onclick: () => (delete presets[name], cfg.save(), render()), "data-tip-text": "프리셋 지우기" }, "✕"))
      ),
      cfg.indicators.length ? h("button", { onclick: () => commit(cfg.indicators.map((x, k) => withDefaults(x, k))), "data-tip-text": "'새 칸 기본으로 쓰기'로 정해 둔 조합" }, "기본으로") : null,
      h("button.danger", { onclick: () => commit([]), disabled: !list.length, "data-tip-text": "이 칸의 지표를 한 번에 모두 빼요" }, "🗑 모두 빼기"),
      h("button", {
        onclick: async () => {
          const name = await ask("지금 지표 조합의 이름", { placeholder: "예: 레버리지 장기, 단타 5분" });
          if (!name) return;
          cfg.indicator_presets = { ...presets, [name.trim()]: current().map(({ uid, ...x }) => x) };
          cfg.save();
          render();
        },
      }, "＋ 지금 조합 저장"),
      h("button", { onclick: () => { cfg.indicators = current().map(({ uid, ...x }) => x); cfg.save(); render(); }, "data-tip-text": "새 칸을 만들 때 이 조합으로 시작해요" }, "새 칸 기본으로 쓰기")
    );

    // 0.16.0 (사용자: "설정을 바꾸면 창이 다시 맨 위로 올라가서 은근 불편해"): 바꿀 때마다 창을 새로 그리니까
    // 보던 스크롤 자리를 기억했다가 그대로 돌려놓는다. 새로 넣었거나 범례에서 눌러 연 지표는 그 줄이 보이게
    const keep = (sel) => (scrollReset ? 0 : root.querySelector(sel)?.scrollTop ?? 0);
    const topAvail = keep(".ind-avail");
    const topMine = keep(".ind-mine");
    scrollReset = false;
    root.replaceChildren(
      h(
        "div.panel.indpanel",
        h("div.pick-head", h("h2", `지표 · ${cell.info.label} ${TF_NAME[cell.tf]}봉`), h("button.primary", { onclick: close }, "닫기")),
        presetBar,
        h("div.ind-cols", h("div.ind-avail", h("h3", "넣을 수 있는 지표"), avail), h("div.ind-mine", h("h3", `이 칸의 지표 ${list.length}개`), mine.length ? mine : h("p.hint", "왼쪽에서 눌러서 넣으세요")))
      )
    );
    const a = root.querySelector(".ind-avail");
    const m = root.querySelector(".ind-mine");
    if (a) a.scrollTop = topAvail;
    if (m) m.scrollTop = topMine;
    if (showFocus) {
      showFocus = false;
      root.querySelector(".ind-row.focus")?.scrollIntoView({ block: "nearest" });
    }
  }
  let scrollReset = false; // 창을 새로 열 때는 맨 위부터
  let showFocus = false; // 다음 그리기에서 고른 지표 줄이 보이게

  function open(uid = null) {
    focusUid = uid;
    root.hidden = false;
    scrollReset = true;
    showFocus = !!uid;
    render();
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

function swap(list, i, j) {
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
