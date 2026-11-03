"""주문선 시험판용 샘플 1분봉 받기 (Binance 주식 무기한선물, 공개 시세, 키 없음, 읽기 전용).

실행: python prototype/fetch_sample.py NVDAUSDT 3
  → prototype/sample_bars.js 에 최근 3일치 1분봉을 window.SAMPLE 로 저장한다.
  (html 파일을 더블클릭으로 열어도 읽히도록 json이 아니라 js로 저장)
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

REST = "https://fapi.binance.com/fapi/v1/klines"
symbol = sys.argv[1] if len(sys.argv) > 1 else "NVDAUSDT"
days = float(sys.argv[2]) if len(sys.argv) > 2 else 3

end = int(time.time() * 1000)
start = end - int(days * 86400_000)
rows = []
t = start
while t < end:
    url = f"{REST}?symbol={symbol}&interval=1m&startTime={t}&limit=1500"
    with urllib.request.urlopen(url, timeout=30) as r:
        page = json.loads(r.read())
    if not page:
        break
    rows += [[k[0] // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])] for k in page]
    t = page[-1][0] + 60_000
    time.sleep(0.5)  # 분당 무게 2,400 한도 (요청 1번 = 10) → 천천히

# 아직 안 끝난 마지막 봉은 뺀다
now_min = end // 60_000 * 60
rows = [r for r in rows if r[0] < now_min]

out = Path(__file__).resolve().parent / "sample_bars.js"
data = {"symbol": symbol, "tf": "1m", "fetched": time.strftime("%Y-%m-%d %H:%M"), "bars": rows}
out.write_text("// fetch_sample.py가 만든 파일 (Binance 1분봉, [초, 시, 고, 저, 종, 거래량])\nwindow.SAMPLE = " + json.dumps(data, separators=(",", ":")) + ";\n", encoding="utf-8")
print(f"{symbol} {len(rows)}봉 → {out}")
