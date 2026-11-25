// 24시간 선물 봉의 빈 곳 (0.31.0). 순수 계산 (tests.js에서 시험)
// 무기한선물은 쉬는 시간이 없어서, 같은 봉 종류의 봉 사이가 한 칸보다 벌어지면 그 사이 봉이 빠진 것이다.

/** 봉 사이가 sec보다 벌어진 곳 → [[앞 봉 t, 뒤 봉 t], ...] (오래된 순) */
export function findHoles(bars, sec) {
  const out = [];
  if (!(sec > 0)) return out;
  for (let i = 1; i < bars.length; i++) if (bars[i].t - bars[i - 1].t > sec) out.push([bars[i - 1].t, bars[i].t]);
  return out;
}

/** 빈 곳에 빠진 봉 수 */
export const missingOf = ([a, b], sec) => Math.max(0, Math.round((b - a) / sec) - 1);

/** 빈 곳의 길이를 쉬운 말로: "15분" · "3시간" · "21시간" · "2일" */
export function holeSpan([a, b], sec) {
  const s = Math.max(sec, b - a - sec);
  if (s < 3600) return `${Math.round(s / 60)}분`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)}시간`;
  return `${Math.round(s / 86400)}일`;
}

/**
 * 빈 곳 하나 [a, b]를 거래소에서 다시 받기. a 봉도 다시 받는다 (앱을 끈 시각의 봉은 반쪽만 저장돼 있을 수 있다).
 * page(startSec, endSec) → 그 사이 봉 (오래된 순, 많아야 한 쪽). put(rows) → 저장.
 * → {added: 빈 곳 안에 새로 들어온 봉 수, empty: 받은 뒤에도 남은 빈 곳 (거래소에도 봉이 없는 곳)}
 */
export async function fillHole([a, b], sec, page, put, maxPages = 40) {
  const got = [];
  let start = a;
  for (let i = 0; i < maxPages && start < b; i++) {
    const rows = (await page(start, b - 1)).filter((k) => k.t >= start && k.t < b);
    if (!rows.length) break;
    await put(rows);
    got.push(...rows);
    const next = rows[rows.length - 1].t + sec;
    if (next <= start) break;
    start = next;
  }
  const inside = got.filter((k) => k.t > a && k.t < b);
  const ts = [a, ...inside.map((k) => k.t), b];
  return { added: inside.length, empty: findHoles(ts.map((t) => ({ t })), sec) };
}

/**
 * 실시간 봉 저장 문지기 (0.31.0): 저장소가 실시간 봉까지 이어지기 전에는 실시간 봉을 쓰지 않는다.
 * 먼저 쓰면 저장소의 마지막 봉이 "지금"이 되어, 그 앞(앱을 꺼 둔 동안)을 이어 받지 않고 넘어가 빈 곳으로 남았다.
 * catchUp() → Promise<boolean> (이어 받기 성공 여부). 처음 봉, 또는 봉을 건너뛰었을 때(다시 연결·절전에서 깨어남) 이어 받는다.
 * write(rows)는 이어 받기가 끝난 뒤에만. 실패하면 retryMs 뒤에 다시 이어 받고, 그동안 봉은 모아 둔다.
 */
export function createLiveGate({ sec, catchUp, write, now = () => Date.now(), retryMs = 15000, max = 2000 }) {
  const pending = new Map();
  let lastT = null;
  let gate = null;
  let ok = !catchUp;
  let triedAt = -Infinity;
  const call = () => {
    try {
      return Promise.resolve(catchUp());
    } catch (e) {
      return Promise.reject(e);
    }
  };
  const start = () => {
    ok = false;
    triedAt = now();
    // 이어 받는 중에 또 건너뛰면 그것이 끝난 뒤 한 번 더 (먼저 것은 건너뛴 봉까지 못 받았을 수 있다)
    const g = (gate ? gate.then(call) : call())
      .then(
        (good) => !!good,
        () => false
      )
      .then((good) => {
        if (gate === g) {
          gate = null;
          ok = good;
        }
        return good;
      });
    gate = g;
    return g;
  };
  return {
    /** 실시간 봉 하나 (화면에는 바로, 저장은 flush 때) */
    row(r) {
      if (catchUp && (lastT == null || r.t > lastT + sec)) start();
      if (lastT == null || r.t > lastT) lastT = r.t;
      pending.set(r.t, r);
      if (pending.size > max) pending.delete(pending.keys().next().value);
    },
    /** 모아 둔 봉 쓰기. 아직 못 쓰면 false (나중에 다시 부르면 된다) */
    flush() {
      if (!ok) {
        if (!gate && now() - triedAt >= retryMs) start();
        return false;
      }
      const rows = [...pending.values()];
      pending.clear();
      if (rows.length) write(rows);
      return true;
    },
    /** 시험용: 지금 이어 받는 중인 약속 */
    get waiting() {
      return gate;
    },
    get pending() {
      return pending.size;
    },
  };
}
