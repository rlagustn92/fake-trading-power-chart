// 떠 있는 메뉴 (보기 ▾, 분할, 관심종목 오른쪽 클릭 등). items: [{label, sub, tip, on, disabled, onclick, keep}] | {sep} | {header}
import { h } from "./dom.js";

let cur = null;

/** 떠 있던 메뉴를 닫았으면 true */
export function closeMenu() {
  const was = !!cur;
  cur?.remove();
  cur = null;
  return was;
}

export function openMenu(anchor, items, { x = null, y = null } = {}) {
  closeMenu();
  const box = h("div.menu");
  const paint = () => {
    box.replaceChildren(
      ...items.map((it) => {
        if (it.sep) return h("div.menu-sep");
        if (it.header) return h("div.menu-header", it.header);
        if (it.node) return it.node;
        const on = typeof it.on === "function" ? it.on() : it.on;
        return h(
          `button.menu-item${on ? ".on" : ""}`,
          {
            disabled: it.disabled,
            "data-tip": it.tip ?? null,
            "data-tip-text": it.tipText ?? null,
            onclick: (e) => {
              e.stopPropagation();
              it.onclick?.();
              if (it.keep) paint();
              else closeMenu();
            },
          },
          h("span.menu-check", on ? "✓" : ""),
          h("span.menu-label", it.label),
          it.sub ? h("span.menu-sub", it.sub) : null
        );
      })
    );
  };
  paint();
  document.body.append(box);
  const r = anchor?.getBoundingClientRect();
  const bw = box.offsetWidth;
  const bh = box.offsetHeight;
  let left = x ?? r.left;
  let top = y ?? r.bottom + 4;
  if (left + bw > innerWidth - 6) left = innerWidth - bw - 6;
  if (top + bh > innerHeight - 6) top = Math.max(6, (y ?? r.top) - bh - 4);
  box.style.left = `${Math.max(6, left)}px`;
  box.style.top = `${Math.max(6, top)}px`;
  cur = box;
  setTimeout(() => {
    const away = (e) => {
      if (box.contains(e.target)) return;
      closeMenu();
      removeEventListener("pointerdown", away, true);
    };
    addEventListener("pointerdown", away, true);
  });
  return { repaint: paint, close: closeMenu };
}
