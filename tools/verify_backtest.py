# 사용법: python tools/verify_backtest.py tools/dev-data/market.db  (또는 %APPDATA%/fake-trading-power-chart/market.db)
# 앱의 web/backtest/engine.js 결과와 센트 단위까지 같은지 비교한다 (SPEC §4.5)
# SPEC §4.5 손계산 검증: 실제 거래가 + 분할 날 수량 조정 + 배당락일 전날 수량 × 실제 배당
import sqlite3, sys, json, datetime as dt
db = sqlite3.connect(sys.argv[1])
def bars(sym):
    return db.execute("select t,c from bars where sym=? and tf='1D' order by t", (sym,)).fetchall()
def events(sym):
    return db.execute("select kind,t,a,b from events where sym=? order by t", (sym,)).fetchall()
def ym(t):
    d = dt.datetime.utcfromtimestamp(t); return (d.year, d.month)
def run(sym, start, end, monthly=100, reinvest=False, krw=False):
    B = bars(sym); E = events(sym)
    splits = {t: a/b for k,t,a,b in E if k=='split' and a>0 and b>0 and a!=b}
    divs = {t: a for k,t,a,b in E if k=='div' and a>0}
    fx = bars('KRW=X') if krw else None
    def fxat(t):
        best=None
        for ft,c in fx:
            if ft<=t: best=c
            else: break
        return best
    rng = [(t,c) for t,c in B if start <= ym(t) <= end]
    first_of_month = {}
    for t,c in rng:
        first_of_month.setdefault(ym(t), t)
    buydays = set(first_of_month.values())
    sh = 0.0; cash = 0.0; principal = 0.0
    started = False
    for t,c in rng:
        if t in buydays: started = True
        if not started: continue
        if t in splits: sh *= splits[t]          # 분할 날 수량 조정 (실제 거래가 기준)
        if t in divs:
            amt = sh * divs[t]
            if reinvest: sh += amt / c
            else: cash += amt
        if t in buydays:
            usd = monthly / fxat(t) if krw else monthly
            sh += usd / c
            principal += monthly
        last = (t, c)
    t, c = last
    value = (sh*c + cash) * (fxat(t) if krw else 1)
    return {"sym": sym, "last": dt.datetime.utcfromtimestamp(t).strftime('%Y-%m-%d'), "principal": round(principal,2), "value": round(value,4), "cash": round(cash,4)}
cases = [
  ("QQQ", (2010,1), (2010,12), 100, False, False),
  ("TQQQ", (2020,10), (2021,3), 100, False, False),
  ("SQQQ", (2024,9), (2025,1), 100, False, False),
  ("QQQ", (2024,1), (2024,12), 100, True, False),
  ("QQQ", (2008,6), (2008,12), 500000, False, True),
]
print(json.dumps([run(*c) for c in cases], ensure_ascii=False, indent=1))
