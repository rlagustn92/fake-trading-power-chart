// 출처별 연결 상태 (하단 상태줄의 ● 초록/빨강)

const listeners = new Set();
const statuses = {};

export function setSourceStatus(name, ok) {
  if (statuses[name] === ok) return;
  statuses[name] = ok;
  for (const fn of listeners) fn(name, ok);
}

export function onSourceStatus(fn) {
  listeners.add(fn);
  for (const [k, v] of Object.entries(statuses)) fn(k, v);
  return () => listeners.delete(fn);
}

export const sourceStatus = (name) => statuses[name];
