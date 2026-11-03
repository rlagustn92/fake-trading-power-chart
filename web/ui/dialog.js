// 이름 묻기·확인 상자 (브라우저 prompt/confirm 대신, 큰 글씨로)
import { h } from "./dom.js";

export function ask(title, { placeholder = "", value = "", ok = "저장" } = {}) {
  return new Promise((resolve) => {
    const input = h("input.search", { placeholder, value });
    const done = (v) => {
      wrap.remove();
      resolve(v);
    };
    const wrap = h(
      "div.overlay.dialog",
      h(
        "div.panel.center",
        h("h2", title),
        input,
        h("div.row", h("button.primary", { onclick: () => done(input.value.trim() || null) }, ok), h("button", { onclick: () => done(null) }, "취소"))
      )
    );
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) done(input.value.trim() || null);
      if (e.key === "Escape") {
        e.stopPropagation();
        done(null);
      }
    });
    document.body.append(wrap);
    input.focus();
  });
}

export function confirmBox(title, text, { ok = "확인", danger = false } = {}) {
  return new Promise((resolve) => {
    const done = (v) => {
      wrap.remove();
      resolve(v);
    };
    const wrap = h(
      "div.overlay.dialog",
      h(
        "div.panel.center",
        h("h2", title),
        text ? h("p", text) : null,
        h("div.row", h(`button${danger ? ".danger" : ".primary"}`, { onclick: () => done(true) }, ok), h("button", { onclick: () => done(false) }, "취소"))
      )
    );
    document.body.append(wrap);
  });
}

/** 잠깐 뜨는 알림 (오른쪽 아래). action: {label, onclick} → 버튼 하나 (예: 되돌리기) */
export function toast(text, ms = 3500, action = null) {
  const t = h("div.toast", text);
  if (action) {
    t.classList.add("act");
    t.append(h("button", { onclick: () => (t.remove(), action.onclick()) }, action.label));
  }
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}
