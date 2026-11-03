// 관심종목 (SPEC §3.1): 이름·현재가·전일대비·고점대비 하락률. 누르면 선택된 칸이 그 종목으로.
// 끌어서 순서 바꾸기, 오른쪽 클릭으로 위·아래·삭제. Tab으로 접기.
import { h } from "./dom.js";
import { describe } from "../core/symbols.js";
import { loadSeries } from "../core/series.js";
import { num, signed, dir, decimalsFor, setText } from "./format.js";
import { openMenu } from "./menu.js";
import { stageOf, sentimentTip } from "../indicators/sentiment.js";

export function createSidebar(root, { cfg, data, estimator, onPick, onAdd, onChange, onCollapse, current }) {
  const list = h("div.sb-list");
  const head = h(
    "div.sb-head",
    h("span.sb-title", "관심종목"),
    h("span.grow"),
    h("button.sb-add", { onclick: onAdd, "data-tip-text": "종목 넣기 (차트 위에서 그냥 글자를 쳐도 돼요)" }, "＋"),
    h("button.sb-fold", { onclick: () => onCollapse?.(), "data-tip-text": "관심종목 접기 (Tab)\n차트를 넓게 써요 · 툴바 맨 왼쪽 ☰ 로 다시 펴요" }, "◀")
  );
  root.replaceChildren(head, list);
  const rows = new Map(); // id → {el, price, chg, dd}
  const ath = new Map(); // id → {max, at}

  function build() {
    rows.clear();
    list.replaceChildren(
      ...cfg.watchlist.map((id) => {
        const d = describe(id);
        const price = h("span.wl-price");
        const chg = h("span.wl-chg");
        const dd = h("span.wl-dd");
        const night = h("span.wl-night");
        const extra = h("span.wl-extra"); // RVOL · 갭 (켜고 끄기: 설정 → 화면)
        const el = h(
          "div.wl-row",
          {
            draggable: true,
            onclick: () => onPick(id),
            oncontextmenu: (e) => {
              e.preventDefault();
              rowMenu(id, e);
            },
            ondragstart: (e) => {
              e.dataTransfer.setData("text/plain", id);
              el.classList.add("dragging");
            },
            ondragend: () => el.classList.remove("dragging"),
            ondragover: (e) => {
              e.preventDefault();
              el.classList.add("drop");
            },
            ondragleave: () => el.classList.remove("drop"),
            ondrop: (e) => {
              e.preventDefault();
              el.classList.remove("drop");
              move(e.dataTransfer.getData("text/plain"), id);
            },
          },
          h("div.wl-line", h("span.wl-name", d.label), price),
          h("div.wl-line", h("span.wl-sub", d.kind === "kr" ? d.sub : d.sub || " "), chg),
          night,
          dd,
          extra
        );
        rows.set(id, { el, price, chg, dd, night, extra, info: d });
        paint(id);
        loadAth(id);
        return el;
      })
    );
    markCurrent();
  }

  function move(fromId, toId) {
    if (!fromId || fromId === toId) return;
    const w = cfg.watchlist.filter((x) => x !== fromId);
    w.splice(w.indexOf(toId), 0, fromId);
    cfg.watchlist = w;
    cfg.save();
    build();
    onChange?.();
  }

  function rowMenu(id, e) {
    const i = cfg.watchlist.indexOf(id);
    const swap = (j) => {
      if (j < 0 || j >= cfg.watchlist.length) return;
      const w = cfg.watchlist;
      [w[i], w[j]] = [w[j], w[i]];
      cfg.save();
      build();
    };
    openMenu(null, [
      { header: describe(id).label },
      { label: "▲ 위로", onclick: () => swap(i - 1), disabled: i === 0 },
      { label: "▼ 아래로", onclick: () => swap(i + 1), disabled: i === cfg.watchlist.length - 1 },
      { sep: true },
      {
        label: "관심종목에서 빼기",
        onclick: () => {
          cfg.watchlist = cfg.watchlist.filter((x) => x !== id);
          cfg.save();
          build();
          onChange?.();
        },
      },
    ], { x: e.clientX, y: e.clientY });
  }

  /** 고점대비 하락률: 저장된 일봉(수정주가)의 최고 종가 기준 */
  async function loadAth(id) {
    const d = describe(id);
    if (d.kind === "sentiment" || d.kind === "yield" || d.kind === "fx" || id === "^VIX") return;
    const old = ath.get(id);
    if (old && Date.now() - old.at < 10 * 60e3) return paint(id);
    try {
      const s = await loadSeries(d, "1D", { basis: "split" });
      if (!s.bars.length) return;
      // 레버리지·인버스 ETF는 오래 들고 가면 줄어드는 상품이라 역대 고점 대비가 의미 없음(−100%) → 52주 고점 대비
      const lev = /배|레버리지|인버스|bear|ultra|2x|3x/i.test(`${d.sub} ${d.label}`);
      const from = lev ? s.bars[s.bars.length - 1].t - 365 * 86400 : -Infinity;
      let max = 0;
      for (const b of s.bars) if (b.t >= from && b.c > max) max = b.c;
      // RVOL(일) = 마지막 날 거래량 ÷ 앞 20일 평균, 갭 = 마지막 날 시가 ÷ 그 전날 종가
      const B = s.bars;
      const lastBar = B[B.length - 1];
      const prevBar = B[B.length - 2];
      let rvol = null;
      if (d.volume && B.length > 21 && lastBar.v > 0) {
        let sum = 0;
        for (let k = B.length - 21; k < B.length - 1; k++) sum += B[k].v;
        rvol = sum > 0 ? lastBar.v / (sum / 20) : null;
      }
      const gap = prevBar?.c ? (lastBar.o / prevBar.c - 1) * 100 : null;
      ath.set(id, { max, lev, last: lastBar.c, at: Date.now(), rvol, gap, day: lastBar.t });
      paint(id);
    } catch {}
  }

  function paint(id) {
    const r = rows.get(id);
    if (!r) return;
    const q = data.quote(id);
    const a = ath.get(id);
    const price = q?.price ?? a?.last;
    const d = r.info;
    setText(r.price, price == null ? "—" : d.yieldLike ? `${num(price, 3)}%` : num(price, decimalsFor(d, price)));
    const st = stageOf(id, price);
    if (st) {
      // 심리 지표: 단계 이름 (풋/콜·공포탐욕은 % 변화가 의미 없어서 단계만)
      r.dd.className = `wl-dd ${st.cls}`;
      setText(r.dd, st.name);
      r.el.dataset.tipText = sentimentTip(id);
    }
    if (st && d.kind === "sentiment") {
      r.chg.className = "wl-chg flat";
      setText(r.chg, q?.prevClose ? `${signed(price - q.prevClose, d.id === "cnn:FEAR_GREED" ? 1 : 2)}` : "");
    } else if (price != null && q?.prevClose) {
      const ch = d.yieldLike ? (price - q.prevClose) * 100 : (price / q.prevClose - 1) * 100;
      r.chg.className = `wl-chg ${dir(ch)}`;
      setText(r.chg, d.yieldLike ? `${signed(ch, 1)}bp` : `${signed(ch, 2)}%`);
    }
    // 장이 닫힌 시간: 무기한선물로 본 24시간 추정 (SPEC §2.6)
    const e = estimator?.get(id);
    setText(r.night, e ? `야간 ${signed(e.pct, 2)}% · ${num(e.price, decimalsFor(d, e.price))}` : "");
    r.night.dataset.tipText = e ? `24시간 추정가 ${num(e.price, decimalsFor(d, e.price))}
${e.via} 무기한선물이 마감 뒤 움직인 만큼으로 계산
정규장이 열리면 사라져요` : "";
    if (a?.max && price != null) {
      const dd = (price / a.max - 1) * 100;
      r.dd.className = `wl-dd ${dd > -0.05 ? "ath" : dd > -10 ? "dd1" : dd > -30 ? "dd2" : "dd3"}`;
      setText(r.dd, dd > -0.05 ? (a.lev ? "52주 고점 근처" : "고점 근처") : `${a.lev ? "52주고점대비" : "고점대비"} ${num(dd, dd < -99 ? 2 : 1)}%`);
    }
    if (cfg.layout.wl_extra ?? true) {
      const parts = [];
      if (a?.rvol != null) parts.push(`RVOL ${num(a.rvol, 1)}`);
      if (a?.gap != null && Math.abs(a.gap) >= 0.05) parts.push(`갭 ${signed(a.gap, 1)}%`);
      setText(r.extra, parts.join(" · "));
      r.extra.className = `wl-extra${a?.rvol >= 2 ? " hot" : ""}`;
      r.extra.dataset.tipText = parts.length ? "RVOL = 마지막 날(오늘이면 지금까지) 거래량 ÷ 지난 20일 평균 · 2 넘으면 주황\n갭 = 그날 시가가 전날 종가보다 몇 % 높게(낮게) 시작했는지\n10분마다 새로 계산해요" : "";
    } else setText(r.extra, "");
  }

  function markCurrent() {
    const id = current();
    for (const [k, r] of rows) r.el.classList.toggle("cur", k === id);
  }

  data.on("quote", ({ id }) => paint(id));
  estimator?.on(({ id }) => paint(id));
  data.on("bars", ({ id, tf }) => tf === "1D" && rows.has(id) && (ath.delete(id), loadAth(id)));

  build();
  return { build, markCurrent, paintAll: () => rows.forEach((_, id) => paint(id)) };
}
