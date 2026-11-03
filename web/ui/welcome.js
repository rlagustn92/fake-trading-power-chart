// 처음 켰을 때 안내 (새 PC) — FAKE TRADING: ① 💰 모의매매 창 열기 ② 리플레이용 1분봉 받기 ③ 🎲 아무 때나 시작 ④ (선택) 키
// 원본(POWER CHART)은 알파카 키·미국 분봉 받기가 먼저였다. 이 앱은 Binance 1분봉으로 연습하니 키가 없어도 된다 (2026-10-30)
// 받아 둔 데이터가 이미 있는 PC에서는 뜨지 않는다. 설정 → 도움말 → "처음 안내 다시 보기"로 언제든.
import { h } from "./dom.js";
import * as db from "../core/db.js";
import * as A from "../sources/alpaca.js";
import * as TS from "../sources/toss.js";

export async function maybeWelcome(app, force = false) {
  const { cfg } = app;
  if (!force && cfg.first_run_done) return;
  if (!force) {
    const cov = await db.coverage().catch(() => []);
    if (cov.length > 5) {
      // 이미 쓰던 PC (데이터가 있음) → 안내 없이
      cfg.first_run_done = true;
      cfg.save();
      return;
    }
  }
  const done = () => {
    cfg.first_run_done = true;
    cfg.save();
    wrap.remove();
  };
  const ok = (on) => h(`span.wel-ok${on ? ".on" : ""}`, on ? "✓" : "○");
  const step = (n, title, on, ...body) => h("div.wel-step", h("div.wel-head", ok(on), h("b", `${n}. ${title}`)), h("div.wel-body", ...body));

  // 1~3: 💰 창을 열어 두고 안내를 닫으면, 사용자는 그 창의 "30일 받기" → "🎲 아무 때나 시작"을 차례로 누르면 된다
  const openTrade = () => {
    if (!app.trading?.isOpen) app.trading?.toggle(true);
    done();
  };

  // 키를 넣으러 설정을 열면 안내는 잠깐 숨었다가(설정 창을 가리지 않게), 설정을 닫으면 ✓ 표시를 새로 그려서 다시 보인다
  const goKeys = () => {
    wrap.hidden = true;
    app.openSettings("데이터", () => {
      wrap.hidden = false;
      paintKeys();
    });
  };
  const keySteps = h("div");
  const paintKeys = () =>
    keySteps.replaceChildren(
      step(4, "(선택) 키 넣기 — 없어도 연습돼요", A.hasKey() || TS.hasKey(), h("button", { onclick: goKeys }, "키 넣으러 가기"), h("span.hint", "알파카 = 미국 원주식 분봉, 토스 = 국내·미국 실시간 (Market Board에 넣어 뒀으면 자동)"))
    );
  paintKeys();

  const wrap = h(
    "div.overlay.dialog",
    h(
      "div.panel.center.welcome",
      h("h2", "👋 FAKE TRADING 시작하기"),
      h("p.hint", "과거 차트를 다시 틀어 놓고 가상 돈으로 롱·숏을 연습하는 프로그램이에요. 진짜 주문은 절대 나가지 않아요."),
      step(1, "💰 모의매매 창 열기", !!app.trading?.isOpen, h("span.hint", "툴바의 💰 모의매매 버튼 (오른쪽에 창이 열려요)")),
      step(2, "과거 1분봉 받기", false, h("span.hint", "💰 창의 '30일 받기' (약 30초, 키 없음). 더 길게 하려면 '상장일부터'")),
      step(3, "🎲 아무 때나 시작", false, h("span.hint", "Space 재생 · 매수/매도 · 선을 끌어 익절·손절 · 원하는 가격에 미리 선 깔기")),
      keySteps,
      h("p.hint", "다른 PC에서 쓰던 데이터가 있으면 ⚙ 설정 → 데이터 → '📂 파일에서 가져오기'로 한 번에 옮길 수 있어요."),
      h("div.row", h("button.primary", { onclick: openTrade }, "💰 모의매매 창 열고 시작"), h("button", { onclick: done }, "닫기"))
    )
  );
  document.body.append(wrap);
}
