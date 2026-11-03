# 유지보수 — 해마다 할 일과 경제 자료 받는 법

몇 년 뒤에 보는 사람(또는 AI)을 위한 메모. 상태 줄의 `🏦 FOMC …`·`📈 CPI …`, 차트의 FOMC·실적 표시, 발표 30분 전 알림이 어디서 어떻게 오는지, 해마다 손볼 것은 무엇인지 적어 둔다.
코드는 거의 다 `web/core/events.js` 한 파일에 있다.

## 한눈에

| 무엇 | 해마다 할 일 |
|---|---|
| FOMC 회의 날짜 | **없음.** 연준 홈페이지에서 자동으로 받는다 |
| FOMC 예상·직전 결과, 지금 기준금리 | **없음.** 자동 |
| CPI 숫자(예상·직전) | **없음.** 자동 (클리블랜드 연준) |
| **CPI 발표 날짜** | **해마다 한 번 손으로** (10~12월쯤, 5분). 아래 "CPI 발표 날짜 넣기" |

CPI 날짜를 안 넣어도 프로그램은 멈추지 않는다. 표가 끝나면 상태 줄에 `📈 CPI 1월 중순 (…)`처럼 대략 보여 주고, 발표하는 주가 되면 ForexFactory에서 정확한 날짜·시각이 자동으로 들어온다. 그해 10월부터 다음 해 날짜가 없으면 CPI 칸에 마우스를 올렸을 때 "내년 CPI 날짜를 넣어 주세요" 안내가 나온다.

---

## CPI 발표 날짜 넣기 (해마다 한 번)

**왜 손으로?** 날짜를 정하는 노동통계국(BLS) 사이트가 프로그램 접속을 막는다(403). 그 밖에 자동으로 읽을 만한 곳이 없다 (아래 "막힌 곳").

1. **다음 해 일정표 찾기** — 백악관 예산관리국(OMB)이 해마다 10월쯤 내는 PDF
   - 이름: *Schedule of Release Dates for Principal Federal Economic Indicators for 2028*
   - 검색어: `"Schedule of Release Dates for Principal Federal Economic Indicators" 2028`
   - 2027년 것 주소: https://www.whitehouse.gov/wp-content/uploads/2026/10/FY2027-PFEI.pdf
     (꼴: `whitehouse.gov/wp-content/uploads/<올린 해>/<올린 달>/FY<다음 해>-PFEI.pdf` — 바뀔 수 있으니 안 열리면 검색)
   - 또는 BLS 일정표 https://www.bls.gov/schedule/news_release/cpi.htm (사람이 브라우저로 열면 보인다. 프로그램은 막힘)
2. **CPI 줄 읽기** — PDF 4쪽쯤 `LABOR → BUREAU OF LABOR STATISTICS → Consumer Price Index` 줄의 JAN~DEC 숫자 12개
   - 예: 2027년은 `13 11 10 13 12 10 14 11 14 14 10 10`
3. **표에 더하기** — `web/core/events.js`의 `const CPI = [ … ]`에 `"YYYY-MM-DD"` 12개를 한 줄로 더한다 (뉴욕 날짜. 시각 08:30 ET는 코드가 붙인다)
   ```js
   "2028-01-12", "2028-02-10", … // 2028
   ```
4. **확인** — `python tools/devserver.py 5180` → http://localhost:5180/tests/test.html 이 모두 맞음, 앱 상태 줄 CPI가 "N월 중순"이 아니라 날짜로 나오는지
5. **EXE 다시 만들기** — `cd src-tauri` → `cargo tauri build --no-bundle` (켜져 있으면 실행 중인 exe 이름을 `.old.exe`로 바꾸고 빌드)

AI에게 맡길 때: *"MAINTENANCE.md 보고 2028년 CPI 발표 날짜 넣어줘"* 라고 하면 된다.

---

## FOMC 회의 날짜 (자동 — 할 일 없음)

- 출처: 연준 공식 일정 페이지 https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm (키 필요 없음, 아무 프로그램이나 열림)
- 연준은 다음 해 일정을 보통 그해 여름쯤 올린다 (2026-10에 이미 2027년 8번이 있었다)
- 일주일에 한 번 읽어서 `%APPDATA%\power-chart-and-backtest\fomc_dates.json`에 보관 → `parseFedCalendar()`가 해마다 `20xx FOMC Meetings` 칸의 `fomc-meeting__month`·`fomc-meeting__date`를 읽어 **결정일(이틀 회의의 둘째 날)** 로 바꾼다
  - `Apr/May 30-1` → 5월 1일, `(notation vote)`(표결만 하는 날)은 뺀다
  - 올해 회의가 4개 이상 읽혀야만 받아들인다 (페이지 모양이 바뀌어 엉터리로 읽는 것 막기). 못 읽으면 마지막으로 제대로 받은 날짜 → 그것도 없으면 코드의 기본 표 `const FOMC`
- **연준이 페이지 모양을 바꿨을 때 증상**: 다음 해 FOMC가 상태 줄에 안 나온다 / 차트 FOMC 표시가 기본 표 이후로 없다
  - 고치기: 페이지 HTML을 보고 `parseFedCalendar`의 정규식을 맞춘다 → `web/tests/tests.js`의 "연준 일정 페이지 읽기" 시험도 새 모양으로
  - 급하면 `const FOMC` 표에 결정일을 직접 더해도 된다

---

## 자료 출처 (모두 무료, 키 필요 없음)

| 화면에 보이는 것 | 출처 | 주소 |
|---|---|---|
| FOMC 직전 결과(인상·동결·인하), 지금 기준금리·실효 금리 | 뉴욕 연준 공식 금리 API | `https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json?startDate=…&endDate=…` (`targetRateFrom/To`가 바뀐 날 = 결정 다음 날) |
| FOMC 예상 (회의가 있는 주) | ForexFactory 경제 캘린더 | `https://nfs.faireconomy.media/ff_calendar_thisweek.json` 의 `Federal Funds Rate` — `forecast`와 `previous`가 같으면 동결 |
| FOMC 예상 (그 밖의 때) "동결 90%" | Yahoo 30일 연방기금 선물 | 기호 `ZQ{달 글자}{연도 두 자리}.CBT` (달 글자 `FGHJKMNQUVXZ`, 예: 2026년 11월 = `ZQX26.CBT`). CME FedWatch와 같은 계산: 달 후반 회의는 다음 달 선물, 전반 회의는 그 달 선물에서 회의 전 날수를 빼서 |
| CPI 직전(실제)·예상 | 클리블랜드 연준 인플레이션 나우캐스트 | `https://www.clevelandfed.org/-/media/files/webcharts/inflationnowcasting/nowcast_year.json?sc_lang=en` (전년 대비 %. 배열 마지막 = 아직 발표 안 된 달의 예측 `CPI Inflation`, 실제 값은 `Actual CPI Inflation`. 압축해 약 350KB, 풀면 7MB) |
| CPI 시장 예상 (발표하는 주) | ForexFactory | 위 JSON의 `CPI y/y` |
| 이번 주 주요 지표·30분 전 알림 | ForexFactory | 위 JSON (미국·영향 High만) |
| 실적 발표일 | Nasdaq | `api.nasdaq.com/api/company/<종목>/earnings-surprise`, `…/analyst/<종목>/earnings-date` |

새 주소를 쓰려면 **두 곳 모두** 허용 목록에 더한다: `src-tauri/capabilities/default.json`(EXE) + `tools/devserver.py`의 `ALLOWED_HOSTS`(개발 서버).

## 얼마나 자주 받나 (`events.js`의 `due()`)

한 달에 한 번 나오는 자료라 자주 받지 않는다.

- **켤 때**: 받은 지 하루가 넘었을 때만
- **🔄 지금 업데이트**: 받은 지 1시간이 넘은 것만 (`forceEconRefresh()`)
- **발표 직후 한 번**: CPI 발표 1시간 뒤(클리블랜드), FOMC 1시간 뒤(선물)·이틀 뒤(뉴욕 연준에 새 금리가 올라오는 때)
- **켜 둔 채로**: ForexFactory·금리·선물 하루 한 번(ForexFactory는 새 주가 되면 한 번 더), 클리블랜드·연준 일정 일주일에 한 번
- 받은 것은 `%APPDATA%\power-chart-and-backtest\`의 `econ_week.json`, `macro.json`, `fomc_dates.json`, `earnings.json`에 보관

## 막힌 곳 (다시 시도하지 말 것)

- **노동통계국 BLS** (`www.bls.gov`, `api.bls.gov`, `bls.ics`): 프로그램 접속은 403 또는 "busy" 페이지
- **FRED** (`fred.stlouisfed.org/graph/fredgraph.csv`): 브라우저처럼 보이는 요청은 끝없이 기다리게 하고, curl·wget 같은 이름만 통과시킨다. **이름을 속여서 들어가지 않기로 했다** → 금리는 뉴욕 연준, CPI는 클리블랜드로 대신
- **Nasdaq 경제 캘린더** (`api.nasdaq.com/api/calendar/economicevents`): 미국 CPI가 없다
- **클리블랜드 연준**: 지난 발표일만 있고 다음 발표일은 없다
- **백악관 OMB PDF를 앱이 자동으로 읽기**: 표가 그림이고 글자는 안 보이는 층에 따로 있으며, 주소가 해마다 바뀐다 → 깨지기 쉬워서 손으로 넣기로 했다
- ForexFactory는 "이번 주"만 준다 (`ff_calendar_nextweek.json`은 404)
