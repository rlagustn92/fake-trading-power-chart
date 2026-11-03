// 공통 재연결 헬퍼 (Market Board에서 가져옴): 지수 백오프(1초→2초→…최대 30초), 일정 시간 무수신 시 강제 재연결.
import { setSourceStatus } from "./status.js";

const all = new Set();

/** PC가 절전에서 깨어났거나 네트워크가 돌아오면 모든 연결을 다시 맺는다 */
export function reconnectAll() {
  for (const ws of all) ws.reconnectNow();
}

export class ReconnectingWS {
  /**
   * @param {object} o
   * @param {string|(() => string)} o.url
   * @param {string} o.name 상태 표시용 소스 이름
   * @param {(ws: ReconnectingWS) => void} [o.onOpen]
   * @param {(msg: any) => void} o.onMessage 파싱된 JSON
   * @param {number} [o.idleMs] 이 시간 동안 아무것도 안 오면 재연결
   * @param {number} [o.pingMs] 주기적으로 ping 보내기 (0이면 안 보냄)
   * @param {any} [o.ping] 보낼 ping 메시지
   */
  constructor(o) {
    this.o = { idleMs: 30000, pingMs: 0, ...o };
    this.ws = null;
    this.delay = 1000;
    this.stopped = true;
    this.lastMsg = 0;
    this.timer = 0;
    this.watch = 0;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    all.add(this);
    this._connect();
    this.watch = setInterval(() => this._tick(), 5000);
  }

  stop() {
    this.stopped = true;
    all.delete(this);
    clearInterval(this.watch);
    clearTimeout(this.timer);
    this._close();
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  reconnectNow() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this._close();
    this.delay = 1000;
    this._connect();
  }

  _close() {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {}
  }

  _connect() {
    const url = typeof this.o.url === "function" ? this.o.url() : this.o.url;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.lastMsg = Date.now();
    ws.onopen = () => {
      this.lastMsg = Date.now();
      this.lastPing = Date.now();
      this.o.onOpen?.(this);
    };
    ws.onmessage = (ev) => {
      this.lastMsg = Date.now();
      this.delay = 1000;
      setSourceStatus(this.o.name, true);
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.o.onMessage(msg);
    };
    ws.onclose = ws.onerror = () => {
      if (this.ws !== ws) return;
      this._close();
      setSourceStatus(this.o.name, false);
      this._schedule();
    };
  }

  _schedule() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._connect(), this.delay);
    this.delay = Math.min(this.delay * 2, 30000);
  }

  _tick() {
    if (this.stopped || !this.ws) return;
    const now = Date.now();
    if (now - this.lastMsg > this.o.idleMs) {
      setSourceStatus(this.o.name, false);
      this._close();
      this._schedule();
      return;
    }
    if (this.o.pingMs && this.open && now - (this.lastPing ?? 0) >= this.o.pingMs) {
      this.lastPing = now;
      this.send(this.o.ping);
    }
  }
}
