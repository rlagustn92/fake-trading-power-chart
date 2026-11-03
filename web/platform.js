// Tauri 연결부. 브라우저(개발 서버 tools/devserver.py)에서 열어도 똑같이 돌아가도록 대체 동작을 둔다.
// - Tauri: Rust 명령(invoke) + HTTP 플러그인(fetch, CORS 없음)
// - 개발 서버: /__invoke/<명령> 과 /__proxy 로 같은 일을 흉내 낸다
const T = window.__TAURI__;
export const inTauri = !!T;
export let logInfo = () => {};

/** Rust 명령 호출. 봉 읽기(db_get)처럼 숫자 배열을 돌려주는 명령은 ArrayBuffer가 온다. */
export async function invoke(cmd, args, options) {
  if (T) return T.core.invoke(cmd, args, options);
  const raw = args instanceof Uint8Array || args instanceof ArrayBuffer;
  const res = await fetch(`/__invoke/${cmd}`, {
    method: "POST",
    headers: raw ? { "content-type": "application/octet-stream", ...(options?.headers ?? {}) } : { "content-type": "application/json" },
    body: raw ? args : JSON.stringify(args ?? {}),
  });
  if (!res.ok) throw new Error((await res.text()) || `invoke ${cmd} 실패`);
  if (res.headers.get("content-type")?.includes("octet-stream")) return res.arrayBuffer();
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// 경고·오류를 %APPDATA%\fake-trading-power-chart\logs\app.log에도 남긴다. 키처럼 보이는 값은 지운다.
{
  const SECRET = /(secret|token|key[_-]?id|apca[^"'=:\s]*|authorization)["'=:\s]+[^\s"',}]+/gi;
  const send = (level, args) => {
    const text = args
      .map((a) => (a instanceof Error ? `${a.message}` : typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ")
      .replace(SECRET, "$1=***");
    invoke("append_log", { line: `${new Date().toISOString()} ${level} ${text}` }).catch(() => {});
  };
  for (const level of ["warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      send(level.toUpperCase(), args);
    };
  }
  addEventListener("error", (e) => {
    if (String(e.message).startsWith("ResizeObserver loop")) return;
    send("ERROR", [e.message, `${e.filename}:${e.lineno}`]);
  });
  addEventListener("unhandledrejection", (e) => send("ERROR", ["unhandled", String(e.reason?.stack ?? e.reason)]));
  addEventListener("securitypolicyviolation", (e) => send("ERROR", ["CSP blocked", e.violatedDirective, e.blockedURI]));
  send("INFO", ["started"]);
  logInfo = (...args) => send("INFO", args);
}

/** 프로그램 버전 (src-tauri/tauri.conf.json의 version · 개발 서버에서는 "개발용") */
export async function appVersion() {
  try {
    return T?.app?.getVersion ? await T.app.getVersion() : "개발용";
  } catch {
    return "?";
  }
}

/** 창 제목에 버전: "FAKE TRADING POWER CHART 0.1.0" (어느 버전이 켜져 있는지 바로 보이게) */
export async function showVersionInTitle() {
  const v = await appVersion();
  const title = `FAKE TRADING POWER CHART ${v}`;
  document.title = title;
  try {
    await T?.window?.getCurrentWindow?.().setTitle(title);
  } catch {}
  logInfo(`version ${v}`);
}

/** Rust가 보내는 이벤트 듣기 (개발 서버에서는 아무것도 오지 않는다) */
export function listen(event, cb) {
  if (T?.event?.listen) T.event.listen(event, (e) => cb(e.payload));
}

/** REST 호출. Tauri에서는 CORS를 받지 않는 플러그인 fetch, 개발 서버에서는 /__proxy. */
export function httpFetch(url, opts = {}) {
  if (T?.http?.fetch) return T.http.fetch(url, opts);
  return fetch(`/__proxy?url=${encodeURIComponent(url)}`, {
    method: opts.method ?? "GET",
    headers: { "x-proxy-headers": JSON.stringify(opts.headers ?? {}), ...(opts.body ? { "content-type": "application/json" } : {}) },
    body: opts.body,
  });
}

export async function getJson(url, opts = {}) {
  const res = await httpFetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

export async function getText(url, opts = {}) {
  const res = await httpFetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

export async function postJson(url, body) {
  return getJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** %APPDATA%\fake-trading-power-chart\<name> 읽기/쓰기 */
export async function loadFile(name) {
  try {
    const s = await invoke("load_json", { name });
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

export async function saveFile(name, obj) {
  const data = JSON.stringify(obj);
  try {
    await invoke("save_json", { name, data });
    dispatchEvent(new CustomEvent("pc:save", { detail: { name, ok: true } }));
  } catch (e) {
    console.warn("저장 실패", name, e);
    dispatchEvent(new CustomEvent("pc:save", { detail: { name, ok: false, error: String(e) } }));
  }
}

/** 전체화면 켜고 끄기 (켜면 그 모니터를 기억 → 다음 실행 때 그대로) */
export async function toggleFullscreen() {
  if (!T) {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
    return;
  }
  const w = T.window.getCurrentWindow();
  await invoke("set_fullscreen", { on: !(await w.isFullscreen()) });
}

/** Windows 알림 (알림 플러그인, 개발 서버에서는 브라우저 알림) */
export async function notify(title, body) {
  try {
    const N = T?.notification;
    if (N) {
      let ok = await N.isPermissionGranted();
      if (!ok) ok = (await N.requestPermission()) === "granted";
      if (ok) N.sendNotification({ title, body });
      return ok;
    }
    if (!("Notification" in window)) return false;
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission !== "granted") return false;
    new Notification(title, { body });
    return true;
  } catch (e) {
    console.warn("알림 보내기 실패", e);
    return false;
  }
}

/** 알림 소리: 파일 없이 짧은 "딩-동" */
let audio = null;
export function chime() {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    for (const [f, at] of [[880, 0], [660, 0.18]]) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f;
      o.type = "sine";
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.25, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.45);
      o.connect(g).connect(audio.destination);
      o.start(t + at);
      o.stop(t + at + 0.5);
    }
  } catch {}
}

export async function setZoom(scale) {
  if (T) return invoke("set_zoom", { scale });
  document.documentElement.style.zoom = String(scale); // 개발 서버용 흉내
}
