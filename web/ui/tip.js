// 큰 글씨 설명 상자 (SPEC §0.2-4): data-tip="지표 id" 또는 data-tip-text="직접 쓴 설명"인 곳에
// 마우스를 0.35초 올려 두면 뜬다. 브라우저 기본 툴팁(글씨가 작음)은 쓰지 않는다.
import { EXPLAIN } from "../indicators/explain.js";
import { h } from "./dom.js";

let box = null;
let timer = 0;
let target = null;

function content(el) {
  const id = el.dataset.tip;
  const e = id ? EXPLAIN[id] : null;
  if (e) {
    return [
      h("div.tip-name", e.name),
      e.ko ? h("div.tip-ko", e.ko) : null,
      h("div.tip-one", e.one),
      e.read ? h("div.tip-read", e.read) : null,
    ];
  }
  const text = el.dataset.tipText;
  return text ? text.split("\n").map((line, i) => h(i ? "div.tip-read" : "div.tip-one", line)) : null;
}

function place(x, y) {
  const r = box.getBoundingClientRect();
  let lx = x + 16;
  let ly = y + 18;
  if (lx + r.width > innerWidth - 8) lx = Math.max(8, x - r.width - 16);
  if (ly + r.height > innerHeight - 8) ly = Math.max(8, y - r.height - 12);
  box.style.transform = `translate(${lx}px, ${ly}px)`;
}

export function hideTip() {
  clearTimeout(timer);
  target = null;
  if (box) box.hidden = true;
}

export function setupTips() {
  box = h("div.tip", { hidden: true });
  document.body.append(box);
  let lastX = 0;
  let lastY = 0;
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const el = e.target.closest?.("[data-tip],[data-tip-text]");
    if (el === target) return;
    hideTip();
    if (!el) return;
    target = el;
    timer = setTimeout(() => {
      const c = content(el);
      if (!c || target !== el) return;
      box.replaceChildren(...c.filter(Boolean));
      box.hidden = false;
      place(lastX, lastY);
    }, 350);
  });
  document.addEventListener("pointermove", (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (!box.hidden) place(lastX, lastY);
  });
  document.addEventListener("pointerdown", hideTip, true);
  addEventListener("blur", hideTip);
}
