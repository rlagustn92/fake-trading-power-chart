// 작은 DOM 도우미: h("div.cls", {onclick}, "글자", child...)

export function h(sel, props, ...children) {
  const [tag, ...classes] = sel.split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");
  if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.style.cssText = v;
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** 🎨 직접 고르기 (0.13.0, 지표·그리기 색): 무지개 동그라미를 누르면 윈도우 색 고르기 창 → 고르고 닫으면 onPick("#rrggbb") */
export function colorPick(value, onPick) {
  const v = /^#[0-9a-f]{6}$/i.test(value ?? "") ? value : "#ffffff";
  return h("label.swatch-pick", { "data-tip-text": "🎨 직접 고르기 (아무 색이나)" }, h("input", { type: "color", value: v, onchange: (e) => onPick(e.target.value) }));
}

/** − 값 + 조절기. 가운데 숫자는 직접 쳐도 된다 (Enter 또는 다른 곳 누르면 적용) */
export function stepper(get, set, { step, min, max, fmt = (v) => v, parse = parseFloat }) {
  const val = h("input.step-val", { type: "text", inputMode: "decimal", spellcheck: false, autocomplete: "off" });
  const show = () => (val.value = fmt(get()));
  const put = (v) => {
    if (!Number.isFinite(v)) return show();
    v = Math.min(max, Math.max(min, v));
    if (Number.isInteger(step)) v = Math.round(v); // 기간(봉 수) 같은 것은 정수
    set(+v.toFixed(4));
    show();
  };
  const change = (d) => put(Math.round((get() + d) / step) * step);
  val.addEventListener("change", () => put(parse(String(val.value).replace(/,/g, ""))));
  val.addEventListener("focus", () => val.select());
  val.addEventListener("keydown", (e) => {
    e.stopPropagation(); // 숫자를 칠 때 차트 단축키(1~7 봉 바꾸기)가 먹지 않게
    if (e.key === "Enter") val.blur();
    else if (e.key === "Escape") (show(), val.blur());
    else if (e.key === "ArrowUp") (e.preventDefault(), change(step));
    else if (e.key === "ArrowDown") (e.preventDefault(), change(-step));
  });
  show();
  return h("span.stepper", h("button", { onclick: () => change(-step) }, "−"), val, h("button", { onclick: () => change(step) }, "+"));
}

/** 켜기/끄기 */
export function toggle(get, set, label) {
  const b = h("button.toggle", { onclick: () => { set(!get()); paint(); } });
  const paint = () => {
    b.classList.toggle("on", !!get());
    b.textContent = `${label ? label + " " : ""}${get() ? "켬" : "끔"}`;
  };
  paint();
  return b;
}

/** 여러 개 중 하나 고르기 (버튼 묶음) */
export function segment(options, get, set) {
  const box = h("span.seg");
  const paint = () => {
    box.replaceChildren(
      ...options.map(([v, label]) =>
        h("button", { className: get() === v ? "on" : "", onclick: () => { set(v); paint(); } }, label)
      )
    );
  };
  paint();
  return box;
}

export function select(options, get, set) {
  const s = h("select.set-sel", { onchange: () => set(s.value) });
  for (const [v, label] of options) s.append(h("option", { value: v }, label));
  s.value = String(get());
  return s;
}
