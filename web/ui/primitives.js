// lightweight-charts에 직접 그리는 것들 (series primitive): 밴드 채우기, 가로 구간선, 매물대.
// 라이브러리에는 이런 그림이 없어서 attachPrimitive로 캔버스에 그린다.
import { upColor, rgba } from "../core/colors.js";

function viewOf(draw, zOrder = "bottom") {
  return { zOrder: () => zOrder, renderer: () => ({ draw }) };
}

class Base {
  attached({ chart, series, requestUpdate }) {
    this.chart = chart;
    this.series = series;
    this.req = requestUpdate;
  }
  detached() {
    this.chart = this.series = this.req = null;
  }
  updateAllViews() {}
  update() {
    this.req?.();
  }
}

/** 두 선 사이 칠하기 (볼린저 밴드). data: [{time, up, dn}] (봉 순서와 같은 길이, 빈 값은 null) */
export class BandFill extends Base {
  constructor(color) {
    super();
    this.color = color;
    this.data = [];
    this._views = [viewOf((t) => this.draw(t))];
  }
  setData(d) {
    this.data = d;
    this.update();
  }
  paneViews() {
    return this._views;
  }
  draw(target) {
    if (!this.chart || !this.data.length) return;
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    const from = Math.max(0, Math.floor(r.from) - 1);
    const to = Math.min(this.data.length - 1, Math.ceil(r.to) + 1);
    const pts = [];
    for (let i = from; i <= to; i++) {
      const d = this.data[i];
      if (!d || d.up == null || d.dn == null) continue;
      const x = ts.logicalToCoordinate(i);
      const yu = this.series.priceToCoordinate(d.up);
      const yd = this.series.priceToCoordinate(d.dn);
      if (x == null || yu == null || yd == null) continue;
      pts.push([x, yu, yd]);
    }
    if (pts.length < 2) return;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      ctx.beginPath();
      pts.forEach(([x, yu], k) => (k ? ctx.lineTo(x * hr, yu * vr) : ctx.moveTo(x * hr, yu * vr)));
      for (let k = pts.length - 1; k >= 0; k--) ctx.lineTo(pts[k][0] * hr, pts[k][2] * vr);
      ctx.closePath();
      ctx.fillStyle = this.color;
      ctx.fill();
    });
  }
}

/**
 * 가로 구간선 (피벗·전일 고저·삼각수렴 꼭짓점 등).
 * segs: [{from: 봉 번호, to: 봉 번호(없으면 오른쪽 끝까지), price, color, label, dash}]
 */
export class Levels extends Base {
  constructor() {
    super();
    this.segs = [];
    this._views = [viewOf((t) => this.draw(t), "normal")];
  }
  setData(segs) {
    this.segs = segs;
    this.update();
  }
  paneViews() {
    return this._views;
  }
  draw(target) {
    if (!this.chart || !this.segs.length) return;
    const ts = this.chart.timeScale();
    const width = ts.width();
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      ctx.font = `${Math.round(12 * vr)}px "Segoe UI", "Malgun Gothic", sans-serif`;
      ctx.textBaseline = "bottom";
      for (const s of this.segs) {
        const y = this.series.priceToCoordinate(s.price);
        if (y == null) continue;
        let x1 = ts.logicalToCoordinate(s.from);
        let x2 = s.to == null ? width : ts.logicalToCoordinate(s.to);
        if (x1 == null || x2 == null) continue;
        if (x2 < 0 || x1 > width) continue;
        x1 = Math.max(0, x1);
        x2 = Math.min(width, x2);
        ctx.strokeStyle = s.color;
        ctx.lineWidth = Math.max(1, Math.round((s.width ?? 1) * hr));
        ctx.setLineDash(s.dash ? [6 * hr, 4 * hr] : []);
        ctx.beginPath();
        ctx.moveTo(x1 * hr, Math.round(y * vr) + 0.5);
        ctx.lineTo(x2 * hr, Math.round(y * vr) + 0.5);
        ctx.stroke();
        if (s.label) {
          ctx.fillStyle = s.color;
          ctx.textAlign = "right";
          ctx.fillText(s.label, x2 * hr - 4 * hr, y * vr - 2 * vr);
        }
      }
      ctx.setLineDash([]);
    });
  }
}

/** 매물대 (Volume Profile Visible Range): 오른쪽에 가로 막대. calc(from, to) → volumeProfile 결과 */
export class VolumeProfile extends Base {
  constructor(calc, { up = rgba(upColor(), 0.28), va = "rgba(160,166,174,0.30)", other = "rgba(160,166,174,0.14)", poc = "#ffb020" } = {}) {
    super();
    this.calc = calc;
    this.colors = { up, va, other, poc };
    this.prof = null;
    this.key = "";
    this._views = [viewOf((t) => this.draw(t), "bottom")];
  }
  paneViews() {
    return this._views;
  }
  refresh() {
    this.key = "";
    this.update();
  }
  draw(target) {
    if (!this.chart) return;
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    const key = `${Math.floor(r.from)}|${Math.ceil(r.to)}`;
    if (key !== this.key) {
      this.key = key;
      this.prof = this.calc(Math.max(0, Math.floor(r.from)), Math.ceil(r.to));
    }
    const p = this.prof;
    if (!p) return;
    const max = Math.max(...p.vol);
    if (!max) return;
    const W = ts.width();
    const maxW = W * 0.28;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      for (let k = 0; k < p.vol.length; k++) {
        const y1 = this.series.priceToCoordinate(p.lo + k * p.step);
        const y2 = this.series.priceToCoordinate(p.lo + (k + 1) * p.step);
        if (y1 == null || y2 == null) continue;
        const w = (p.vol[k] / max) * maxW;
        const top = Math.min(y1, y2) + 1;
        const hgt = Math.max(1, Math.abs(y2 - y1) - 2);
        ctx.fillStyle = k >= p.vaLo && k <= p.vaHi ? this.colors.va : this.colors.other;
        ctx.fillRect((W - w) * hr, top * vr, w * hr, hgt * vr);
      }
      const yp = this.series.priceToCoordinate(p.lo + (p.poc + 0.5) * p.step);
      if (yp != null) {
        ctx.fillStyle = this.colors.poc;
        ctx.fillRect(0, Math.round(yp * vr) - Math.round(vr), W * hr, Math.max(2, Math.round(2 * vr)));
      }
    });
  }
}

/** 자동 삼각수렴 (점선 삼각형 + 꼭짓점 + "자동 · 참고용"). tri = findTriangle 결과 */
export class AutoTriangle extends Base {
  constructor(color) {
    super();
    this.color = color;
    this.tri = null;
    this.label = "";
    this._views = [viewOf((t) => this.draw(t), "normal")];
  }
  setData(tri, label) {
    this.tri = tri;
    this.label = label;
    this.update();
  }
  paneViews() {
    return this._views;
  }
  draw(target) {
    const g = this.tri;
    if (!this.chart || !g) return;
    const ts = this.chart.timeScale();
    const x0 = ts.logicalToCoordinate(0);
    const x1 = ts.logicalToCoordinate(1);
    if (x0 == null || x1 == null) return;
    const X = (L) => x0 + L * (x1 - x0);
    const Y = (p) => this.series.priceToCoordinate(p);
    const end = g.breakout ? Math.max(g.end, g.breakout.i) : g.apexL;
    const steps = 20;
    const up = [];
    const dn = [];
    for (let k = 0; k <= steps; k++) {
      const L = g.start + ((end - g.start) * k) / steps;
      up.push([X(L), Y(g.upAt(L))]);
      dn.push([X(L), Y(g.dnAt(L))]);
    }
    if ([...up, ...dn].some(([, y]) => y == null)) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = this.color;
      ctx.beginPath();
      [...up, ...dn.reverse()].forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      dn.reverse();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      for (const line of [up, dn]) {
        ctx.beginPath();
        line.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      const ya = Y(g.apexP);
      if (ya != null && !g.breakout) {
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(X(g.apexL), ya, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.font = '13px "Segoe UI", "Malgun Gothic", sans-serif';
      ctx.fillStyle = this.color;
      ctx.textBaseline = "bottom";
      ctx.fillText(this.label, up[0][0], Math.min(up[0][1], up[steps][1]) - 6);
    });
  }
}

/**
 * 두 점을 잇는 짧은 선 (다이버전스). 붙은 시리즈의 값 눈금으로 그린다 (RSI 창이면 RSI 값, 가격 창이면 가격).
 * segs: [{a, pa, b, pb, color, dash, label, above}] — a·b는 봉 번호, label은 b 쪽 끝에 작은 이름표
 */
export class Segments extends Base {
  constructor() {
    super();
    this.segs = [];
    this._views = [viewOf((t) => this.draw(t), "normal")];
  }
  setData(segs) {
    this.segs = segs;
    this.update();
  }
  paneViews() {
    return this._views;
  }
  draw(target) {
    if (!this.chart || !this.segs.length) return;
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.font = '12px "Segoe UI", "Malgun Gothic", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const s of this.segs) {
        if (s.b < r.from - 1 || s.a > r.to + 1) continue;
        const x1 = ts.logicalToCoordinate(s.a);
        const x2 = ts.logicalToCoordinate(s.b);
        const y1 = this.series.priceToCoordinate(s.pa);
        const y2 = this.series.priceToCoordinate(s.pb);
        if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.setLineDash(s.dash ? [6, 4] : []);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        if (!s.label) continue;
        const w = ctx.measureText(s.label).width + 8;
        if (x2 - x1 < w) continue; // 많이 줄여 봐서 선이 이름표보다 짧으면 선만 (이름표끼리 겹쳐서 안 보인다)
        const y = s.above ? y2 - 14 : y2 + 14;
        ctx.fillStyle = s.color;
        ctx.fillRect(x2 - w / 2, y - 8, w, 16);
        ctx.fillStyle = "#fff";
        ctx.fillText(s.label, x2, y + 0.5);
      }
      ctx.setLineDash([]);
    });
  }
}

/** 배경 띠 (심리 지표 단계 색 띠, 장 밖 시간). bands: [{lo, hi, color}] 가격 구간 또는 [{from, to, color}] 봉 구간 */
export class Bands extends Base {
  constructor() {
    super();
    this.price = [];
    this.time = [];
    this._views = [viewOf((t) => this.draw(t), "bottom")];
  }
  setPriceBands(b) {
    this.price = b;
    this.update();
  }
  setTimeBands(b) {
    this.time = b;
    this.update();
  }
  paneViews() {
    return this._views;
  }
  draw(target) {
    if (!this.chart) return;
    const ts = this.chart.timeScale();
    const W = ts.width();
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr, bitmapSize }) => {
      for (const b of this.price) {
        const y1 = this.series.priceToCoordinate(b.hi);
        const y2 = this.series.priceToCoordinate(b.lo);
        if (y1 == null || y2 == null) continue;
        ctx.fillStyle = b.color;
        ctx.fillRect(0, Math.min(y1, y2) * vr, W * hr, Math.abs(y2 - y1) * vr);
      }
      const r = ts.getVisibleLogicalRange();
      if (!r) return;
      const half = Math.max(1, (ts.options().barSpacing ?? 6) / 2);
      for (const b of this.time) {
        if (b.to < r.from - 1 || b.from > r.to + 1) continue;
        const x1 = ts.logicalToCoordinate(b.from);
        const x2 = ts.logicalToCoordinate(b.to);
        if (x1 == null || x2 == null) continue;
        ctx.fillStyle = b.color;
        if (b.line) ctx.fillRect(Math.round((x1 - half) * hr), 0, Math.max(1, Math.round(hr)), bitmapSize.height);
        else ctx.fillRect((x1 - half) * hr, 0, (x2 - x1 + 2 * half) * hr, bitmapSize.height);
      }
    });
  }
}
