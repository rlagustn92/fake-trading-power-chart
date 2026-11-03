// 🆕 새 버전 받기 (0.15.0, 원조 POWER CHART AND BACKTEST 1.4.0과 같은 방식): GitHub Releases에 더 새 EXE가 있으면 알리고, 누르면 받아서 바꿔 넣고 다시 켠다.
// - 확인: 켜고 20초 뒤 한 번 + 켜 둔 동안 12시간마다 (⚙ 설정 → 화면 "새 버전 알림"으로 끈다) · ⚙ 설정 맨 위 "새 버전 확인"
// - 받기·확인값(SHA-256) 검사·바꿔 넣기·다시 켜기는 Rust(src-tauri/src/update.rs). 데이터·키·거래 기록은 EXE 밖에 있어서 그대로
import { h } from "./dom.js";
import { toast } from "./dialog.js";
import { invoke, inTauri, logInfo } from "../platform.js";

/** "0.15.0"이 "0.14.1"보다 새것인가 (숫자 세 개만, 아니면 false) */
export function newer(a, b) {
  const p = (v) => (/^\d+\.\d+\.\d+$/.test(v ?? "") ? v.split(".").map(Number) : null);
  const x = p(a);
  const y = p(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** Releases 본문(CHANGELOG의 그 버전 부분) → 큰 글씨로 읽기 좋게: 머리줄·굵게·코드 표시 빼기, 앞 25줄까지 */
export function notesText(md) {
  const lines = String(md ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").replace(/\*\*/g, "").replace(/`/g, "").trimEnd())
    .filter((l, i, a) => l || (i > 0 && a[i - 1]));
  return lines.length > 25 ? [...lines.slice(0, 25), "… (나머지는 GitHub Releases 페이지에)"].join("\n") : lines.join("\n");
}

export function createUpdater({ cfg, beforeRestart = async () => {} }) {
  const shown = new Set(); // 저절로 알린 버전 (켜 둔 동안 한 번)
  let busy = false;

  /** 확인. manual = ⚙ 설정에서 누름 (없어도 "최신이에요"라고 알림). 반환: 최신 정보 | null */
  async function check(manual = false) {
    if (!inTauri && !manual) return null; // 개발 서버에서는 저절로 확인하지 않는다
    if (!manual && !(cfg.update_notify ?? true)) return null;
    let l = null;
    try {
      l = await invoke("update_check", {});
    } catch (e) {
      logInfo(`[update] 확인 못 함: ${e?.message ?? e}`);
      if (manual) toast(`새 버전을 확인하지 못했어요 (${e?.message ?? e})`, 6000);
      return null;
    }
    if (!l) {
      if (manual) toast("GitHub에 아직 받을 버전이 없어요", 5000);
      return null;
    }
    if (!l.newer) {
      if (manual) toast(`지금 ${l.current}이 최신이에요`, 4000);
      return l;
    }
    if (manual || !shown.has(l.version)) {
      shown.add(l.version);
      toast(`🆕 새 버전 ${l.version}이 있어요 (지금 ${l.current})\n바뀐 것을 보고 받을 수 있어요 · 데이터·거래 기록은 그대로예요`, manual ? 15000 : 30000, { label: "보기", onclick: () => offer(l) });
    }
    return l;
  }

  /** 바뀐 것 보여 주고 "받고 다시 켜기" */
  function offer(l) {
    const msg = h("p.hint");
    const go = h("button.primary", { onclick: () => install(l, go, msg) }, "받고 다시 켜기");
    const close = () => !busy && wrap.remove();
    const wrap = h(
      "div.overlay.dialog",
      h(
        "div.panel.center.upd-panel",
        h("h2", `🆕 새 버전 ${l.version} (지금 ${l.current})`),
        h("div.upd-notes", notesText(l.notes) || "바뀐 것이 적혀 있지 않아요"),
        h("p.hint", `약 ${Math.max(1, Math.round(l.size / 1048576))}MB · 받은 파일이 GitHub의 확인값(SHA-256)과 같을 때만 바꿔요. 차트 데이터·관심종목·그린 것·거래 기록·키는 그대로예요. 다 받으면 앱이 저절로 다시 켜져요.`),
        msg,
        h("div.row", go, h("button", { onclick: close }, "나중에"))
      )
    );
    wrap.addEventListener("pointerdown", (e) => e.target === wrap && close());
    document.body.append(wrap);
  }

  async function install(l, btn, msg) {
    if (busy) return;
    if (!inTauri) return (msg.textContent = "개발 서버에서는 받을 수 없어요 (EXE에서만)");
    busy = true;
    btn.disabled = true;
    msg.textContent = "받는 중… (몇 초~1분)";
    try {
      await invoke("update_install", { version: l.version });
      msg.textContent = "다 받았어요 ✓ 다시 켜는 중…";
      logInfo(`[update] ${l.current} → ${l.version} 바꿔 넣음, 다시 켬`);
      await beforeRestart(); // 설정 등 저장
      await invoke("update_restart", {});
    } catch (e) {
      busy = false;
      btn.disabled = false;
      msg.textContent = `못 바꿨어요: ${e?.message ?? e}`;
      logInfo(`[update] 실패: ${e?.message ?? e}`);
    }
  }

  return { check, offer };
}
