// 장이 열려 있는지: Yahoo 분봉 실시간 갱신은 장중에만 1분마다 (SPEC §2.10 장 밖·휴장일에는 멈춘다)
// 휴장일은 "장 시작 20분이 지났는데 그날 봉이 없으면" 쉬는 날로 본다 (휴장일 표를 따로 두지 않는다)
import { DAY, tzOffset } from "./tz.js";

const H = 3600;
const closed = new Set(); // `${id}|${현지 날짜}` 쉬는 날로 판단한 날

function localParts(tz, t) {
  const l = t + tzOffset(tz, t);
  const day = Math.floor(l / DAY);
  return { day, wd: (day + 4) % 7, sec: l - day * DAY };
}

/** [열림, 닫힘] 현지 하루 중 초 (앞뒤로 조금 넉넉히) */
function hours(info) {
  if (info.tz === "Asia/Seoul") return [8.9 * H, 15.75 * H]; // 09:00~15:30 (+동시호가)
  if (info.kind === "yield") return [7.9 * H, 15.2 * H]; // ^TNX 08:20~15:00 ET
  return [9.4 * H, 16.25 * H]; // 미국 지수 09:30~16:00 ET
}

export function marketOpen(info, t = Date.now() / 1000) {
  if (info.kind === "perp") return true;
  if (info.kind === "fx" || info.kind === "future") {
    // 거의 24시간: 금요일 17시(ET) ~ 일요일 18시(ET)만 쉰다
    const { wd, sec } = localParts("America/New_York", t);
    if (wd === 6) return false;
    if (wd === 5 && sec >= 17 * H) return false;
    if (wd === 0 && sec < 18 * H) return false;
    return true;
  }
  const { day, wd, sec } = localParts(info.tz, t);
  if (wd === 0 || wd === 6) return false;
  if (closed.has(`${info.id}|${day}`)) return false;
  const [a, b] = hours(info);
  return sec >= a && sec <= b;
}

/** 받은 뒤: 장 시작 20분이 지났는데 오늘 봉이 없으면 오늘은 쉬는 날 */
export function noteLastBar(info, lastT, t = Date.now() / 1000) {
  if (info.kind === "fx" || info.kind === "future" || info.kind === "perp" || lastT == null) return;
  const now = localParts(info.tz, t);
  const last = localParts(info.tz, lastT);
  if (last.day < now.day && now.sec > hours(info)[0] + 20 * 60 + 0.1 * H) closed.add(`${info.id}|${now.day}`);
}
