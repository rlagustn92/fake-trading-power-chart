// 설정 (SPEC §5): 화면 · 차트 · 데이터 · 도움말. 바꾸면 바로 반영되고 저장 버튼이 없다(SPEC §0.2).
import { h, stepper, toggle, segment } from "./dom.js";
import { invoke, appVersion } from "../platform.js";
import * as A from "../sources/alpaca.js";
import * as TS from "../sources/toss.js";
import * as db from "../core/db.js";
import { describe } from "../core/symbols.js";
import { ymd } from "../core/tz.js";
import { num } from "./format.js";
import { confirmBox, toast } from "./dialog.js";

const TF_ORDER = ["1D", "1W", "1h", "4h", "30m", "15m", "5m", "1m"];

/** Alpaca 키 저장 실패 이유를 알아듣기 쉽게 */
function alpacaHint(err) {
  if (/401|403|forbidden|unauthorized/i.test(err)) return `키가 맞지 않아요. 알파카 대시보드에서 Key ID와 Secret을 다시 복사해 붙여넣어 주세요(앞뒤 공백 주의). (${err})`;
  if (/요청 실패|timed out|connect/.test(err)) return `알파카 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요. (${err})`;
  return err;
}

export function createSettings(root, app) {
  const { cfg } = app;
  let tab = "화면";
  const TABS = ["화면", "차트", "데이터", "도움말"];
  const tabBar = h("div.tabs");
  const body = h("div.set-body");
  const ver = h("span.muted.set-ver");
  appVersion().then((v) => (ver.textContent = `버전 ${v}`));
  const updBtn = h("button", { onclick: () => app.checkUpdate?.(), "data-tip-text": "GitHub에 새 버전이 있는지 봐요\n있으면 바뀐 것을 보고 받고 다시 켤 수 있어요 (데이터·거래 기록은 그대로)" }, "🆕 새 버전 확인");
  root.replaceChildren(h("div.panel.settings", h("div.pick-head", h("h2", "설정"), ver, updBtn, h("span.grow"), h("button.primary", { onclick: () => close() }, "닫기")), tabBar, body));
  root.addEventListener("pointerdown", (e) => e.target === root && close());

  const row = (label, ...ctrl) => h("div.set-row", h("span.set-label", label), ...ctrl);
  const note = (text) => h("p.hint", text);

  function screenTab() {
    return [
      row("글씨 크기", stepper(() => cfg.font.scale, (v) => app.setFontScale(v), { step: 0.05, min: 0.5, max: 2, fmt: (v) => `${Math.round(v * 100)}%`, parse: (t) => parseFloat(t) / 100 }), note("Ctrl + / Ctrl − 로도 바꿀 수 있어요")),
      row("관심종목", toggle(() => cfg.layout.sidebar_visible, (v) => app.setSidebar(v), "보이기"), note("Tab 키로 접고 펴요")),
      row("관심종목 RVOL·갭", toggle(() => cfg.layout.wl_extra ?? true, (v) => ((cfg.layout.wl_extra = v), cfg.save(), app.repaintWatch?.()), "보이기"), note("거래량이 평소의 몇 배인지(RVOL)와 시작 갭 %")),
      row("전체화면", h("button", { onclick: () => app.toggleFullscreen() }, "전체화면 켜기/끄기 (F11)"), note("전체화면으로 끄면 다음에도 그 모니터에 전체화면으로 켜져요")),
      row("새 버전 알림", toggle(() => cfg.update_notify ?? true, (v) => ((cfg.update_notify = v), cfg.save()), "켜기"), note("켤 때·12시간마다 GitHub에 새 버전이 있는지 보고 알려 줘요 (맨 위 '🆕 새 버전 확인'은 늘 돼요)")),
    ];
  }

  function chartTab() {
    const c = cfg.chart;
    const set = (k) => (v) => {
      c[k] = v;
      cfg.save();
      app.redrawAll();
    };
    return [
      // 한국식·미국식 (0.13.0, 사용자 요청: "한국놈들식 미국놈들식 자유자재로")
      row(
        "봉 색",
        segment([["kr", "한국식 (빨강 오름)"], ["us", "미국식 (초록 오름)"]], () => c.candle_style ?? "kr", (v) => {
          c.candle_style = v;
          cfg.save();
          app.setCandleStyle?.(v);
        }),
        note("한국식 = 오르면 빨강·내리면 파랑, 미국식 = 오르면 초록·내리면 빨강. 차트 봉·거래량·매수/매도 버튼·롱/숏 선·거래 기록 손익 색이 같이 바뀌어요")
      ),
      row("기본 가격 기준", segment([["split", "수정주가"], ["total", "배당 포함"], ["raw", "실제 거래가"]], () => c.price_basis, set("price_basis"))),
      note("수정주가 = 분할·병합을 반영해 처음부터 이어지는 가격(TradingView 기본). 칸마다 보기 ▾에서 따로 바꿀 수도 있어요."),
      row("일·주봉 눈금", segment([["log", "로그"], ["normal", "일반"], ["pct", "%"]], () => c.scale_daily, set("scale_daily"))),
      row("분봉 눈금", segment([["normal", "일반"], ["log", "로그"], ["pct", "%"]], () => c.scale_intraday, set("scale_intraday"))),
      row("미국 분봉", segment([[true, "정규장만"], [false, "프리·애프터 포함"]], () => c.regular_hours_only, set("regular_hours_only"))),
      row("분할·병합 표시", toggle(() => c.show_split_markers, set("show_split_markers"))),
      row("세션 구분선", toggle(() => c.session_breaks, set("session_breaks"))),
      row("심리 지표 설명", toggle(() => c.show_sentiment_events, set("show_sentiment_events")), note("VIX·풋/콜·공포탐욕에 단계 색 띠와 과거 사건 표시")),
      row("FOMC 날짜 표시", toggle(() => c.show_fomc ?? false, set("show_fomc")), note("차트 아래에 보라색 FOMC 표시 (보기 ▾에서도 켜고 꺼요)")),
      row("실적 발표일 표시", toggle(() => c.show_earn ?? true, set("show_earn")), note("차트 아래에 주황색 실적 표시 + 범례에 다음 실적일")),
      row("주요 지표 알림", toggle(() => c.show_events ?? true, set("show_events")), note("FOMC·CPI·고용 같은 미국 주요 지표 발표 30분 전에 알려 줘요")),
    ];
  }

  function dataTab() {
    const keyBox = h("div");
    const paintKey = async () => {
      const s = await A.keyStatus();
      const idIn = h("input", { placeholder: "API Key ID", autocomplete: "off", spellcheck: false });
      const secIn = h("input", { type: "password", placeholder: "Secret Key", autocomplete: "off" });
      const out = h("p.hint");
      const save = h("button.primary", {
        onclick: async () => {
          save.disabled = true;
          out.textContent = "확인 중…";
          try {
            await A.saveKey(idIn.value, secIn.value);
            toast("알파카 키를 저장했어요. 이제 미국 주식 분봉을 받을 수 있어요.");
            app.onAlpacaKey();
            paintKey();
          } catch (e) {
            out.textContent = alpacaHint(String(e?.message ?? e));
            save.disabled = false;
          }
        },
      }, "저장하고 확인");
      keyBox.replaceChildren(
        h("h3", "알파카 (미국 주식·ETF 분봉)"),
        ...(s.saved
          ? [row("저장된 키", h("b", s.hint ?? "••••"), h("button", { onclick: async () => { if (await confirmBox("알파카 키를 지울까요?", "이 PC에서만 지워져요.", { ok: "지우기", danger: true })) { await A.deleteKey(); paintKey(); } } }, "키 지우기"))]
          : [row("Key ID", idIn), row("Secret", secIn), h("div.set-row", save), out]),
        h(
          "div.safe",
          "🔐 키는 이 PC의 Windows 자격 증명 관리자에만 저장돼요(파일·로그에 없음).",
          h("ul", h("li", "앱은 시세(봉·현재가·분할) 주소와 실시간 체결 스트림만 쓰고, 주문·계좌 주소는 아예 들어 있지 않아요."), h("li", "무료 플랜 한도(분당 200번)보다 낮게 분당 150번까지만 불러요. 실시간 체결은 연결 1개·30종목까지 (한도와 따로 세요)."), h("li", "키는 알파카 대시보드 → API Keys에서 만들어요(Paper/Live 상관없이 시세는 같아요)."))
        )
      );
    };
    paintKey();

    // ── 토스 (국내 실시간): Market Board와 같은 키·토큰을 같이 쓴다 ──
    const tossBox = h("div");
    const paintToss = async () => {
      const s = await TS.keyStatus();
      const idIn = h("input", { placeholder: "client_id", autocomplete: "off", spellcheck: false });
      const secIn = h("input", { type: "password", placeholder: "client_secret", autocomplete: "off" });
      const out = h("p.hint");
      const save = h("button.primary", {
        onclick: async () => {
          save.disabled = true;
          out.textContent = "확인 중…";
          try {
            await TS.saveKey(idIn.value, secIn.value);
            toast("토스 키를 저장했어요. 국내 주식이 장중에 실시간으로 움직여요.");
            paintToss();
          } catch (e) {
            out.textContent = String(e?.message ?? e);
            save.disabled = false;
          }
        },
      }, "저장하고 확인");
      tossBox.replaceChildren(
        h("h3", "토스 (국내 주식 실시간)"),
        ...(s.saved
          ? [row("키", h("b", s.hint ?? "••••"), h("span.hint", s.standby ? "⏸ 다른 PC에서 쓰는 중 → Yahoo로 대신 보여줘요 (그 PC가 놓으면 자동으로 돌아와요)" : "✓ 사용 중 · Market Board와 같은 키"))]
          : [note("Market Board에 토스 키를 넣었다면 여기서는 따로 넣지 않아도 돼요(같은 키를 같이 써요). 없으면 여기서 넣어도 Market Board와 같이 쓰게 저장돼요."), row("client_id", idIn), row("client_secret", secIn), h("div.set-row", save), out]),
        h("div.safe", "🔐 Market Board와 토큰 하나를 같이 써서 서로 끊지 않아요. 다른 PC가 가져가면 이 앱은 물러나고(Yahoo로 대신), 스스로 다시 뺏지 않아요.", h("ul", h("li", "시세(현재가·1분봉) 주소 3개만 부를 수 있고, 계좌·주문 주소는 아예 없어요."), h("li", "장중(09:00~15:30)에만 2초마다 현재가를 받아요.")))
      );
    };
    paintToss();

    const prog = h("p.hint");
    const all = h("button.primary", {
      onclick: async () => {
        all.disabled = true;
        const t0 = Date.now();
        await app.data.downloadAll(cfg.watchlist, (i, n, info) => {
          const left = i > 1 ? Math.round((((Date.now() - t0) / (i - 1)) * (n - i + 1)) / 60000) : null;
          prog.textContent = `${i}/${n} ${info.label} 받는 중${left != null ? ` · 남은 시간 약 ${left}분` : ""}`;
        });
        prog.textContent = "다 받았어요 ✓";
        all.disabled = false;
        paintCoverage();
      },
    }, "관심종목 전체 받기");

    const cov = h("div.cov");
    const size = h("span.muted");
    const paintCoverage = async () => {
      size.textContent = `저장소 크기 ${num((await db.dbSize()) / 1048576, 1)}MB`;
      const rows = await db.coverage();
      const bySym = new Map();
      for (const r of rows) {
        if (!bySym.has(r.sym)) bySym.set(r.sym, []);
        bySym.get(r.sym).push(r);
      }
      cov.replaceChildren(
        ...[...bySym].map(([sym, list]) => {
          list.sort((a, b) => TF_ORDER.indexOf(a.tf) - TF_ORDER.indexOf(b.tf));
          const d = describe(sym);
          const gapEl = h("span.cov-gap");
          // 미국 분봉: 5일 넘게 빈 곳(받다가 끊긴 곳)이나 끝부분이 오래됐으면 표시 + 채우기
          if (d.intraday === "alpaca") {
            (async () => {
              const bad = [];
              for (const r of list.filter((x) => x.tf === "5m" || x.tf === "1m")) {
                const g = await db.gaps(sym, r.tf, 5 * 86400).catch(() => []);
                const stale = Date.now() / 1000 - r.last > 5 * 86400;
                if (g.length || stale) bad.push({ tf: r.tf, n: g.length, stale });
              }
              if (!bad.length) return;
              gapEl.replaceChildren(
                h("span.bt-warn", `⚠ ${bad.map((b) => `${b.tf} ${b.n ? `빈 곳 ${b.n}군데` : ""}${b.stale ? `${b.n ? " · " : ""}끝부분 오래됨` : ""}`).join(" / ")}`),
                h("button", {
                  onclick: async (e) => {
                    e.target.disabled = true;
                    e.target.textContent = "채우는 중…";
                    for (const b of bad) await app.data.fillGaps(sym, b.tf);
                    paintCoverage();
                  },
                }, "빈 곳 채우기")
              );
            })();
          }
          return h(
            "div.cov-row",
            h("b.cov-sym", d.label),
            h("span.cov-list", list.map((r) => h("span.cov-tf", `${r.tf} ${num(r.count, 0)}개 (${ymd(r.first)}~${ymd(r.last)})`))),
            gapEl,
            h("button", {
              onclick: async () => {
                if (!(await confirmBox(`${d.label} 데이터를 지울까요?`, "다음에 볼 때 다시 받아요. 그린 선은 지워지지 않아요.", { ok: "지우기", danger: true }))) return;
                await db.deleteSymbol(sym);
                paintCoverage();
              },
            }, "지우기")
          );
        })
      );
    };
    paintCoverage();

    // ── 다른 PC로 옮기기: 받아 둔 차트 데이터 + 관심종목·화면·그린 것 (키는 PC마다 다시 넣기) ──
    const moveOut = h("p.hint.pre");
    const backups = h("div.cov");
    const p2 = (x) => String(x).padStart(2, "0");
    const makeBackup = h("button.primary", {
      onclick: async () => {
        makeBackup.disabled = true;
        moveOut.textContent = "백업 만드는 중… (데이터가 크면 1분쯤 걸려요)";
        const d = new Date();
        const name = `FAKE-TRADING-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
        try {
          const path = await invoke("backup_create", { name });
          moveOut.textContent = `다 만들었어요 ✓ ${path}\n이 폴더를 USB 등으로 옮긴 뒤, 다른 PC의 '문서\\FAKE TRADING POWER CHART\\백업' 폴더에 넣고 그 PC에서 '백업 가져오기'를 누르세요.`;
        } catch (e) {
          moveOut.textContent = `만들지 못했어요 (${e?.message ?? e})`;
        }
        makeBackup.disabled = false;
        paintBackups();
      },
    }, "💾 백업 만들기");
    /** 어디에 있든: 파일 고르기 창에서 market.db를 고른다 */
    const pickFile = h("button", {
      onclick: async () => {
        moveOut.textContent = "파일 고르는 중…";
        try {
          const path = await invoke("backup_import_file", {});
          if (!path) return (moveOut.textContent = "");
          moveOut.textContent = `준비됐어요 ✓ ${path}\n앱을 껐다 켜면 가져온 데이터로 바뀌어요 (지금 것은 market.db.old로 하나 남겨 둬요).`;
          if (await confirmBox("앱을 지금 끌까요?", "다시 켜면 가져온 데이터로 열려요.", { ok: "지금 끄기" })) invoke("quit_app", {});
        } catch (e) {
          moveOut.textContent = `가져오지 못했어요 (${e?.message ?? e})`;
        }
      },
      "data-tip-text": "USB·바탕화면 등 어디에 있든 백업 폴더 안의 market.db를 골라요\n같은 폴더의 관심종목·화면(config.json)·그린 것(drawings.json)·모의매매 기록(trades.json)도 같이 가져와요",
    }, "📂 파일에서 가져오기");
    const paintBackups = async () => {
      const list = await invoke("backup_list", {}).catch(() => []);
      backups.replaceChildren(
        ...(list.length
          ? list.map((b) =>
              h(
                "div.cov-row",
                h("b.cov-sym", b.name.replace(/^FAKE-TRADING-/, "")),
                h("span.cov-list", `${num(b.size / 1048576, 0)}MB`),
                h("button", {
                  onclick: async () => {
                    if (!(await confirmBox(`${b.name} 백업을 가져올까요?`, "지금 이 PC의 차트 데이터·관심종목·화면이 백업 것으로 바뀌어요 (지금 것은 market.db.old로 하나 남겨 둬요). 키는 그대로예요.", { ok: "가져오기", danger: true }))) return;
                    moveOut.textContent = "복사하는 중…";
                    try {
                      await invoke("backup_restore", { name: b.name });
                    } catch (e) {
                      moveOut.textContent = `가져오지 못했어요 (${e?.message ?? e})`;
                      return;
                    }
                    moveOut.textContent = "준비됐어요 ✓ 앱을 껐다 켜면 바뀌어요.";
                    if (await confirmBox("앱을 지금 끌까요?", "다시 켜면 가져온 데이터로 열려요.", { ok: "지금 끄기" })) invoke("quit_app", {});
                  },
                }, "가져오기")
              )
            )
          : [note("'문서\\FAKE TRADING POWER CHART\\백업' 폴더에 백업이 없어요. 다른 PC에서 만든 백업 폴더를 거기에 넣으면 여기 보여요.")])
      );
    };
    paintBackups();

    return [
      keyBox,
      tossBox,
      h("h3", "24시간 추정가"),
      row("야간 추정", toggle(() => cfg.perp.enabled ?? true, (v) => ((cfg.perp.enabled = v), cfg.save(), app.onPerpToggle?.())), note("장이 닫힌 시간에 무기한선물(Binance·Hyperliquid) 변화율로 '지금 어디쯤'을 추정해요")),
      note("관심종목에 주황 '야간 ±%', 차트에 주황 점선. 정규장이 열리면 사라지고, 저장하지 않아요."),
      h("h3", "데이터 받기"),
      row("켤 때 이어 받기", toggle(() => cfg.data.auto_update, (v) => ((cfg.data.auto_update = v), cfg.save()))),
      note("한 번 받은 데이터는 이 PC에 쌓아 두고, 다음부터는 새로 생긴 부분만 받아요."),
      h("div.set-row", all, prog),
      note("미국 종목은 5분봉(2016년부터)·1분봉(최근 12개월)까지 받아요. 최근 것부터 먼저 보이고, 과거는 3갈래로 나눠 함께 받아요. 중간에 꺼도 다음에 이어서 받아요."),
      h("h3", "다른 PC로 옮기기"),
      note("받아 둔 차트 데이터와 관심종목·저장한 화면·그린 것·💰 모의매매 계좌와 거래 기록을 한 폴더로 묶어요. 새 PC에서 처음부터 받지 않아도 돼요. (알파카·토스 키는 옮겨지지 않아요 → 새 PC에서 다시 넣기)"),
      h("div.set-row", makeBackup, pickFile, h("button", { onclick: () => invoke("open_folder", { which: "backups" }) }, "백업 폴더 열기"), h("button", { onclick: () => paintBackups() }, "다시 찾기")),
      note("새 PC에서 가장 쉬운 방법: EXE와 같은 폴더에 백업 폴더(FAKE-TRADING-날짜)를 같이 두고 처음 켜면 알아서 가져와요. 이미 데이터가 있는 PC에서는 덮어쓰지 않아요 → '📂 파일에서 가져오기'"),
      moveOut,
      h("p.set-label", "가져올 수 있는 백업"),
      backups,
      h("h3", "저장된 데이터"),
      h("div.set-row", size, h("button", { onclick: () => invoke("open_folder", { which: "data" }) }, "데이터 폴더 열기"), h("button", { onclick: async () => { await db.vacuum(); paintCoverage(); } }, "빈 공간 정리")),
      cov,
    ];
  }

  function helpTab() {
    const keys = [
      ["글자·숫자 입력", "차트 위에서 그냥 치면 종목 찾기 (예: SOXL, MU, 삼성, 247540, ㅅㅅ)"],
      ["Alt + 1 ~ 7", "봉 바꾸기 (1분·5분·15분·1시간·4시간·일·주) · 숫자 하나만 치고 Enter도 돼요"],
      ["/", "종목 찾기"],
      ["Alt + L", "로그 눈금 켜기/끄기"],
      ["Alt + M", "📏 구간 측정 (Shift + 드래그로도 바로)"],
      ["Ctrl + I", "지표 패널"],
      ["Ctrl + B", "백테스트 화면"],
      ["Ctrl + ,", "설정"],
      ["Tab", "관심종목 접기/펴기"],
      ["↑ ↓", "관심종목 위·아래 종목으로"],
      ["F11", "전체화면"],
      ["Ctrl + / −", "글씨 크게·작게"],
      ["더블클릭", "분할 화면에서 그 칸만 크게 (Esc로 돌아가기)"],
      ["Space · →", "▶ 바 리플레이 중: 재생/멈춤 · 한 봉 앞으로 (보기 ▾ → ▶ 바 리플레이)"],
      ["Alt + T·I·H·J·F·G·A", "그리기: 추세선·인포선·수평선·수평 반직선·피보나치·삼각수렴·앵커드 VWAP"],
      ["Delete", "선택한 그림 지우기"],
      ["Ctrl + G", "📅 날짜로 가기 (분할 화면: 이 칸 · 모두 · Ctrl+클릭으로 고른 칸)"],
      ["Ctrl + 클릭", "분할 화면에서 칸 여러 개 고르기 (지표 맞추기·날짜로 가기 대상)"],
      ["이름 줄 끌기", "분할 화면 칸 자리 바꾸기 · ✕ = 칸 비우기"],
      ["Esc", "닫기 · 그리기 취소 · 리플레이 끝내기"],
    ];
    return [
      h("div.set-row", h("button", { onclick: () => (close(), app.showWelcome?.()) }, "👋 처음 안내 다시 보기")),
      h("h3", "단축키"),
      h("table.keys", keys.map(([k, v]) => h("tr", h("td", h("kbd", k)), h("td", v)))),
    ];
  }

  function render() {
    tabBar.replaceChildren(...TABS.map((t) => h(`button${t === tab ? ".on" : ""}`, { onclick: () => ((tab = t), render()) }, t)));
    body.replaceChildren(...[].concat(tab === "화면" ? screenTab() : tab === "차트" ? chartTab() : tab === "데이터" ? dataTab() : helpTab()));
  }

  let onClosed = null;
  /** t = 처음 보일 탭, then = 닫힐 때 한 번 (예: 첫 실행 안내가 잠깐 비켜 있다가 돌아오기) */
  function open(t, then = null) {
    if (t) tab = t;
    onClosed = then;
    root.hidden = false;
    render();
  }
  function close() {
    root.hidden = true;
    const f = onClosed;
    onClosed = null;
    f?.();
  }
  return {
    open,
    close,
    get isOpen() {
      return !root.hidden;
    },
  };
}
