// 자동 삼각수렴 감지 (SPEC §3.4) — 규칙으로 찾는 참고용, 사람 눈과 다를 수 있다
// 1) 최근 구간의 프랙탈 고점·저점(§3.2)을 모은다
// 2) 고점 두 개를 잇는 위 선(내려가거나 수평), 저점 두 개를 잇는 아래 선(올라가거나 수평)을 만든다
// 3) 구간 안의 봉이 선 밖으로 ATR×0.3보다 많이 나가지 않고, 두 선이 오른쪽 가까운 미래에서 만나면 삼각수렴
//    (선에 닿은 곳이 모두 5번 이상, 폭이 처음의 60% 이하로 좁아져야 — 아무 데서나 찾지 않게)
// 선은 화면에서 곧은 선(로그 눈금이면 log 가격에서 곧은 선) — f/finv로 받는다
import { fractals, atr } from "./calc.js";

const KIND_NAME = { sym: "대칭 삼각형", asc: "상승 삼각형", desc: "하락 삼각형" };

export function findTriangle(bars, { n = 2, lookback = 150, tolAtr = 0.3, f = (x) => x, finv = (x) => x } = {}) {
  const N = bars.length;
  if (N < 30) return null;
  const from = Math.max(0, N - lookback);
  const fr = fractals(bars.slice(from), n);
  const highs = fr.up.map((i) => i + from).slice(-8);
  const lows = fr.down.map((i) => i + from).slice(-8);
  const a = atr(bars, 14);
  const tol = tolAtr * (a[N - 1] ?? 0);
  if (!(tol > 0) || highs.length < 2 || lows.length < 2) return null;

  const line = (i1, p1, i2, p2) => {
    const F1 = f(p1);
    const s = (f(p2) - F1) / (i2 - i1);
    return { i1, F1, s, at: (i) => finv(F1 + s * (i - i1)) };
  };
  const ups = [];
  for (let x = 0; x < highs.length; x++)
    for (let y = x + 1; y < highs.length; y++) {
      const L = line(highs[x], bars[highs[x]].h, highs[y], bars[highs[y]].h);
      ups.push({ L, a: highs[x], b: highs[y], pts: highs });
    }
  const dns = [];
  for (let x = 0; x < lows.length; x++)
    for (let y = x + 1; y < lows.length; y++) {
      const L = line(lows[x], bars[lows[x]].l, lows[y], bars[lows[y]].l);
      dns.push({ L, a: lows[x], b: lows[y], pts: lows });
    }

  let best = null;
  for (const U of ups) {
    for (const D of dns) {
      const start = Math.min(U.a, D.a);
      const end = Math.max(U.b, D.b);
      if (end - start < 15) continue;
      // 두 선이 서로 엇갈려 있어야 (한쪽이 다른 쪽보다 한참 앞서면 삼각형이 아님)
      if (Math.max(U.a, D.a) >= Math.min(U.b, D.b)) continue;
      const span = end - start;
      // 위·아래 선이 비슷한 곳에서 시작하고 둘 다 구간의 절반 이상 이어져야 (한쪽만 긴 선은 삼각형이 아님)
      if (Math.abs(U.a - D.a) > 0.4 * span || U.b - U.a < 0.5 * span || D.b - D.a < 0.5 * span) continue;
      const dU = U.L.at(end) - U.L.at(start);
      const dD = D.L.at(end) - D.L.at(start);
      const flat = 0.5 * (a[end] ?? tol / tolAtr);
      const uFlat = Math.abs(dU) < flat;
      const dFlat = Math.abs(dD) < flat;
      if ((!uFlat && dU > 0) || (!dFlat && dD < 0) || (uFlat && dFlat)) continue;
      // 만나는 곳 (봉 위치)
      if (U.L.s === D.L.s) continue;
      const apex = (D.L.F1 - U.L.F1 + U.L.s * U.L.i1 - D.L.s * D.L.i1) / (U.L.s - D.L.s);
      if (!(apex > end) || apex > N - 1 + span) continue;
      // 확실히 좁아지는 모양
      const w0 = U.L.at(start) - D.L.at(start);
      const w1 = U.L.at(end) - D.L.at(end);
      if (!(w0 > 0) || w1 > 0.6 * w0 || w0 < 2.5 * (tol / tolAtr)) continue;
      // 첫 고점이 구간에서 가장 높고, 첫 저점이 가장 낮아야 (큰 흔들림이 점점 작아지는 모양)
      let hiMax = -Infinity;
      let loMin = Infinity;
      for (let i = start; i <= end; i++) {
        if (bars[i].h > hiMax) hiMax = bars[i].h;
        if (bars[i].l < loMin) loMin = bars[i].l;
      }
      if (bars[U.a].h < hiMax - tol || bars[D.a].l > loMin + tol) continue;
      // 구간 안의 봉이 선 밖으로 크게 나가지 않음
      let ok = true;
      for (let i = start; i <= end && ok; i++) {
        if (bars[i].h > U.L.at(i) + tol || bars[i].l < D.L.at(i) - tol) ok = false;
        if (U.L.at(i) <= D.L.at(i)) ok = false;
      }
      if (!ok) continue;
      const touch = (L, idx, key) => idx.filter((i) => i >= start && i <= end && Math.abs(bars[i][key] - L.at(i)) <= tol).length;
      const tu = touch(U.L, U.pts, "h");
      const td = touch(D.L, D.pts, "l");
      if (tu < 2 || td < 2 || tu + td < 5) continue;
      // 이탈: 마지막 점 다음부터 종가가 선 밖으로
      let brk = null;
      for (let i = end + 1; i <= Math.min(N - 1, Math.floor(apex)); i++) {
        if (bars[i].c > U.L.at(i)) brk = { i, up: true };
        else if (bars[i].c < D.L.at(i)) brk = { i, up: false };
        if (brk) break;
      }
      // 이탈한 지 오래된 것은 지난 일, 이탈 없이 꼭짓점을 지났으면 깨진 모양
      if (brk && N - 1 - brk.i > Math.max(10, span / 2)) continue;
      if (!brk && apex < N - 1) continue;
      const kind = uFlat ? "asc" : dFlat ? "desc" : "sym";
      const score = end * 1000 + (tu + td) * 10 + span / 1000;
      if (!best || score > best.score) {
        best = {
          score,
          kind,
          name: KIND_NAME[kind],
          start,
          end,
          apexL: apex,
          apexP: U.L.at(apex),
          up: [{ i: U.a, p: bars[U.a].h }, { i: U.b, p: bars[U.b].h }],
          dn: [{ i: D.a, p: bars[D.a].l }, { i: D.b, p: bars[D.b].l }],
          upAt: U.L.at,
          dnAt: D.L.at,
          breakout: brk,
        };
      }
    }
  }
  return best;
}
