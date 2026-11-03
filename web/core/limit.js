// 요청 줄 세우기: 동시에 n개까지, 요청 사이 최소 간격 gapMs (API를 두드리지 않게, SPEC §2.4)

export function createLimiter(n, gapMs) {
  let running = 0;
  let last = 0;
  const waiting = [];
  const next = () => {
    if (running >= n || !waiting.length) return;
    const wait = Math.max(0, last + gapMs - Date.now());
    if (wait > 0) {
      setTimeout(next, wait);
      return;
    }
    const { fn, resolve, reject, front } = waiting.shift();
    running++;
    last = Date.now();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        running--;
        next();
      });
    void front;
  };
  /** run(fn, {front}) — front=true면 줄 맨 앞에 (화면에 지금 보이는 차트용) */
  return function run(fn, { front = false } = {}) {
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject, front };
      if (front) waiting.unshift(job);
      else waiting.push(job);
      next();
    });
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
