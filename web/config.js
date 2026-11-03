// 설정: 앱에 포함된 기본값 위에 이 PC의 config.json을 덮어쓴다 (설정은 PC마다 따로, SPEC §5).
import { loadFile, saveFile } from "./platform.js";

const FILE = "config.json";

function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]);
  return out;
}

let saveTimer = 0;

// 2026-10-24: 기본 지표를 "없음"으로 바꿨다. 예전에 자동으로 들어간 6개(SMA 20·200, 볼린저, 거래량, RSI, 낙폭)만
// 모든 칸에서 한 번 빼고, 사용자가 직접 넣은 지표는 그대로 둔다. 예전 조합은 지표 패널 프리셋으로 다시 넣을 수 있다.
const OLD_DEFAULT = [{"id": "sma", "params": {"length": 20}, "color": "#f5c542", "width": 1}, {"id": "sma", "params": {"length": 200}, "color": "#b18cff", "width": 2}, {"id": "bb", "params": {"length": 20, "mult": 2}, "color": "#5ec8d8", "width": 1}, {"id": "volume", "params": {"ma": 20}}, {"id": "rsi", "params": {"length": 14}}, {"id": "drawdown", "params": {}}];
function dropOldDefaultIndicators(cfg) {
  if (cfg.migrated?.no_default_ind) return;
  // 저장된 값에는 기본 파라미터(tf:"", hi:70 …)가 더 붙어 있다 → 예전 기본의 값이 모두 같고 다른 봉(tf)을 안 쓰면 같은 것으로 본다
  const isOld = (x) => !x.params?.tf && OLD_DEFAULT.some((o) => o.id === x.id && Object.entries(o.params).every(([k, v]) => x.params?.[k] === v));
  const clean = (list) => (Array.isArray(list) ? list.filter((x) => !isOld(x)) : list);
  cfg.indicators = clean(cfg.indicators);
  for (const L of Object.values(cfg.grid?.layouts ?? {})) for (const c of L.cells ?? []) if (c.indicators) c.indicators = clean(c.indicators);
  cfg.migrated = { ...cfg.migrated, no_default_ind: true };
}

export async function loadConfig() {
  const defaults = await (await fetch("data/default_config.json")).json();
  const user = await loadFile(FILE);
  const cfg = merge(defaults, user ?? {});
  cfg.defaults = () => structuredClone(defaults);
  dropOldDefaultIndicators(cfg);
  // 2026-10-24: 분할 화면에서 봉은 칸마다 따로가 기본 (한 칸만 15분봉으로 바꿔도 다른 칸은 그대로). 켜려면 보기 ▾ → 분할 화면 동기화 → 봉
  if (!cfg.migrated?.no_interval_sync) {
    if (cfg.grid?.sync) cfg.grid.sync.interval = false;
    for (const L of Object.values(cfg.grid?.layouts ?? {})) if (L.sync) L.sync.interval = false;
    cfg.migrated = { ...cfg.migrated, no_interval_sync: true };
  }
  // 2026-10-24: 줌·이동(시점)도 칸마다 따로가 기본 (SOXL 5분·15분·1시간을 각각 다르게 보기)
  if (!cfg.migrated?.no_time_sync) {
    if (cfg.grid?.sync) cfg.grid.sync.time = false;
    for (const L of Object.values(cfg.grid?.layouts ?? {})) if (L.sync) L.sync.time = false;
    cfg.migrated = { ...cfg.migrated, no_time_sync: true };
  }

  // 2026-10-25: 차트의 FOMC 표시는 기본 끔(거슬린다는 의견), 그리기 도구는 한 번 고르면 계속 그리기가 기본
  if (!cfg.migrated?.fomc_off) {
    cfg.chart.show_fomc = false;
    if (cfg.chart.show_events === false) cfg.chart.show_earn = false;
    cfg.chart.keep_draw_tool = true;
    cfg.migrated = { ...cfg.migrated, fomc_off: true };
  }

  const plain = () => {
    const { save, saveNow, defaults: _d, ...rest } = cfg;
    return rest;
  };
  // 저장은 묶어서 한 번에 (드래그·연타로 디스크를 두드리지 않게). 저장 버튼 없이 바꾸면 바로 저장(SPEC §0.2)
  cfg.save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveFile(FILE, plain()), 500);
  };
  cfg.saveNow = async () => {
    clearTimeout(saveTimer);
    await saveFile(FILE, plain());
  };
  return cfg;
}
