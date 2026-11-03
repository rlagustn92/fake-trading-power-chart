// 심리 지표 쉬운 설명 (SPEC §2.12.1): 단계 이름·색 띠·과거 사건 표시.
// 과거 숫자는 2026-10-23에 받은 실제 데이터(Yahoo ^VIX, CBOE CSV·JSON, CNN)에서 뽑은 값이다.
// 색: 겁먹음 = 파랑, 들뜸 = 빨강 (하락 파랑·상승 빨강과 같은 느낌)
// "과거에 이랬다는 기록일 뿐, 사고팔 때를 알려주는 신호는 아닙니다."

const B1 = "rgba(61,139,255,0.10)";
const B2 = "rgba(61,139,255,0.18)";
const B3 = "rgba(61,139,255,0.28)";
const R1 = "rgba(255,77,79,0.08)";
const R2 = "rgba(255,77,79,0.16)";
const G = "rgba(160,166,174,0.05)";

export const SENTIMENT = {
  "^VIX": {
    title: "VIX: 주식시장 겁 온도계",
    one: "숫자가 클수록 사람들이 겁먹고 시장이 크게 출렁이고 있어요. (평소엔 12~20)",
    stages: [
      { lo: 0, hi: 15, name: "아주 평온", color: R1, cls: "up" },
      { lo: 15, hi: 20, name: "보통", color: G, cls: "flat" },
      { lo: 20, hi: 30, name: "불안", color: B1, cls: "down" },
      { lo: 30, hi: 40, name: "공포", color: B2, cls: "down" },
      { lo: 40, hi: 200, name: "패닉", color: B3, cls: "down" },
    ],
    events: [
      ["1998-10-08", "LTCM", 45.7],
      ["2001-09-20", "9·11", 43.7],
      ["2008-11-20", "리먼", 80.9],
      ["2011-08-08", "美 신용강등", 48.0],
      ["2015-08-24", "중국 쇼크", 40.7],
      ["2018-02-05", "볼마겟돈", 37.3],
      ["2020-03-16", "코로나", 82.7],
      ["2022-03-07", "2022 하락장", 36.5],
      ["2024-08-05", "엔캐리 청산", 38.6],
      ["2025-04-08", "2025 관세", 52.3],
    ],
    note: "1990년부터 중앙값 17.6 · 20 넘은 날 37% · 40 넘은 날 2.2%",
  },
  "cboe:PC_EQUITY": {
    title: "풋/콜 비율(주식): 떨어진다에 건 사람 ÷ 오른다에 건 사람",
    one: "1보다 크면 '떨어진다'에 건 사람이 더 많아요(겁먹음). 0.5보다 작으면 다들 '오른다'에 몰렸어요(들뜸).",
    stages: [
      { lo: 0, hi: 0.5, name: "들뜸", color: R2, cls: "up" },
      { lo: 0.5, hi: 0.8, name: "보통", color: G, cls: "flat" },
      { lo: 0.8, hi: 1.0, name: "겁", color: B1, cls: "down" },
      { lo: 1.0, hi: 10, name: "공포", color: B3, cls: "down" },
    ],
    events: [
      ["2008-09-15", "리먼", 1.18],
      ["2011-08-08", "美 신용강등", 1.07],
      ["2018-12-21", "2018-12 급락", 1.13],
      ["2020-03-12", "코로나", 1.28],
      ["2021-02-08", "밈주식 광풍", 0.39],
      ["2025-04-03", "2025 관세", 1.02],
    ],
    note: "2006년부터 중앙값 0.64 · 하루하루 출렁임이 커서 5일 평균선(주황)을 같이 봐요",
    avg: 5,
  },
  "cboe:PC_TOTAL": {
    title: "풋/콜 비율(전체): 지수 옵션 포함",
    one: "기관이 보험으로 사는 풋이 섞여 있어서 평소에도 0.9쯤이에요. 1.2보다 크면 겁먹은 거예요.",
    stages: [
      { lo: 0, hi: 0.75, name: "들뜸", color: R2, cls: "up" },
      { lo: 0.75, hi: 1.0, name: "보통", color: G, cls: "flat" },
      { lo: 1.0, hi: 1.2, name: "겁", color: B1, cls: "down" },
      { lo: 1.2, hi: 10, name: "공포", color: B3, cls: "down" },
    ],
    events: [
      ["2008-10-06", "리먼", 1.52],
      ["2018-12-20", "2018-12 급락", 1.82],
      ["2020-03-09", "코로나", 1.83],
      ["2025-04-08", "2025 관세", 1.23],
    ],
    note: "2006년부터 중앙값 0.93",
    avg: 5,
  },
  "cnn:FEAR_GREED": {
    title: "공포·탐욕 지수: 시장 분위기 점수 0~100",
    one: "0에 가까우면 다들 겁먹고 팔고 싶어 하고, 100에 가까우면 다들 신나서 사고 싶어 해요.",
    stages: [
      { lo: 0, hi: 25, name: "극단적 공포", color: B3, cls: "down" },
      { lo: 25, hi: 45, name: "공포", color: B1, cls: "down" },
      { lo: 45, hi: 55, name: "중립", color: G, cls: "flat" },
      { lo: 55, hi: 75, name: "탐욕", color: R1, cls: "up" },
      { lo: 75, hi: 100, name: "극단적 탐욕", color: R2, cls: "up" },
    ],
    events: [
      ["2021-02-12", "2021 상승장", 78],
      ["2022-05-12", "2022 하락장", 3],
      ["2023-03-15", "은행 위기", 23],
      ["2023-07-24", "AI 랠리", 83],
      ["2024-08-07", "엔캐리 청산", 17],
      ["2025-04-08", "2025 관세", 3],
    ],
    note: "CNN 기록은 2021년부터라 코로나·리먼 때 점수는 없어요 (그때는 VIX·풋/콜로)",
  },
};

export const DISCLAIMER = "과거에 이랬다는 기록일 뿐, 사고팔 때를 알려주는 신호는 아닙니다.";

export function stageOf(id, v) {
  const s = SENTIMENT[id];
  if (!s || v == null) return null;
  return s.stages.find((x) => v >= x.lo && v < x.hi) ?? s.stages[s.stages.length - 1];
}

/** 마우스를 올리면 뜨는 설명 (단계 표 + 과거 사건) */
export function sentimentTip(id) {
  const s = SENTIMENT[id];
  if (!s) return null;
  const stages = s.stages.map((x) => `${x.name} ${fmtRange(x)}`).join(" · ");
  const ev = s.events.map(([d, name, v]) => `${name} ${v}`).join(" · ");
  return `${s.title}\n${s.one}\n단계: ${stages}\n과거: ${ev}\n${s.note}\n${DISCLAIMER}`;
}

function fmtRange(x) {
  if (x.lo === 0) return `${x.hi} 아래`;
  if (x.hi >= 100 && x.lo >= 40) return `${x.lo} 넘음`;
  if (x.hi >= 10 && x.lo < 10) return `${x.lo} 넘음`;
  return `${x.lo}~${x.hi}`;
}
